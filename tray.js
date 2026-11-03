const path = require('path');
const fs = require('fs');
const util = require('util');
const { app, Tray, Menu, shell, nativeImage, clipboard, dialog, screen, BrowserWindow, ipcMain, powerMonitor, Notification } = require('electron');
const moment = require('moment');
const {
    sendHaPush,
    clearHaPhoneAlert,
    isHaDismissRequested,
    acknowledgeHaDismiss,
    isHaPushEnabled,
    setHaPushEnabled,
    subscribeHaStates,
    stopHaSpokenAlert,
    isConfigured: haPushConfigured,
    dismissEntityId,
    pushEntityId,
} = require('./push.js');
const { fixAudio } = require('./audio-fix.js');
const { fixDisplays, isAtDesk } = require('./display-fix.js');
const { createElgatoCameraWatchdog } = require('./camera-fix.js');
const {
    createAudioRouter,
    listCandidateOutputs,
    DEFAULT_AUDIO_PRIORITY,
    normalizePriority,
} = require('./audio-route.js');
const { createConfigStore } = require('./config-store.js');
const { AlertHub } = require('./alert-hub.js');
const { ClickUpWatcher } = require('./clickup.js');
const { CalendarWatchManager } = require('./calendar-watch.js');
const { startWebhookServer } = require('./webhook-server.js');
const {
    CloudflareTunnelManager,
    buildWebhookUrls,
    checkPublicTunnelHealth,
} = require('./cloudflare-tunnel.js');
const log = require('./orbit-log.js');
const { showDesktopNotification: postDesktopNotification, reapStaleNotifiers } = require('./desktop-notify.js');
const { createSoundResolver } = require('./sound-resolver.js');

let tray = null;
let notifier = null;
let flashWindows = null;
let isFlashing = false;
let trayPaths = null;
let logWindow = null;
let settingsWindow = null;
let googleSetupWindow = null;
let configStore = null;
let alertHub = null;
let clickUpWatcher = null;
let calendarWatchManager = null;
let webhookServer = null;
let cloudflareTunnel = null;
let tunnelHealth = { ok: null, error: null, url: '', checkedAt: null, checking: false };
let tunnelHealthTimer = null;
let tunnelHealthInitialTimer = null;
let lastTunnelHealthNotifyOk = null;
let settingsHandlersRegistered = false;

const TUNNEL_HEALTH_INTERVAL_MS = Number(process.env.ORBIT_TUNNEL_HEALTH_INTERVAL_MS) || 5 * 60 * 1000;
const TUNNEL_HEALTH_INITIAL_DELAY_MS = Number(process.env.ORBIT_TUNNEL_HEALTH_INITIAL_DELAY_MS) || 30 * 1000;
let hudWindow = null;
let alertPanelWindow = null;
let isQuitting = false;
let menuIsOpen = false;
let pendingMenuRebuild = false;
let lastTrayTitle = null;
let lastDockBadge = null;
let lastMenuSignature = null;
let dockShown = false;
let hudUserPosition = null;
let alertPanelUserPosition = null;
let suppressPanelMoveSave = false;
/** Camera whose active streaming marks you as "in a call" ('' = disabled). */
let callCameraName = '';
/** Which signals are allowed to mark you "in a call" (drive lights/status). */
let callDetectZoom = true;
let callDetectWeb = true;
let callDetectCamera = true;
let cachedAppMenu = null;
let lastTrayIconKey = null;
let lastConnectionIssuesKey = null;
/** @type {{ id: number, title: string, message: string, url?: string, source: string, at: number }[]} */
const activeAlerts = [];
const MAX_ACTIVE_ALERTS = 8;
let alertIdSeq = 0;
let alertPanelHandlersRegistered = false;
let defaultAlertSoundPath = null;
/** Persistent log of every alert (active + dismissed) for the history view. */
let alertHistory = [];
let alertHistoryPath = null;
let historyWindow = null;
const MAX_ALERT_HISTORY = 1000;
let sawLaunchNotification = false;
const logBuffer = [];

const CALENDAR_COLOR_NAMES = {
    orange: '#ff7846',
    blue: '#4da3ff',
    green: '#7ed957',
    purple: '#c77dff',
    yellow: '#ffd60a',
    pink: '#ff6b9d',
    red: '#ff4444',
    teal: '#2dd4bf',
};

const CALENDAR_COLOR_PALETTE = Object.values(CALENDAR_COLOR_NAMES);

// Screen flash appearance: a soft, warm yellow that's easy on the eyes.
const FLASH_COLOR = '#FFD980';
const FLASH_OPACITY = 0.4;
const alert = { active: false, meeting: null, blinkOn: false, timer: null, nagTimer: null, browserTimer: null, dismissPollTimer: null };
let dismissEntityMissing = false;

// Phone push: away detection + persisted toggle.
let screenLocked = false;
let pushEnabled = true;
/** Latest known state of the HA phone-push helper: true=on, false=off, null=unknown/unconfigured */
let phonePushState = null;
let phonePushPollTimer = null;
let phonePushSubscription = null;
let menuBarTitle = false;
/** 'text' = ● in menu bar (most visible); 'dot' = tiny icon; 'ring' = colorful ring */
let trayIconStyle = 'text';
/** Floating pill under the menu bar — reliable on macOS 26 when Control Center hides the tray */
let showFloatingHud = true;
let settingsPath = null;
let audioAutoRoute = true;
let audioPriority = [...DEFAULT_AUDIO_PRIORITY];
let waveLinkKeepAlive = true;
let elgatoCameraWatchdog = true;
let cameraWatchdog = null;
let audioRouter = null;
let lastAudioRoute = { name: null, error: null, via: null, waveLink: null };

function loadSettings(dataDir) {
    settingsPath = path.join(dataDir, 'settings.json');
    try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (typeof raw.pushEnabled === 'boolean') pushEnabled = raw.pushEnabled;
        if (typeof raw.menuBarTitle === 'boolean') menuBarTitle = raw.menuBarTitle;
        if (typeof raw.showFloatingHud === 'boolean') showFloatingHud = raw.showFloatingHud;
        if (raw.trayIconStyle === 'text' || raw.trayIconStyle === 'dot' || raw.trayIconStyle === 'ring') {
            trayIconStyle = raw.trayIconStyle;
        }
        if (Number.isFinite(raw.hudX) && Number.isFinite(raw.hudY)) {
            hudUserPosition = { x: raw.hudX, y: raw.hudY };
        }
        if (Number.isFinite(raw.alertPanelX) && Number.isFinite(raw.alertPanelY)) {
            alertPanelUserPosition = { x: raw.alertPanelX, y: raw.alertPanelY };
        }
        if (raw.sawLaunchNotification === true) sawLaunchNotification = true;
        if (typeof raw.callCameraName === 'string') callCameraName = raw.callCameraName;
        if (typeof raw.callDetectZoom === 'boolean') callDetectZoom = raw.callDetectZoom;
        if (typeof raw.callDetectWeb === 'boolean') callDetectWeb = raw.callDetectWeb;
        if (typeof raw.callDetectCamera === 'boolean') callDetectCamera = raw.callDetectCamera;
        if (typeof raw.audioAutoRoute === 'boolean') audioAutoRoute = raw.audioAutoRoute;
        if (typeof raw.waveLinkKeepAlive === 'boolean') waveLinkKeepAlive = raw.waveLinkKeepAlive;
        if (typeof raw.elgatoCameraWatchdog === 'boolean') elgatoCameraWatchdog = raw.elgatoCameraWatchdog;
        if (Array.isArray(raw.audioPriority) || typeof raw.audioPriority === 'string') {
            const pri = normalizePriority(raw.audioPriority);
            if (pri.length) audioPriority = pri;
        }
    } catch {
        // first run — defaults apply
    }
}

function getUiSettings() {
    return {
        menuBarTitle,
        trayIconStyle,
        showFloatingHud,
        pushEnabled,
        pushAvailable: haPushConfigured(),
        callCameraName,
        callDetectZoom,
        callDetectWeb,
        callDetectCamera,
        launchAtLogin: app.getLoginItemSettings().openAtLogin,
        audioAutoRoute,
        audioPriority,
        waveLinkKeepAlive,
        elgatoCameraWatchdog,
        audioRouteDevice: lastAudioRoute.name,
        audioRouteError: lastAudioRoute.error,
        audioRouteWarning: lastAudioRoute.warning || null,
        waveLink: audioRouter?.waveLinkStatus() || null,
    };
}

function applyUiSettings(patch = {}) {
    if (patch.menuBarTitle != null) menuBarTitle = Boolean(patch.menuBarTitle);
    if (patch.trayIconStyle === 'text' || patch.trayIconStyle === 'dot' || patch.trayIconStyle === 'ring') {
        trayIconStyle = patch.trayIconStyle;
    }
    if (patch.showFloatingHud != null) showFloatingHud = Boolean(patch.showFloatingHud);
    if (patch.pushEnabled != null) pushEnabled = Boolean(patch.pushEnabled);
    if (patch.callCameraName != null) {
        callCameraName = String(patch.callCameraName);
        lastCameraCheck = 0; // re-check immediately with the new selection
    }
    if (patch.callDetectZoom != null) callDetectZoom = Boolean(patch.callDetectZoom);
    if (patch.callDetectWeb != null) {
        callDetectWeb = Boolean(patch.callDetectWeb);
        lastWebCallCheck = 0;
    }
    if (patch.callDetectCamera != null) {
        callDetectCamera = Boolean(patch.callDetectCamera);
        lastCameraCheck = 0;
    }
    if (notifier) notifier.zoomProcessDetectionEnabled = callDetectZoom;
    if (patch.launchAtLogin != null) {
        app.setLoginItemSettings({
            openAtLogin: Boolean(patch.launchAtLogin),
            openAsHidden: true,
        });
    }
    if (patch.audioAutoRoute != null) audioAutoRoute = Boolean(patch.audioAutoRoute);
    if (patch.waveLinkKeepAlive != null) waveLinkKeepAlive = Boolean(patch.waveLinkKeepAlive);
    if (patch.elgatoCameraWatchdog != null) elgatoCameraWatchdog = Boolean(patch.elgatoCameraWatchdog);
    if (patch.audioPriority != null) {
        const pri = normalizePriority(patch.audioPriority);
        audioPriority = pri.length ? pri : [...DEFAULT_AUDIO_PRIORITY];
    }
    saveSettings();
    lastMenuSignature = null;
    cachedAppMenu = null;
    applyTrayIconStyle();
    updateTrayTitle();
    updateHudWindow();
    if (trayPaths) refreshUI(trayPaths);
    if (audioRouter && (patch.audioAutoRoute != null || patch.audioPriority != null)) {
        if (audioAutoRoute) {
            audioRouter.tick().catch((err) => log.audioError(err.message));
        }
    }
}

function startAudioRouter() {
    if (audioRouter || process.platform !== 'darwin') return;
    audioRouter = createAudioRouter({
        getConfig: () => ({
            enabled: audioAutoRoute,
            priority: audioPriority,
            waveLinkKeepAlive,
        }),
        monitorPath: app.isPackaged
            ? path.join(process.resourcesPath, 'audio-device-monitor')
            : path.join(__dirname, 'bin', 'audio-device-monitor'),
        onLog: (message) => log.audio(message),
        onChange: (result) => {
            lastAudioRoute = {
                name: result.device?.name || null,
                error: result.error || null,
                warning: result.warning || null,
                via: result.via || null,
                waveLink: result.waveLink || null,
            };
            if (result.ok && result.changed) {
                const note = result.via !== 'system' ? '' : result.waveLink === 'unreachable' ? ' (system, Wave Link not responding)' : ' (system, Wave Link off)';
                log.audio(`Main output → ${result.device.name}${note}`);
            } else if (!result.ok && result.error) {
                log.audioWarn(result.error);
            }
            if (result.warning) log.audioWarn(result.warning);
            lastMenuSignature = null;
            if (trayPaths) refreshUI(trayPaths);
        },
        onWaveLinkRestart: ({ ok, reason, error }) => {
            lastMenuSignature = null;
            if (trayPaths) refreshUI(trayPaths);
            postDesktopNotification({
                title: ok ? 'Wave Link restarted' : 'Wave Link restart failed',
                body: ok ? `It had ${reason}. Audio routing restored.` : `${reason}: ${error || 'still not responding'}. Try Diagnostics → Fix Audio.`,
            }).catch(() => {});
        },
    });
    audioRouter.start();
}

function startCameraWatchdog() {
    if (cameraWatchdog || process.platform !== 'darwin') return;
    cameraWatchdog = createElgatoCameraWatchdog({
        getConfig: () => ({ enabled: elgatoCameraWatchdog }),
        onLog: (message) => log.camera(message),
        onRestart: ({ ok, error, manual }) => {
            lastMenuSignature = null;
            if (trayPaths) refreshUI(trayPaths);
            if (!ok) log.cameraWarn(error);
            postDesktopNotification({
                title: ok ? 'Elgato camera restarted' : 'Elgato camera restart failed',
                body: ok
                    ? (manual ? 'Camera Hub restarted.' : 'The virtual camera froze, so Camera Hub was restarted.')
                    : `${error}. Open Camera Hub to check the camera.`,
            }).catch(() => {});
        },
    });
    cameraWatchdog.start();
    if (trayPaths) buildMenu(trayPaths);
}

async function routeAudioNow({ notify = false } = {}) {
    if (!audioRouter) startAudioRouter();
    const result = await audioRouter.applyNow();
    lastAudioRoute = {
        name: result.device?.name || lastAudioRoute.name,
        error: result.error || null,
        warning: result.warning || null,
        via: result.via || lastAudioRoute.via,
        waveLink: result.waveLink || lastAudioRoute.waveLink,
    };
    lastMenuSignature = null;
    if (trayPaths) refreshUI(trayPaths);
    if (!notify) return result;
    if (result.ok) {
        log.audio(`Routed now → ${result.device?.name || '?'}`);
        if (result.waveLink === 'unreachable' && waveLinkKeepAlive) {
            audioRouter.restartWaveLink('not responding').catch((err) => log.audioError(err.message));
        }
    } else {
        log.audioError(result.error || 'Route audio failed');
        dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Route audio failed',
            message: result.error || 'Unknown error',
            detail: result.steps?.length ? result.steps.join('\n') : undefined,
        });
    }
    return result;
}

function saveSettings() {
    if (!settingsPath) return;
    try {
        const data = {
            pushEnabled, menuBarTitle, trayIconStyle, showFloatingHud, sawLaunchNotification,
            callCameraName, callDetectZoom, callDetectWeb, callDetectCamera,
            audioAutoRoute, audioPriority, waveLinkKeepAlive, elgatoCameraWatchdog,
        };
        if (hudUserPosition) {
            data.hudX = hudUserPosition.x;
            data.hudY = hudUserPosition.y;
        }
        if (alertPanelUserPosition) {
            data.alertPanelX = alertPanelUserPosition.x;
            data.alertPanelY = alertPanelUserPosition.y;
        }
        fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Failed to save settings:', err.message);
    }
}

function awayThresholdSeconds() {
    const n = Number(process.env.PUSH_AWAY_THRESHOLD_SECONDS);
    return Number.isFinite(n) && n > 0 ? n : 300;
}

function isAwayFromMac() {
    if (screenLocked) return true;
    try {
        return powerMonitor.getSystemIdleTime() >= awayThresholdSeconds();
    } catch {
        return false;
    }
}

function shouldPushForMeeting(meeting) {
    if (!pushEnabled || !haPushConfigured()) return false;
    if (!isAwayFromMac()) return false;
    if (!meeting) return true;
    const cfg = notifier?.getCalendarConfig?.(meeting._calendarId);
    return cfg?.push !== false;
}

/** Human label for the phone-push indicator shown in the menu bar / HUD. */
function phonePushStatusLabel() {
    if (!haPushConfigured()) return 'Phone alerts: not configured';
    if (phonePushState === false) return 'Phone alerts: Off (from phone)';
    if (phonePushState === true) return 'Phone alerts: On';
    return 'Phone alerts: checking…';
}

/** Compact always-visible menu-bar glyph for phone-push state ('' when unconfigured). */
function phonePushGlyph() {
    if (!haPushConfigured()) return '';
    if (phonePushState === false) return '🔕';
    if (phonePushState === true) return '🔔';
    return '';
}

/** Apply a freshly observed phone-push state and refresh the menu/HUD if changed. */
function applyPhonePushState(next) {
    if (next === phonePushState) return;
    phonePushState = next;
    lastMenuSignature = null;
    lastTrayTitle = null;
    updateTrayTitle();
    if (trayPaths) buildMenu(trayPaths);
    updateHudWindow();
}

/** Poll the HA helper so the menu/HUD reflect the phone-side toggle. */
async function refreshPhonePushState() {
    let next = null;
    if (haPushConfigured()) {
        try { next = await isHaPushEnabled(); } catch { next = null; }
    }
    applyPhonePushState(next);
}

function startPhonePushPolling() {
    if (phonePushPollTimer) return;
    refreshPhonePushState().catch(() => {});
    // Poll as a fallback; the websocket below gives instant updates when connected.
    phonePushPollTimer = setInterval(() => {
        refreshPhonePushState().catch(() => {});
    }, 60 * 1000);
}

/** Phone "dismiss" toggle flipped on → silence the spoken alert + clear any Mac alert. */
async function handlePhoneDismiss() {
    console.log('📱 Dismiss toggle on — silencing phone spoken alert');
    await stopHaSpokenAlert();
    if (alert.active) stopAlert('phone');
    await acknowledgeHaDismiss();
}

/** Live updates from HA over websocket so toggles reflect immediately. */
function startPhonePushSubscription() {
    if (phonePushSubscription || !haPushConfigured()) return;
    const pushId = pushEntityId();
    const dismissId = dismissEntityId();
    phonePushSubscription = subscribeHaStates([pushId, dismissId], (entityId, state) => {
        if (entityId === pushId) {
            applyPhonePushState(state !== 'off');
        } else if (entityId === dismissId && state === 'on') {
            handlePhoneDismiss().catch((err) => console.error('Phone dismiss:', err.message));
        }
    });
}

/** Flip the phone-push helper from the Mac and refresh the indicator. */
async function togglePhonePush() {
    if (!haPushConfigured()) return;
    const target = !(phonePushState === true);
    const ok = await setHaPushEnabled(target);
    if (ok) {
        phonePushState = target;
        lastMenuSignature = null;
        if (trayPaths) buildMenu(trayPaths);
        updateHudWindow();
    } else {
        console.error('📱 Could not change phone push state in Home Assistant');
    }
}

/** True when you've already joined (Zoom active or meeting URL open in a browser). */
async function isAlreadyInMeeting(meeting) {
    if (notifier?.zoomIsRunning) return true;
    const uri = meeting?.videoEntryPoint?.uri;
    if (uri && await isMeetingOpenInBrowser(uri)) return true;
    return false;
}

async function maybePushToPhone({ title, message, urgent = false, meeting }) {
    if (!shouldPushForMeeting(meeting)) return;
    if (await isAlreadyInMeeting(meeting)) {
        console.log('📱 Phone push skipped — already in the meeting');
        return;
    }
    const url = meeting?.videoEntryPoint?.uri;
    await sendHaPush({ title, message, urgent, url });
}

function pushTextForKind(kind, meeting) {
    const name = meeting?.summary || 'Meeting';
    switch (kind) {
        case '5min':
            return { title: 'Meeting in 5 minutes', message: name, urgent: false };
        case '1min':
            return { title: 'Meeting in 1 minute', message: name, urgent: false };
        case 'start':
            return { title: 'Meeting started', message: name, urgent: true };
        case 'nag':
            return { title: 'Meeting started — join now', message: name, urgent: true };
        default:
            return { title: 'Meeting reminder', message: name, urgent: false };
    }
}

function initPresenceTracking() {
    powerMonitor.on('lock-screen', () => { screenLocked = true; });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; });
    powerMonitor.on('suspend', () => { screenLocked = true; });
    powerMonitor.on('resume', () => {
        screenLocked = false;
        if (audioAutoRoute) audioRouter?.tick().catch((err) => log.audioError(err.message));
    });
}

// Browsers we know how to read tabs from. `proc` is the exact process name used
// to detect if it's running (so we never launch a closed browser); `app` is the
// AppleScript application name.
const SUPPORTED_BROWSERS = [
    { proc: 'Google Chrome', app: 'Google Chrome' },
    { proc: 'Arc', app: 'Arc' },
    { proc: 'Microsoft Edge', app: 'Microsoft Edge' },
    { proc: 'Brave Browser', app: 'Brave Browser' },
    { proc: 'Vivaldi', app: 'Vivaldi' },
    { proc: 'Safari', app: 'Safari' },
];

function _isProcRunning(proc) {
    return new Promise((resolve) => {
        require('child_process').execFile('pgrep', ['-x', proc], (err, out) => {
            resolve(!err && !!out.trim());
        });
    });
}

function _browserTabUrls(appName) {
    return new Promise((resolve) => {
        // Same Apple event works for Chromium-family and Safari. Newlines as a
        // delimiter avoid issues with commas in URLs. Timeout so a pending
        // Automation-permission prompt can't hang the app.
        const script =
            `set AppleScript's text item delimiters to linefeed\n` +
            `tell application "${appName}" to get (URL of every tab of every window)`;
        require('child_process').execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            resolve(stdout.split(/[\n,]/).map((s) => s.trim()).filter(Boolean));
        });
    });
}

// Read open tab URLs from running browsers (macOS). Only queries browsers that
// are already running. Requires Automation permission per browser (prompted once).
async function getOpenBrowserUrls() {
    if (process.platform !== 'darwin') return [];
    const all = [];
    for (const b of SUPPORTED_BROWSERS) {
        if (await _isProcRunning(b.proc)) {
            all.push(...(await _browserTabUrls(b.app)));
        }
    }
    return all;
}

function normalizeUrl(u) {
    return String(u).replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

async function isMeetingOpenInBrowser(meetingUrl) {
    const target = normalizeUrl(meetingUrl);
    if (!target || target.length < 8) return false;
    const urls = await getOpenBrowserUrls();
    return urls.some((u) => normalizeUrl(u).includes(target));
}

// URLs that indicate an active browser-based video call. Meet uses a 3-4-3
// letter code in the path (lobby/landing pages have no code); Daily rooms live
// at <team>.daily.co/<room>; Zoom's web client at app.zoom.us/wc.
const WEB_CALL_URL_RE = /(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3})|([a-z0-9-]+\.daily\.co\/[^/\s?#]+)|(daily\.co\/[^/\s?#]+)|(zoom\.us\/wc\/)|(whereby\.com\/[^/\s?#]+)/i;
let webCallState = false;
let lastWebCallCheck = 0;

/** Throttled detector: are we in a browser-based call (Meet/Daily/Zoom-web)? */
async function detectWebCall() {
    if (!callDetectWeb) return false;
    const now = Date.now();
    if (now - lastWebCallCheck < 5000) return webCallState ? 'Browser tab' : false;
    lastWebCallCheck = now;
    try {
        const urls = await getOpenBrowserUrls();
        webCallState = urls.some((u) => WEB_CALL_URL_RE.test(u));
    } catch {
        // keep previous state on failure
    }
    return webCallState ? 'Browser tab' : false;
}

function cameraMonitorPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'camera-monitor')
        : path.join(__dirname, 'bin', 'camera-monitor');
}

/** Run the native CoreMediaIO helper → [{ name, running }]. Empty on failure. */
function listCameraStates() {
    return new Promise((resolve) => {
        const bin = cameraMonitorPath();
        require('child_process').execFile(bin, { timeout: 4000 }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const rows = stdout.split('\n').map((line) => {
                const tab = line.indexOf('\t');
                if (tab < 0) return null;
                return { running: line.slice(0, tab).trim() === '1', name: line.slice(tab + 1).trim() };
            }).filter((r) => r && r.name);
            resolve(rows);
        });
    });
}

let callCameraState = false;
let lastCameraCheck = 0;

/** Throttled detector: is the user-selected meeting camera actively streaming? */
async function detectSelectedCamera() {
    if (!callDetectCamera || !callCameraName) return false;
    const now = Date.now();
    if (now - lastCameraCheck < 4000) return callCameraState ? `Camera: ${callCameraName}` : false;
    lastCameraCheck = now;
    try {
        const cams = await listCameraStates();
        callCameraState = cams.some((c) => c.name === callCameraName && c.running);
    } catch {
        // keep previous state on failure
    }
    return callCameraState ? `Camera: ${callCameraName}` : false;
}

// Mirror all console output into an in-app buffer (and the console window, if
// open) so the app can be run from the Dock without a terminal and still show
// its logs. The original terminal output is preserved.
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function formatLogTime(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatLogArg(a) {
    return typeof a === 'string' ? a : util.inspect(a, { depth: 3, colors: false });
}
function pushLog(level, args) {
    const line = args.map(formatLogArg).join(' ').replace(ANSI_RE, '');
    const stamped = `${formatLogTime()} ${line}`;
    logBuffer.push({ line: stamped, level });
    if (logBuffer.length > 5000) logBuffer.shift();
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('log-line', { line: stamped, level });
    }
}
// A closed stdout pipe (the launching terminal went away) must not crash the app.
const isBrokenPipe = (err) => err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED';
for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (err) => { if (!isBrokenPipe(err)) throw err; });
}
for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        try { original(...args); } catch (err) { if (!isBrokenPipe(err)) throw err; }
        try { pushLog(method === 'info' ? 'log' : method, args); } catch { /* noop */ }
    };
}

function createLogWindow() {
    if (logWindow && !logWindow.isDestroyed()) {
        if (logWindow.isMinimized()) logWindow.restore();
        logWindow.show();
        logWindow.focus();
        return logWindow;
    }
    logWindow = new BrowserWindow({
        width: 780,
        height: 460,
        title: 'Orbit — Console',
        backgroundColor: '#1e1e1e',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    logWindow.loadFile(path.join(__dirname, 'assets', 'log.html'));
    // Closing just hides the window; the app keeps running in the menu bar/Dock.
    logWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            logWindow.hide();
        }
    });
    return logWindow;
}


function createAlertHistoryWindow() {
    if (historyWindow && !historyWindow.isDestroyed()) {
        if (historyWindow.isMinimized()) historyWindow.restore();
        historyWindow.show();
        historyWindow.focus();
        sendHistoryUpdate();
        return historyWindow;
    }
    historyWindow = new BrowserWindow({
        width: 760,
        height: 560,
        title: 'Orbit — Alert History',
        backgroundColor: '#1e1e1e',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    historyWindow.loadFile(path.join(__dirname, 'assets', 'alert-history.html'));
    historyWindow.webContents.on('did-finish-load', () => sendHistoryUpdate());
    historyWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            historyWindow.hide();
        }
    });
    return historyWindow;
}


function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        if (settingsWindow.isMinimized()) settingsWindow.restore();
        settingsWindow.show();
        settingsWindow.focus();
        settingsWindow.webContents.send('settings:refresh');
        return settingsWindow;
    }
    settingsWindow = new BrowserWindow({
        width: 920,
        height: 640,
        title: 'Orbit — Settings',
        backgroundColor: '#1e1e1e',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWindow.loadFile(path.join(__dirname, 'assets', 'settings.html'));
    settingsWindow.on('close', (e) => {
        if (isQuitting) return;
        e.preventDefault();
        if (settingsWindow.webContents.isLoading()) {
            settingsWindow.hide();
            return;
        }
        settingsWindow.webContents.send('settings:request-close');
    });
    return settingsWindow;
}


function createGoogleSetupWindow() {
    if (googleSetupWindow && !googleSetupWindow.isDestroyed()) {
        if (googleSetupWindow.isMinimized()) googleSetupWindow.restore();
        googleSetupWindow.show();
        googleSetupWindow.focus();
        return googleSetupWindow;
    }
    googleSetupWindow = new BrowserWindow({
        width: 560,
        height: 520,
        title: 'Orbit — Google Cloud Setup',
        backgroundColor: '#1e1e1e',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    googleSetupWindow.loadFile(path.join(__dirname, 'assets', 'google-setup.html'));
    googleSetupWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            googleSetupWindow.hide();
        }
    });
    return googleSetupWindow;
}


function restartClickUpWatcher() {
    if (!clickUpWatcher || !configStore) return;
    clickUpWatcher.restart();
    setupClickUpWebhooks().catch((err) => console.error('ClickUp webhook setup:', err.message));
    clickUpWatcher.warmMemberCache?.()
        .then(() => {
            lastMenuSignature = null;
            if (trayPaths) refreshUI(trayPaths);
        })
        .catch(() => {});
}

function buildClickUpTestMenuItems() {
    if (!clickUpWatcher) return [];
    const cu = configStore?.getSection('clickup');
    if (!cu?.rules?.enabled) {
        return [{ label: 'Test ClickUp alert (disabled)', enabled: false }];
    }
    const people = clickUpWatcher.getWatchedPeopleLabels();
    if (!people.length) {
        return [{ label: 'Test ClickUp alert (no watched people)', enabled: false }];
    }
    return people.map((person) => ({
        label: `Test ClickUp alert (${person.label})`,
        click: () => {
            clickUpWatcher.testWatchedPersonAlert(person.id)
                .then(({ name, channelName }) => {
                    console.log(`🧪 ClickUp test — ${name} in #${channelName}`);
                })
                .catch((err) => console.error('ClickUp test alert:', err.message));
        },
    }));
}

async function setupClickUpWebhooks() {
    if (!configStore || !clickUpWatcher) return;
    await ensureWebhookServer();
    await autoRegisterClickUpWebhooks();
}

async function ensureWebhookServer() {
    const tunnel = configStore?.getSection('tunnel');
    const port = Number(tunnel?.localPort) || Number(process.env.ORBIT_WEBHOOK_PORT) || 3921;
    if (webhookServer) return webhookServer;
    try {
        webhookServer = await startWebhookServer({
            port,
            onGoogleCalendarPush: (headers, body) => {
                calendarWatchManager?.handlePush(headers, body);
            },
            onClickUpWebhook: (payload) => clickUpWatcher?.handleWebhook?.(payload),
        });
        return webhookServer;
    } catch (err) {
        log.webhookWarn(`Server failed to start: ${err.message}`);
        return null;
    }
}

function syncTunnelWebhookUrls() {
    if (!configStore) return null;
    const tunnel = configStore.getSection('tunnel');
    if (!tunnel.rules?.enabled || !tunnel.hostname) return null;

    const urls = buildWebhookUrls(tunnel.hostname);
    if (tunnel.rules.autoUpdateWebhookUrls === false) return urls;

    const curGoogle = configStore.getSection('google').googleRules;
    const curClickup = configStore.getSection('clickup').rules;

    configStore.saveSection('google', {
        pushWebhookUrl: urls.googleCalendar,
        pushEnabled: true,
    });
    configStore.saveSection('clickup', {
        rules: {
            ...curClickup,
            webhookUrl: urls.clickup,
            ...(urls.clickup !== curClickup.webhookUrl
                ? { webhookId: null, webhookSecret: '' }
                : {}),
        },
    });
    configStore.reloadIntoProcess();
    return urls;
}

async function autoRegisterClickUpWebhooks() {
    if (!configStore || !clickUpWatcher) return;

    const tunnel = configStore.getSection('tunnel');
    if (!tunnel.rules?.enabled || !tunnel.hostname || tunnel.rules.autoUpdateWebhookUrls === false) return;

    const section = configStore.getSection('clickup');
    const rules = section.rules || {};
    if (!rules.enabled || !String(section.apiToken || '').trim()) return;

    const endpoint = rules.webhookUrl || buildWebhookUrls(tunnel.hostname).clickup;
    if (!endpoint.startsWith('https://')) return;
    if (rules.webhookSecret && rules.webhookUrl === endpoint) return;

    if (!(await ensureWebhookServer())) return;

    try {
        await clickUpWatcher.registerWebhooks(endpoint);
        log.clickup(`Webhooks auto-registered via tunnel → ${endpoint}`);
    } catch (err) {
        log.clickupError(`Webhook auto-register failed: ${err.message}`);
    }
}

async function applyTunnelWebhookHooks() {
    const urls = syncTunnelWebhookUrls();
    if (!urls) return null;

    const tunnel = configStore.getSection('tunnel');
    if (tunnel.rules.autoUpdateWebhookUrls === false) return urls;

    log.tunnel('Webhooks auto-configured');
    log.tunnel(`  Google → ${urls.googleCalendar}`);
    log.tunnel(`  ClickUp → ${urls.clickup}`);

    await setupCalendarPush();
    await autoRegisterClickUpWebhooks();
    syncConnectionStatusUI();

    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('settings:refresh');
    }
    return urls;
}

function stopTunnelHealthMonitor() {
    if (tunnelHealthTimer) {
        clearInterval(tunnelHealthTimer);
        tunnelHealthTimer = null;
    }
    if (tunnelHealthInitialTimer) {
        clearTimeout(tunnelHealthInitialTimer);
        tunnelHealthInitialTimer = null;
    }
}

function resetTunnelHealth() {
    tunnelHealth = { ok: null, error: null, url: '', checkedAt: null, checking: false };
    lastTunnelHealthNotifyOk = null;
}

function tunnelHealthSnapshot() {
    return {
        ok: tunnelHealth.ok,
        error: tunnelHealth.error,
        url: tunnelHealth.url,
        checkedAt: tunnelHealth.checkedAt,
        checking: tunnelHealth.checking,
    };
}

/** Active connectivity / auth problems that block fetch or webhook delivery. */
function collectConnectionIssues() {
    const issues = [];
    if (!configStore) return issues;

    const status = notifier?.status;
    if (status === 'misconfigured') {
        issues.push({ id: 'google-env', label: 'Google', detail: 'Missing credentials in .env' });
    } else if (status === 'unauthenticated') {
        issues.push({ id: 'google-auth', label: 'Google Calendar', detail: 'Not authenticated' });
    } else if (status === 'authenticating') {
        issues.push({ id: 'google-auth', label: 'Google Calendar', detail: 'Waiting for sign-in' });
    } else if (status === 'error' && notifier?.lastError) {
        issues.push({
            id: 'google-error',
            label: 'Google Calendar',
            detail: truncate(notifier.lastError.message, 60),
        });
    }

    const google = configStore.getSection('google');
    if (status === 'running') {
        for (const acct of Object.values(google.accounts || {})) {
            if (acct.enabled === false) continue;
            if (!acct.connected) {
                issues.push({
                    id: `google-${acct.id}`,
                    label: `Google (${acct.label || acct.id})`,
                    detail: 'Account not connected',
                });
            }
        }
    }
    if (google.pushEnabled && !String(google.pushWebhookUrl || '').trim()) {
        issues.push({
            id: 'google-push-url',
            label: 'Calendar webhooks',
            detail: 'Push enabled but no public URL',
        });
    }

    const tunnel = configStore.getSection('tunnel');
    if (tunnel.rules?.enabled) {
        if (!String(tunnel.token || '').trim()) {
            issues.push({ id: 'tunnel-token', label: 'Tunnel', detail: 'No tunnel token configured' });
        } else {
            const rt = cloudflareTunnel?.getStatus();
            if (rt?.status !== 'starting' && !rt?.running) {
                issues.push({
                    id: 'tunnel-process',
                    label: 'Tunnel',
                    detail: rt?.lastError || 'Tunnel process not running',
                });
            } else if (tunnelHealth.ok === false) {
                issues.push({
                    id: 'tunnel-health',
                    label: 'Tunnel',
                    detail: tunnelHealth.error || 'Public health check failed',
                });
            }
        }
    }

    const clickup = configStore.getSection('clickup');
    const cuRules = clickup.rules || {};
    if (cuRules.enabled) {
        if (!String(clickup.apiToken || '').trim()) {
            issues.push({ id: 'clickup-token', label: 'ClickUp', detail: 'API token not set' });
        }
        const wantsTaskWebhooks = tunnel.rules?.enabled && tunnel.rules?.autoUpdateWebhookUrls !== false;
        if (wantsTaskWebhooks && String(cuRules.webhookUrl || '').trim() && !String(cuRules.webhookSecret || '').trim()) {
            issues.push({
                id: 'clickup-webhook',
                label: 'ClickUp webhooks',
                detail: 'Task webhooks not registered with ClickUp',
            });
        }
    }

    return issues;
}

function hasConnectionIssues() {
    return collectConnectionIssues().length > 0;
}

function connectionIssuesKey() {
    return collectConnectionIssues().map((i) => `${i.id}:${i.detail}`).join('|');
}

/** Rebuild menu bar icon + dropdown when connectivity/auth issues change. */
function syncConnectionStatusUI() {
    const key = connectionIssuesKey();
    if (key === lastConnectionIssuesKey) return false;
    lastConnectionIssuesKey = key;
    lastMenuSignature = null;
    cachedAppMenu = null;
    lastTrayIconKey = null;
    if (trayPaths) refreshUI(trayPaths);
    return true;
}

function applyTunnelHealthResult(result, { notify = true } = {}) {
    const prevOk = tunnelHealth.ok;
    const prevError = tunnelHealth.error;
    tunnelHealth = {
        ok: result.ok,
        error: result.error || null,
        url: result.url || '',
        checkedAt: result.checkedAt || Date.now(),
        checking: false,
    };

    const changed = prevOk !== tunnelHealth.ok
        || (tunnelHealth.ok === false && result.error !== prevError);
    if (changed) {
        lastMenuSignature = null;
        if (trayPaths) refreshUI(trayPaths);
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('settings:refresh');
        }
    }

    if (!notify) return;

    if (tunnelHealth.ok === false && lastTunnelHealthNotifyOk !== false) {
        lastTunnelHealthNotifyOk = false;
        showUserAlert({
            title: 'Orbit — Tunnel unreachable',
            body: tunnelHealth.error || 'Public health check failed',
            source: 'tunnel',
            record: true,
        });
        log.tunnelWarn(`Public health check failed: ${tunnelHealth.error}`);
    } else if (tunnelHealth.ok === true && lastTunnelHealthNotifyOk === false) {
        lastTunnelHealthNotifyOk = true;
        log.tunnel('Public health check recovered');
        applyTunnelWebhookHooks().catch((err) => console.error('Tunnel webhooks:', err.message));
    } else if (tunnelHealth.ok === true) {
        lastTunnelHealthNotifyOk = true;
    }
}

async function runTunnelHealthCheck({ notify = true } = {}) {
    if (!configStore) return tunnelHealthSnapshot();

    const tunnel = configStore.getSection('tunnel');
    if (!tunnel.rules?.enabled) {
        stopTunnelHealthMonitor();
        resetTunnelHealth();
        lastMenuSignature = null;
        if (trayPaths) refreshUI(trayPaths);
        return tunnelHealthSnapshot();
    }

    const hostname = tunnel.hostname || tunnel.rules?.hostname;
    if (!hostname) {
        applyTunnelHealthResult({
            ok: null,
            error: null,
            url: '',
            checkedAt: Date.now(),
        }, { notify: false });
        return tunnelHealthSnapshot();
    }

    tunnelHealth.checking = true;
    log.tunnel(`Running public health check for ${hostname}…`);
    const runtime = cloudflareTunnel?.getStatus();
    if (!runtime?.running) {
        applyTunnelHealthResult({
            ok: false,
            error: runtime?.lastError || 'Tunnel process not running',
            url: buildWebhookUrls(hostname).health,
            checkedAt: Date.now(),
        }, { notify });
        return tunnelHealthSnapshot();
    }

    const result = await checkPublicTunnelHealth(hostname);
    if (result.ok) log.tunnel(`Public health OK → ${result.url}`);
    else log.tunnelWarn(`Public health failed → ${result.url}: ${result.error}`);
    applyTunnelHealthResult({
        ...result,
        checkedAt: result.checkedAt || Date.now(),
    }, { notify });
    return tunnelHealthSnapshot();
}

function startTunnelHealthMonitor() {
    stopTunnelHealthMonitor();
    const tunnel = configStore?.getSection('tunnel');
    if (!tunnel?.rules?.enabled) return;

    tunnelHealthInitialTimer = setTimeout(() => {
        runTunnelHealthCheck().catch((err) => console.error('Tunnel health check:', err.message));
        tunnelHealthTimer = setInterval(() => {
            runTunnelHealthCheck().catch((err) => console.error('Tunnel health check:', err.message));
        }, TUNNEL_HEALTH_INTERVAL_MS);
    }, TUNNEL_HEALTH_INITIAL_DELAY_MS);
}

function stopCloudflareTunnel() {
    stopTunnelHealthMonitor();
    if (cloudflareTunnel) {
        log.tunnel('Stopping Cloudflare tunnel…');
        cloudflareTunnel.stop();
    }
}

async function startCloudflareTunnel() {
    if (!configStore) return null;
    const tunnel = configStore.getSection('tunnel');
    if (!tunnel.rules?.enabled) {
        stopCloudflareTunnel();
        resetTunnelHealth();
        return null;
    }
    await ensureWebhookServer();
    await applyTunnelWebhookHooks();

    if (!tunnel.token) {
        log.tunnelWarn('Tunnel enabled but CLOUDFLARE_TUNNEL_TOKEN is not set');
        startTunnelHealthMonitor();
        return null;
    }

    if (!cloudflareTunnel) cloudflareTunnel = new CloudflareTunnelManager();

    try {
        log.tunnel(`Starting Cloudflare tunnel → ${tunnel.hostname || '(no hostname)'}`);
        const status = await cloudflareTunnel.start({ token: tunnel.token });
        log.tunnel('Tunnel connected');
        const urls = buildWebhookUrls(tunnel.hostname);
        if (urls.health) log.tunnel(`Public health URL: ${urls.health}`);
        startTunnelHealthMonitor();
        return status;
    } catch (err) {
        log.tunnelError(`Tunnel failed to start: ${err.message}`);
        startTunnelHealthMonitor();
        return { status: 'error', lastError: err.message };
    }
}

async function restartCloudflareTunnel() {
    resetTunnelHealth();
    lastMenuSignature = null;
    if (trayPaths) refreshUI(trayPaths);
    stopCloudflareTunnel();
    const result = await startCloudflareTunnel();
    // Re-check soon after restart so hostname / tunnel changes reflect immediately.
    setTimeout(() => {
        runTunnelHealthCheck({ notify: true }).catch((err) => {
            log.tunnelError(`Health check after restart: ${err.message}`);
        });
    }, 2000);
    return result;
}

async function setupCalendarPush() {
    if (!notifier?.calendar || !configStore) return;

    const google = configStore.getSection('google');
    if (!google.pushEnabled || !google.pushWebhookUrl) {
        if (calendarWatchManager) await calendarWatchManager.stop();
        return;
    }

    if (!(await ensureWebhookServer())) return;

    if (!calendarWatchManager) {
        calendarWatchManager = new CalendarWatchManager({
            calendarApi: notifier.calendar,
            dataDir: trayPaths?.dataDir || configStore.configDir,
            onChange: () => notifier.checkForNextMeeting(),
        });
    }

    await calendarWatchManager.start({
        calendarIds: google.calendarIds,
        webhookUrl: google.pushWebhookUrl,
        resolveCalendarApi: (calendarId) => notifier?.resolveCalendarApiFor?.(calendarId),
    });
}

function resolveAlertSoundPath(defaultPath) {
    const custom = process.env.ALERT_SOUND?.trim();
    if (custom) {
        if (fs.existsSync(custom)) return custom;
        console.warn(`Alert sound not found: ${custom} — using default`);
    }
    return defaultPath;
}

function desktopNotificationsEnabled() {
    try {
        const alerts = configStore?.getSection('alerts');
        return alerts?.desktopNotifications === true;
    } catch {
        return false;
    }
}

function floatingAlertBannerEnabled() {
    try {
        const alerts = configStore?.getSection('alerts');
        return alerts?.floatingAlertBanner !== false;
    } catch {
        return true;
    }
}

function openAlertTarget(url, body) {
    if (url) shell.openExternal(url);
    else if (body) clipboard.writeText(body);
}

function dismissAlert(id) {
    const idx = activeAlerts.findIndex((a) => a.id === id);
    if (idx >= 0) activeAlerts.splice(idx, 1);
    markHistoryDismissed([id]);
    updateAlertPanel();
    lastMenuSignature = null;
    if (trayPaths) refreshUI(trayPaths);
}

function dismissAllAlerts() {
    if (!activeAlerts.length) return;
    markHistoryDismissed(activeAlerts.map((a) => a.id));
    activeAlerts.length = 0;
    updateAlertPanel();
    lastMenuSignature = null;
    if (trayPaths) refreshUI(trayPaths);
}

function loadAlertHistory(dataDir) {
    alertHistoryPath = path.join(dataDir, 'alert-history.json');
    try {
        const raw = JSON.parse(fs.readFileSync(alertHistoryPath, 'utf8'));
        if (Array.isArray(raw)) alertHistory = raw;
    } catch {
        alertHistory = [];
    }
}

function saveAlertHistory() {
    if (!alertHistoryPath) return;
    try {
        fs.writeFileSync(alertHistoryPath, JSON.stringify(alertHistory.slice(0, MAX_ALERT_HISTORY), null, 2));
    } catch (err) {
        console.error('Failed to save alert history:', err.message);
    }
}

function recordAlertHistory(item, { urgent = false, groupKey } = {}) {
    const today = new Date().toDateString();
    if (groupKey) {
        const existing = alertHistory.find(
            (h) => h.groupKey === groupKey && new Date(h.at).toDateString() === today,
        );
        if (existing) {
            existing.title = item.title;
            existing.message = item.message;
            existing.url = item.url;
            existing.source = item.source;
            existing.urgent = existing.urgent || Boolean(urgent);
            existing.count = (existing.count || 1) + 1;
            existing.at = item.at;
            existing.dismissedAt = null;
            const idx = alertHistory.indexOf(existing);
            if (idx > 0) {
                alertHistory.splice(idx, 1);
                alertHistory.unshift(existing);
            }
            saveAlertHistory();
            sendHistoryUpdate();
            return;
        }
    }
    alertHistory.unshift({
        id: item.id,
        title: item.title,
        message: item.message,
        url: item.url,
        source: item.source,
        groupKey: groupKey || null,
        count: 1,
        urgent: Boolean(urgent),
        at: item.at,
        dismissedAt: null,
    });
    if (alertHistory.length > MAX_ALERT_HISTORY) alertHistory.length = MAX_ALERT_HISTORY;
    saveAlertHistory();
    sendHistoryUpdate();
}

function markHistoryDismissed(ids) {
    const set = new Set(ids);
    let changed = false;
    const now = Date.now();
    for (const h of alertHistory) {
        if (set.has(h.id) && !h.dismissedAt) {
            h.dismissedAt = now;
            changed = true;
        }
    }
    if (changed) {
        saveAlertHistory();
        sendHistoryUpdate();
    }
}

function sendHistoryUpdate() {
    if (historyWindow && !historyWindow.isDestroyed()) {
        historyWindow.webContents.send('alert-history:update', alertHistory);
    }
}

function pushAlert({ title, message, url, source, urgent, groupKey }) {
    // Merge alerts that share a group (e.g. all reminders for one meeting) into a
    // single, updating entry with a count instead of stacking duplicates.
    if (groupKey) {
        const existing = activeAlerts.find((a) => a.groupKey === groupKey);
        if (existing) {
            existing.title = title || existing.title;
            existing.message = message || existing.message;
            existing.url = url || existing.url;
            existing.source = source || existing.source;
            existing.at = Date.now();
            existing.count = (existing.count || 1) + 1;
            const idx = activeAlerts.indexOf(existing);
            if (idx > 0) {
                activeAlerts.splice(idx, 1);
                activeAlerts.unshift(existing);
            }
            recordAlertHistory(existing, { urgent, groupKey });
            updateAlertPanel();
            lastMenuSignature = null;
            if (trayPaths) refreshUI(trayPaths);
            return existing;
        }
    }

    const item = {
        id: ++alertIdSeq,
        title: title || 'Orbit',
        message: message || '',
        url: url || '',
        source: source || 'orbit',
        groupKey: groupKey || null,
        count: 1,
        at: Date.now(),
    };
    activeAlerts.unshift(item);
    if (activeAlerts.length > MAX_ACTIVE_ALERTS) activeAlerts.length = MAX_ACTIVE_ALERTS;
    recordAlertHistory(item, { urgent, groupKey });
    updateAlertPanel();
    lastMenuSignature = null;
    if (trayPaths) refreshUI(trayPaths);
    return item;
}

function setPanelPosition(x, y) {
    // Wrap programmatic moves so the 'moved' handler doesn't mistake them for the
    // user dragging the panel (which would overwrite their saved position).
    suppressPanelMoveSave = true;
    alertPanelWindow.setPosition(Math.round(x), Math.round(y));
    setTimeout(() => { suppressPanelMoveSave = false; }, 60);
}

function positionAlertPanelWindow() {
    if (!alertPanelWindow || alertPanelWindow.isDestroyed()) return;
    const { workArea } = getOverlayDisplay();
    const [w] = alertPanelWindow.getSize();

    // Respect a user-dragged position; only keep it on-screen.
    if (alertPanelUserPosition) {
        const x = Math.min(
            Math.max(alertPanelUserPosition.x, workArea.x),
            workArea.x + workArea.width - w,
        );
        const y = Math.min(
            Math.max(alertPanelUserPosition.y, workArea.y),
            workArea.y + workArea.height - 40,
        );
        setPanelPosition(x, y);
        return;
    }

    let x = workArea.x + workArea.width - w - 14;
    let y = workArea.y + 40;
    if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) {
        const [hx, hy] = hudWindow.getPosition();
        const [, hh] = hudWindow.getSize();
        x = Math.min(hx, workArea.x + workArea.width - w - 14);
        y = hy + hh + 6;
    }
    setPanelPosition(x, y);
}

function createAlertPanelWindow() {
    if (!floatingAlertBannerEnabled()) return;
    if (alertPanelWindow && !alertPanelWindow.isDestroyed()) return;

    alertPanelWindow = new BrowserWindow({
        width: 360,
        height: 120,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        hasShadow: false,
        fullscreenable: false,
        show: false,
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    applyFloatingOverlayBehavior(alertPanelWindow);
    alertPanelWindow.loadFile(path.join(__dirname, 'assets', 'alert-panel.html'));
    alertPanelWindow.webContents.on('did-finish-load', () => updateAlertPanel());
    alertPanelWindow.on('moved', () => {
        if (suppressPanelMoveSave || !alertPanelWindow || alertPanelWindow.isDestroyed()) return;
        const [x, y] = alertPanelWindow.getPosition();
        alertPanelUserPosition = { x, y };
        saveSettings();
    });
    alertPanelWindow.on('closed', () => {
        alertPanelWindow = null;
    });
}

function updateAlertPanel() {
    if (!floatingAlertBannerEnabled()) {
        if (alertPanelWindow && !alertPanelWindow.isDestroyed()) alertPanelWindow.hide();
        return;
    }
    createAlertPanelWindow();
    if (!alertPanelWindow || alertPanelWindow.isDestroyed()) return;

    if (!activeAlerts.length) {
        alertPanelWindow.hide();
        return;
    }

    applyFloatingOverlayBehavior(alertPanelWindow);
    alertPanelWindow.webContents.send('alert-panel:update', activeAlerts);
    positionAlertPanelWindow();
    if (!alertPanelWindow.isVisible()) alertPanelWindow.showInactive();
}

function registerAlertPanelHandlers() {
    if (alertPanelHandlersRegistered) return;
    alertPanelHandlersRegistered = true;

    ipcMain.on('alert-panel:dismiss', (_e, id) => dismissAlert(Number(id)));
    ipcMain.on('alert-panel:dismiss-all', () => dismissAllAlerts());
    ipcMain.on('alert-panel:open', (_e, id) => {
        const item = activeAlerts.find((a) => a.id === Number(id));
        if (item) openAlertTarget(item.url, item.message);
    });
    ipcMain.on('alert-panel:resize', (_e, width, height) => {
        if (!alertPanelWindow || alertPanelWindow.isDestroyed()) return;
        alertPanelWindow.setSize(Math.round(width), Math.round(height));
        positionAlertPanelWindow();
    });
    ipcMain.handle('alert-panel:get', () => activeAlerts);

    ipcMain.handle('cameras:list', () => listCameraStates());

    ipcMain.handle('alert-history:get', () => alertHistory);
    ipcMain.on('alert-history:open-item', (_e, url, message) => openAlertTarget(url, message));
    ipcMain.on('alert-history:clear', () => {
        alertHistory = [];
        saveAlertHistory();
        sendHistoryUpdate();
    });
}

function showUserAlert({ title, body, url, source, urgent = false, groupKey, record = true, forceSystem = false }) {
    if (record) pushAlert({ title, message: body, url, source, urgent, groupKey });
    else updateAlertPanel();

    if (!forceSystem && !desktopNotificationsEnabled()) return;

    postDesktopNotification({
        title: title || 'Orbit',
        body: body || '',
        subtitle: source && source !== 'test' ? String(source) : '',
        open: url || undefined,
        onClick: url ? undefined : () => openAlertTarget(url, body),
    }).catch((err) => {
        log.orbitError(`System notification failed: ${err.message}`);
    });
}

function applySettingsRestart(flags) {
    if (!flags || !notifier) return;
    if (flags.lights && notifier.reinitializeLights) notifier.reinitializeLights();
    if (flags.sound && notifier.reinitializeSound) notifier.reinitializeSound();
    if (flags.calendar) {
        if (notifier.restartMeetingPoll) notifier.restartMeetingPoll();
        if (notifier.reloadCalendarAuth) notifier.reloadCalendarAuth();
        setupCalendarPush().catch((err) => console.error('Calendar push setup:', err.message));
    }
    if (flags.clickup) restartClickUpWatcher();
    if (flags.tunnel) restartCloudflareTunnel().catch((err) => console.error('Tunnel restart:', err.message));
}

function registerSettingsHandlers() {
    if (!configStore || settingsHandlersRegistered) return;
    settingsHandlersRegistered = true;

    ipcMain.on('settings:dirty-state', () => {
        // Reserved for future menu-bar indicator.
    });

    ipcMain.on('settings:close-allowed', () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.hide();
        }
    });

    ipcMain.handle('settings:confirm-close', async (_e, { sections } = {}) => {
        if (!settingsWindow || settingsWindow.isDestroyed()) return 'cancel';
        const { response } = await dialog.showMessageBox(settingsWindow, {
            type: 'warning',
            title: 'Unsaved changes',
            message: 'Save changes before closing?',
            detail: sections
                ? `Unsaved settings in: ${sections}`
                : 'You have unsaved settings changes.',
            buttons: ['Save', "Don't Save", 'Cancel'],
            defaultId: 0,
            cancelId: 2,
        });
        if (response === 0) return 'save';
        if (response === 1) return 'discard';
        return 'cancel';
    });

    ipcMain.handle('settings:get', () => {
        configStore.syncEnvFromSources();
        const all = configStore.getAll();
        all.tunnel = {
            ...all.tunnel,
            runtime: {
                ...(cloudflareTunnel?.getStatus() || { status: 'stopped', running: false }),
                publicHealth: tunnelHealthSnapshot(),
            },
        };
        all.ui = getUiSettings();
        return all;
    });

    ipcMain.handle('settings:save', async (_e, { section, patch }) => {
        try {
            if (section === 'ui') {
                applyUiSettings(patch);
                return { ok: true, restart: {} };
            }
            if (section === 'tunnel') {
                resetTunnelHealth();
                lastMenuSignature = null;
            }
            const { restart } = configStore.saveSection(section, patch);
            configStore.reloadIntoProcess();
            applySettingsRestart(restart);
            if (section === 'clickup') restartClickUpWatcher();
            if (section === 'alerts') updateAlertPanel();
            if (section === 'tunnel' && !restart.tunnel) {
                runTunnelHealthCheck({ notify: true }).catch((err) => {
                    log.tunnelError(`Health check after save: ${err.message}`);
                });
            }
            return { ok: true, restart };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('settings:list-calendars', async () => {
        if (!notifier?.listCalendars) return [];
        return notifier.listCalendars();
    });

    ipcMain.handle('settings:pick-sound-file', async () => {
        const win = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            title: 'Choose alert sound',
            filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'aiff', 'aif', 'm4a', 'caf', 'aac'] }],
            properties: ['openFile'],
        });
        if (canceled || !filePaths?.[0]) return { ok: false };
        return { ok: true, path: filePaths[0] };
    });

    ipcMain.handle('settings:clickup-browse', async (_e, { kind, search, page, credentials } = {}) => {
        if (!clickUpWatcher) return { ok: false, error: 'ClickUp watcher not initialized' };
        try {
            const creds = credentials || {};
            if (kind === 'members') {
                const result = await clickUpWatcher.browseMembers({
                    search: search || '',
                    env: creds.env,
                    apiToken: creds.apiToken,
                    workspaceId: creds.workspaceId,
                });
                return { ok: true, items: result.items, hasMore: false };
            }
            if (kind === 'tasks') {
                const result = await clickUpWatcher.browseTasks({
                    search: search || '',
                    page: page || 0,
                    env: creds.env,
                    apiToken: creds.apiToken,
                    workspaceId: creds.workspaceId,
                });
                return { ok: true, items: result.items, hasMore: result.hasMore };
            }
            return { ok: false, error: `Unknown browse kind: ${kind}` };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('settings:test', async (_e, { kind, params }) => {
        try {
            if (kind === 'light-blink' && params?.host) {
                await notifier?.blinkLightAt?.(params.host, 1, 600);
                return { ok: true };
            }
            if (kind === 'lights-discover') {
                if (!notifier?.discoverElgatoLights) return { ok: false, error: 'Discovery not available' };
                const lights = await notifier.discoverElgatoLights({ timeoutMs: params?.timeoutMs || 4000 });
                return { ok: true, lights };
            }
            if (kind === 'alert-sound') {
                if (!notifier?.playAlertSound) return { ok: false, error: 'Sound not available' };
                await notifier.playAlertSound(params?.source || 'meetings');
                return { ok: true };
            }
            if (kind === 'desktop-notification') {
                showUserAlert({
                    title: 'Orbit test alert',
                    body: 'Floating banner test — dismiss with × or open from the list.',
                    source: 'test',
                });
                return { ok: true };
            }
            if (kind === 'push-gentle' || kind === 'push-urgent') {
                const urgent = kind === 'push-urgent';
                const enabled = await isHaPushEnabled();
                const sent = await sendHaPush({
                    title: 'Orbit test',
                    message: `${urgent ? 'Urgent' : 'Gentle'} push from Settings`,
                    urgent,
                });
                return { ok: true, sent, disabled: !enabled };
            }
            if (kind === 'clickup-connection') {
                if (!clickUpWatcher) return { ok: false, error: 'ClickUp watcher not initialized' };
                const info = await clickUpWatcher.testConnection();
                return { ok: true, info };
            }
            if (kind === 'email-classify') {
                const account = params?.account || 'personal';
                const cfg = configStore?.getClaudeConfig?.(account);
                if (!cfg?.apiKey) return { ok: false, error: `No Claude API key for ${account}` };
                return { ok: true, message: `Key configured for ${account} (${cfg.model}) — classifier not implemented yet` };
            }
            if (kind === 'datadog') return { ok: false, error: 'Datadog test not implemented yet' };
            if (kind === 'tunnel-health') {
                const tunnel = configStore.getSection('tunnel');
                const host = params?.hostname || tunnel.hostname;
                const result = await checkPublicTunnelHealth(host);
                if (!result.ok) return { ok: false, error: result.error, url: result.url };
                applyTunnelHealthResult(result, { notify: false });
                return { ok: true, url: result.url, body: result.body };
            }
            return { ok: false, error: `Unknown test: ${kind}` };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('settings:action', async (_e, { action, params = {} }) => {
        try {
            if (action === 'google-connect') {
                if (!notifier) return { ok: false, error: 'Notifier not running' };
                const accountId = params?.accountId || 'primary';
                await notifier.startAuthServer({ accountId });
                return { ok: true };
            }
            if (action === 'google-disconnect') {
                if (!notifier) return { ok: false, error: 'Notifier not running' };
                const accountId = params?.accountId || 'primary';
                notifier.disconnectGoogleAccount(accountId);
                return { ok: true };
            }
            if (action === 'open-help') {
                if (params?.topic === 'google-gcp') {
                    createGoogleSetupWindow();
                    return { ok: true };
                }
                if (trayPaths) {
                    shell.openPath(trayPaths.userData ?? trayPaths.dataDir);
                }
                return { ok: true };
            }
            if (action === 'tunnel-restart') {
                const status = await restartCloudflareTunnel();
                return { ok: true, status: status || cloudflareTunnel?.getStatus() };
            }
            if (action === 'audio-list-outputs') {
                const devices = await listCandidateOutputs();
                return { ok: true, devices };
            }
            if (action === 'audio-route-now') {
                const result = await routeAudioNow({ notify: false });
                return {
                    ok: result.ok,
                    device: result.device?.name,
                    via: result.via,
                    changed: result.changed,
                    error: result.error,
                    steps: result.steps,
                };
            }
            if (action === 'clickup-register-webhook') {
                if (!clickUpWatcher) return { ok: false, error: 'ClickUp watcher not initialized' };
                const section = configStore.getSection('clickup');
                const endpoint = params.endpoint || section.rules?.webhookUrl;
                if (!endpoint) return { ok: false, error: 'Set the public webhook URL first' };
                await ensureWebhookServer();
                const info = await clickUpWatcher.registerWebhooks(endpoint);
                restartClickUpWatcher();
                return { ok: true, info };
            }
            return { ok: false, error: `Unknown action: ${action}` };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
}


ipcMain.on('log-ready', (e) => {
    e.sender.send('log-history', logBuffer);
});

// Kill any leftover/orphaned instances of this app from previous runs (e.g. an
// earlier dev run where only the wrapper was Ctrl-C'd, leaving a live menu bar
// icon behind). We only target processes outside our own process group, so our
// own helper (GPU/renderer) children are never touched. This runs BEFORE the
// single-instance lock so the newest launch always wins and takes over cleanly.
function killLeftoverInstances() {
    if (process.platform === 'win32') return;
    const { execSync } = require('child_process');

    const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

    // A marker that appears in this app's main process command line.
    // Dev: `electron tray.js` (relative), so match the basename.
    // Packaged: the app binary path is the command line.
    const marker = app.isPackaged ? process.execPath : path.basename(__filename);

    let selfPgid = null;
    try {
        selfPgid = parseInt(sh(`ps -o pgid= -p ${process.pid}`), 10);
    } catch {
        return; // can't determine our own group; bail rather than risk self-kill
    }

    const listOrphans = () => {
        let out = '';
        try {
            out = sh(`pgrep -f ${quote(marker)}`);
        } catch {
            return []; // pgrep exits non-zero when nothing matches
        }
        return out
            .split('\n')
            .map((s) => parseInt(s.trim(), 10))
            .filter(Boolean)
            .filter((pid) => {
                if (pid === process.pid) return false;
                let pgid;
                try {
                    pgid = parseInt(sh(`ps -o pgid= -p ${pid}`), 10);
                } catch {
                    return false; // already gone
                }
                return pgid !== selfPgid; // skip our own process tree
            });
    };

    let orphans = listOrphans();
    if (!orphans.length) return;

    console.log(`[startup] cleaning up ${orphans.length} leftover instance(s): ${orphans.join(', ')}`);
    for (const pid of orphans) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
    for (let i = 0; i < 5 && listOrphans().length; i++) {
        try { execSync('sleep 0.3'); } catch { /* noop */ }
    }
    for (const pid of listOrphans()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    try { execSync('sleep 0.3'); } catch { /* noop */ }
}

killLeftoverInstances();

// Only allow one running instance, otherwise relaunching adds a second
// menu bar icon. A duplicate launch exits hard before doing any setup.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.exit(0);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function destroyFlashWindows() {
    if (!flashWindows) return;
    for (const win of flashWindows) {
        if (!win.isDestroyed()) win.destroy();
    }
    flashWindows = null;
}

/** Display the user is most likely looking at (cursor / active fullscreen). */
function getOverlayDisplay() {
    try {
        return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
        return screen.getPrimaryDisplay();
    }
}

/**
 * macOS fullscreen apps use a separate space — windows need screen-saver level
 * and fullscreenable:false (NSWindowCollectionBehaviorFullScreenAuxiliary).
 */
function applyFloatingOverlayBehavior(win) {
    if (!win || win.isDestroyed()) return;
    if (process.platform === 'darwin') {
        win.setFullScreenable(false);
        win.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
        });
        win.setAlwaysOnTop(true, 'screen-saver', 1);
    } else {
        win.setAlwaysOnTop(true, 'floating');
    }
}

// Create one borderless, click-through, always-on-top white window per display.
// Reused across flashes; rebuilt if the monitor layout changes.
function ensureFlashWindows() {
    const displays = screen.getAllDisplays();
    const healthy =
        flashWindows &&
        flashWindows.length === displays.length &&
        flashWindows.every((win) => !win.isDestroyed());
    if (healthy) return flashWindows;

    destroyFlashWindows();

    flashWindows = displays.map((display) => {
        const { x, y, width, height } = display.bounds;
        const win = new BrowserWindow({
            x,
            y,
            width,
            height,
            frame: false,
            transparent: false,
            backgroundColor: FLASH_COLOR,
            alwaysOnTop: true,
            focusable: false,
            skipTaskbar: true,
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            show: false,
            webPreferences: { contextIsolation: true },
        });
        win.setIgnoreMouseEvents(true);
        // 'screen-saver' level + visibleOnFullScreen lets it cover fullscreen Zoom.
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setOpacity(0);
        return win;
    });

    return flashWindows;
}

function showFlash() {
    const wins = ensureFlashWindows();
    for (const win of wins) {
        if (win.isDestroyed()) continue;
        win.setOpacity(FLASH_OPACITY);
        win.showInactive();
    }
}

function hideFlash() {
    if (!flashWindows) return;
    for (const win of flashWindows) {
        if (win.isDestroyed()) continue;
        win.setOpacity(0);
        win.hide();
    }
}

// Standalone flasher for the "Test screen flash" menu item. Live notifications
// instead drive the flash per-pulse via the notifier's blink-on/blink-off events
// so the screen stays in lockstep with the lights and sound.
async function flashScreen(times = 1, duration = 600) {
    if (isFlashing) return;
    isFlashing = true;
    try {
        for (let i = 0; i < times; i++) {
            showFlash();
            await sleep(duration / 2);
            hideFlash();
            if (i < times - 1) await sleep(duration / 2);
        }
    } finally {
        isFlashing = false;
    }
}

const CONFIG_FILE_NAMES = ['.env', 'credentials.json', 'calendars.json', 'settings.json', 'events-log.json'];

/** User config lives here — separate from Electron's default userData (`…/orbit/`). */
function orbitConfigDir() {
    return path.join(app.getPath('appData'), 'com.rjtuit.orbit');
}

function copyMissingConfigFiles(fromDir, toDir) {
    if (!fs.existsSync(fromDir)) return false;
    if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
    let copied = false;
    for (const name of CONFIG_FILE_NAMES) {
        const src = path.join(fromDir, name);
        const dst = path.join(toDir, name);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.copyFileSync(src, dst);
            console.log(`📂 Migrated ${name}: ${fromDir} → ${toDir}`);
            copied = true;
        }
    }
    return copied;
}

function resolveConfigDir() {
    const configDir = orbitConfigDir();
    const legacyDir = path.join(app.getPath('appData'), 'meeting-notifier');
    copyMissingConfigFiles(legacyDir, configDir);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    return configDir;
}

function resolvePaths() {
    let configDir;
    let soundPath;

    if (app.isPackaged) {
        //   ~/Library/Application Support/com.rjtuit.orbit/
        configDir = resolveConfigDir();
        // sounds/ is asarUnpacked so afplay can read a real file path.
        const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'sounds', 'ding.wav');
        soundPath = fs.existsSync(unpacked) ? unpacked : path.join(__dirname, 'sounds', 'ding.wav');
    } else {
        // Dev: use the project folder
        configDir = __dirname;
        soundPath = path.join(__dirname, 'sounds', 'ding.wav');
    }

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    console.log(`📂 Config dir: ${configDir}`);

    defaultAlertSoundPath = soundPath;
    const soundsDir = path.dirname(soundPath);

    return {
        userData: configDir,
        envCandidates: [path.join(configDir, '.env')],
        credentialsPath: path.join(configDir, 'credentials.json'),
        dataDir: configDir,
        soundsDir,
        soundPath: resolveAlertSoundPath(soundPath),
    };
}

function normalizeCalendarColor(color) {
    if (!color || typeof color !== 'string') return null;
    const c = color.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    return CALENDAR_COLOR_NAMES[c.toLowerCase()] || null;
}

function calendarColorForMeeting(meeting) {
    if (!meeting) return CALENDAR_COLOR_PALETTE[0];
    const cfg = notifier?.getCalendarConfig?.(meeting._calendarId);
    const configured = normalizeCalendarColor(cfg?.color);
    if (configured) return configured;
    const id = meeting._calendarId || '';
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return CALENDAR_COLOR_PALETTE[hash % CALENDAR_COLOR_PALETTE.length];
}

function calendarShortName(calendarId) {
    if (!calendarId) return 'Calendar';
    if (calendarId.includes('@')) return calendarId.split('@')[0];
    return truncate(calendarId, 22);
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

const ORBIT_COUNTDOWN_MS = 60 * 60 * 1000;
const ORBIT_OVERDUE_MS = 15 * 60 * 1000;

function createColoredDotImage(hex, size = 16) {
    return createOrbitIconImage(hex, null, size);
}

function createOrbitIconImage(hex, arcFraction, logicalSize = 18, { alert = false, disconnected = false } = {}) {
    const scale = 2;
    const size = logicalSize * scale;
    const [r, g, b] = hexToRgb(hex);
    const buf = Buffer.alloc(size * size * 4);
    const cx = size / 2;
    const cy = size / 2;
    const rOuter = size * 0.42;
    const stroke = Math.max(2.4, size * 0.14);
    const dotR = size * 0.2;
    const circumference = 2 * Math.PI * rOuter;
    const arcLen = arcFraction == null ? 0 : Math.max(0, Math.min(1, arcFraction)) * circumference;
    const showTrack = arcFraction != null && arcFraction < 1;

    const paint = (x, y, pr, pg, pb, a = 255) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const i = (y * size + x) * 4;
        buf[i] = pr;
        buf[i + 1] = pg;
        buf[i + 2] = pb;
        buf[i + 3] = a;
    };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - cx + 0.5;
            const dy = y - cy + 0.5;
            const dist = Math.hypot(dx, dy);

            if (dist <= dotR) {
                paint(x, y, r, g, b);
                continue;
            }

            if (dist < rOuter - stroke || dist > rOuter) continue;

            const angle = Math.atan2(dy, dx);
            const fromTop = (angle + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
            const pos = (fromTop / (2 * Math.PI)) * circumference;

            if (showTrack) {
                paint(x, y, 120, 120, 128, alert ? 90 : 70);
            }
            if (arcFraction != null && pos <= arcLen) {
                paint(x, y, r, g, b);
            }
        }
    }

    if (disconnected) {
        const warnR = size * 0.17;
        const wx = size * 0.8;
        const wy = size * 0.2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (Math.hypot(x - wx + 0.5, y - wy + 0.5) <= warnR) {
                    paint(x, y, 255, 149, 0);
                }
            }
        }
    }

    return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: scale });
}

/** Orbit ring: depletes in the last hour before a meeting; fills red while overdue. */
function orbitVisualState() {
    if (alert.active) {
        const start = alert.meeting?.start?.dateTime ? moment(alert.meeting.start.dateTime) : null;
        const msOver = start ? moment().diff(start) : 0;
        const arc = Math.min(1, Math.max(0, msOver / ORBIT_OVERDUE_MS));
        return {
            color: alert.blinkOn ? '#ff3333' : '#cc4444',
            arc,
            alert: true,
        };
    }

    const meeting = notifier?.nextMeeting;
    const color = calendarColorForMeeting(meeting);
    if (!meeting?.start?.dateTime) return { color, arc: null, alert: false };

    const msUntil = moment(meeting.start.dateTime).diff(moment());
    if (trayIconStyle === 'dot') return { color, arc: null, alert: false };
    if (msUntil > ORBIT_COUNTDOWN_MS) {
        if (trayIconStyle === 'ring') return { color, arc: 1, alert: false };
        return { color, arc: null, alert: false };
    }
    if (msUntil > 0) {
        return { color, arc: msUntil / ORBIT_COUNTDOWN_MS, alert: false };
    }
    return { color, arc: 0, alert: false };
}

function orbitIconCacheKey(state, { disconnected = false } = {}) {
    const prefix = trayIconStyle;
    const dc = disconnected ? '-dc' : '';
    if (state.alert) {
        return `${prefix}-alert-${state.color}-${Math.floor((state.arc ?? 0) * 60)}${dc}`;
    }
    if (state.arc == null) return `${prefix}-dot-${state.color}${dc}`;
    if (state.arc > 1 / 60) return `${prefix}-arc-${state.color}-${Math.floor(state.arc * 60)}${dc}`;
    return `${prefix}-arc-${state.color}-${Math.floor(state.arc * 360)}${dc}`;
}

function trayImageForState() {
    const state = orbitVisualState();
    const disconnected = !state.alert && hasConnectionIssues();
    return createOrbitIconImage(state.color, state.arc, 18, { alert: state.alert, disconnected });
}

function updateTrayIcon() {
    if (!tray || tray.isDestroyed()) return;
    const state = orbitVisualState();
    const disconnected = !state.alert && hasConnectionIssues();
    const iconKey = orbitIconCacheKey(state, { disconnected });
    if (iconKey === lastTrayIconKey) return;
    lastTrayIconKey = iconKey;
    tray.setImage(trayImageForState());
}

// The tray's autosave name on macOS. Without it the item is the generic `Item-0`, which Tahoe
// parked off-screen and whose saved visibility it wiped on every recreate (2026-11-03).
const ORBIT_TRAY_GUID = 'ba9bd70f-7e83-482b-aeb2-5c0058c52594';

/** macOS 26 Tahoe can allow an app in Menu Bar settings but still hide its NSStatusItem off-screen. */
function repairMenuBarVisibility({ restartControlCenter = false } = {}) {
    if (process.platform !== 'darwin' || !app.isPackaged) return;

    const { execSync } = require('child_process');
    const bundleId = require('./package.json').build?.appId || 'com.rjtuit.orbit';

    const names = [ORBIT_TRAY_GUID, ...Array.from({ length: 8 }, (_, i) => `Item-${i}`)];
    for (const name of names) {
        const key = `NSStatusItem VisibleCC ${name}`;
        try {
            const val = execSync(`defaults read ${bundleId} "${key}"`, { encoding: 'utf8' }).trim();
            if (val === '0' || val === 'false') {
                execSync(`defaults delete ${bundleId} "${key}"`);
                console.log(`[menu-bar] cleared hidden default: ${key}`);
            }
        } catch {
            // key absent — fine
        }
    }

    try {
        execSync(`defaults write ${bundleId} "NSStatusItem VisibleCC ${ORBIT_TRAY_GUID}" -bool true`);
    } catch (err) {
        console.warn('[menu-bar] could not write visibility default:', err.message);
    }

    if (restartControlCenter) {
        try {
            execSync('killall ControlCenter');
            console.log('[menu-bar] restarted Control Center');
        } catch {
            // Control Center not running
        }
    }
}

function createTray() {
    const tooltip = tray?.getToolTip?.() || 'Orbit';
    if (tray && !tray.isDestroyed()) {
        tray.destroy();
        tray = null;
    }

    lastTrayIconKey = null;
    tray = new Tray(trayImageForState(), ORBIT_TRAY_GUID);

    tray.setToolTip(tooltip);
    tray.on('click', () => { if (alert.active) stopAlert(); });
    tray.on('right-click', () => { if (alert.active) stopAlert(); });
    if (trayPaths) {
        updateTrayTitle();
        buildMenu(trayPaths);
    }
}

function applyTrayIconStyle() {
    lastTrayIconKey = null;
    updateTrayIcon();
}

/** Destroying the tray during its own menu callback makes macOS 26 drop the status item. */
function recreateTrayDeferred() {
    setTimeout(() => {
        createTray();
        if (app.isPackaged && process.platform === 'darwin') {
            repairMenuBarVisibility({ restartControlCenter: false });
        }
    }, 300);
}

function recreateTray() {
    recreateTrayDeferred();
}

function hudLabelText() {
    const muted = phonePushState === false ? '🔕 ' : '';
    if (alert.active) {
        return `${muted}🔴 ${truncate(alert.meeting?.summary || 'Meeting', 18)}`;
    }
    const meeting = notifier?.nextMeeting;
    if (!meeting) return `${muted}No meetings`;
    const desc = describeNextMeeting(meeting);
    if (!desc) return `${muted}No meetings`;
    return `${muted}${truncate(desc.summary, 16)}  ${formatCountdown(desc.msUntil)}`;
}

function positionHudWindowDefault() {
    if (!hudWindow || hudWindow.isDestroyed()) return;
    const { workArea } = getOverlayDisplay();
    const [w] = hudWindow.getSize();
    hudWindow.setPosition(workArea.x + workArea.width - w - 14, workArea.y + 4);
}

function positionHudWindow() {
    if (!hudWindow || hudWindow.isDestroyed()) return;
    if (hudUserPosition) {
        hudWindow.setPosition(hudUserPosition.x, hudUserPosition.y);
    } else {
        positionHudWindowDefault();
    }
}

function createHudWindow() {
    if (!showFloatingHud) return;
    if (hudWindow && !hudWindow.isDestroyed()) return;

    hudWindow = new BrowserWindow({
        width: 220,
        height: 30,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: false,
        hasShadow: true,
        fullscreenable: false,
        show: false,
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    applyFloatingOverlayBehavior(hudWindow);
    hudWindow.loadFile(path.join(__dirname, 'assets', 'hud.html'));
    hudWindow.webContents.on('context-menu', (e, params) => {
        e.preventDefault();
        showAppMenu({ x: params.x, y: params.y });
    });
    hudWindow.on('moved', () => {
        if (!hudWindow || hudWindow.isDestroyed()) return;
        const [x, y] = hudWindow.getPosition();
        hudUserPosition = { x, y };
        saveSettings();
        if (activeAlerts.length) positionAlertPanelWindow();
    });
    hudWindow.webContents.on('did-finish-load', () => updateHudWindow());
    screen.on('display-metrics-changed', () => {
        if (!hudUserPosition) positionHudWindowDefault();
    });
}

function updateHudWindow() {
    if (!showFloatingHud) {
        if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
        return;
    }
    createHudWindow();
    if (!hudWindow || hudWindow.isDestroyed()) return;

    const text = hudLabelText();
    const alertClass = alert.active ? 'alert' : '';
    const orbit = orbitVisualState();
    const circumference = (2 * Math.PI * 6.2).toFixed(2);
    const dash = orbit.arc == null ? '0' : (orbit.arc * circumference).toFixed(2);
    hudWindow.webContents.executeJavaScript(
        `document.getElementById('text').textContent = ${JSON.stringify(text)};`
        + `document.body.className = ${JSON.stringify(alertClass)};`
        + `document.querySelector('.dot').setAttribute('fill', ${JSON.stringify(orbit.color)});`
        + `document.querySelector('.arc').setAttribute('stroke', ${JSON.stringify(orbit.color)});`
        + `document.querySelector('.arc').setAttribute('stroke-dasharray', ${JSON.stringify(`${dash} ${circumference}`)});`
        + `document.querySelector('.track').style.display = ${JSON.stringify(orbit.arc == null ? 'none' : '')};`
    ).catch(() => {});

    hudWindow.webContents.executeJavaScript(
        `(() => { const w = document.body.scrollWidth + 20; return Math.min(320, Math.max(120, w)); })()`
    ).then((width) => {
        if (!hudWindow || hudWindow.isDestroyed()) return;
        const [x, y] = hudWindow.getPosition();
        hudWindow.setSize(Math.round(width), 30);
        if (hudUserPosition) {
            hudWindow.setPosition(x, y);
        } else if (!hudWindow.isVisible()) {
            positionHudWindowDefault();
        }
        applyFloatingOverlayBehavior(hudWindow);
        if (!hudWindow.isVisible()) hudWindow.showInactive();
    }).catch(() => {
        if (!hudWindow.isDestroyed() && !hudWindow.isVisible()) {
            positionHudWindow();
            applyFloatingOverlayBehavior(hudWindow);
            hudWindow.showInactive();
        }
    });
}

function fixMenuBarVisibility() {
    repairMenuBarVisibility({ restartControlCenter: true });
    setTimeout(() => recreateTrayDeferred(), 1500);
    dialog.showMessageBoxSync({
        type: 'info',
        title: 'Menu bar repair attempted',
        message: 'macOS 26 can hide menu bar icons even when they are enabled in Settings.',
        detail:
            'Orbit restarted Control Center and re-registered its menu bar item.\n\n' +
            'If you still do not see it:\n' +
            '• Use the floating countdown pill (top-right)\n' +
            '• Right-click the Dock icon for the full menu\n' +
            '• Try quitting Ice temporarily — it can conflict on macOS 26\n' +
            '• Toggle Orbit OFF then ON in System Settings → Menu Bar',
        buttons: ['OK'],
    });
}

// Compact countdown: "1h05m", "12m", or "45s".
function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
}

// Unicode bar from a 0..1 fraction.
function makeProgressBar(fraction, segments = 10) {
    const f = Math.max(0, Math.min(1, fraction));
    const filled = Math.round(f * segments);
    return '▰'.repeat(filled) + '▱'.repeat(segments - filled);
}

// Countdown bar shown only in the final minute:
//   > 60s : no bar
//   11-60s: scaled to 60s
//   1-10s : refilled and scaled to the last 10s (one block per second)
function countdownBar(msUntil, segments = 10) {
    const secs = Math.ceil(msUntil / 1000);
    if (secs > 60) return '';
    if (secs > 10) return makeProgressBar(secs / 60, segments);
    if (secs > 0) return makeProgressBar(secs / 10, segments);
    return '';
}

function truncate(str, max) {
    if (str.length <= max) return str;
    return str.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function describeNextMeeting(meeting) {
    if (!meeting) return null;
    const start = moment(meeting.start.dateTime);
    const msUntil = start.diff(moment());
    const time = start.format('h:mm a');
    const summary = meeting.summary || '(no title)';
    const bar = countdownBar(msUntil, 10);

    let label;
    if (msUntil <= 0) {
        label = `${summary} — now`;
    } else {
        label = `${summary} — in ${formatCountdown(msUntil)} (${time})`;
    }
    return { summary, time, msUntil, bar, label };
}

function renderAlertTitle() {
    if (!tray || !alert.active) return;
    const name = truncate(alert.meeting?.summary || 'Meeting', 18);
    let title = '';
    if (menuBarTitle) {
        const dot = alert.blinkOn ? '🔴' : '⚪';
        title = ` ${dot} ${name} STARTED`;
    }
    setTrayTitleIfChanged(title);
    tray.setToolTip(`${alert.meeting?.summary || 'Meeting'} has started — click to dismiss`);
    updateTrayIcon();
    updateHudWindow();
}

function stopDismissPolling() {
    if (alert.dismissPollTimer) clearInterval(alert.dismissPollTimer);
    alert.dismissPollTimer = null;
}

async function startDismissPolling() {
    if (!haPushConfigured() || alert.dismissPollTimer) return;
    const entity = dismissEntityId();
    if (!dismissEntityMissing) {
        const test = await fetch(
            `${process.env.HA_URL.replace(/\/+$/, '')}/api/states/${encodeURIComponent(entity)}`,
            { headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` } },
        ).catch(() => null);
        if (test && test.status === 404) {
            dismissEntityMissing = true;
            console.log(`📱 Phone dismiss unavailable — create ${entity} in Home Assistant (see ha/orbit-dismiss.yaml)`);
            return;
        }
    } else {
        return;
    }
    alert.dismissPollTimer = setInterval(async () => {
        if (!alert.active) return;
        if (!(await isHaDismissRequested())) return;
        console.log('📱 Dismissed from phone — stopping Mac alert');
        await acknowledgeHaDismiss();
        stopAlert('phone');
    }, 3000);
}

async function testMeetingAlert() {
    const meeting = {
        summary: 'Test meeting (Orbit)',
        start: { dateTime: new Date().toISOString() },
    };
    const { title, message, urgent } = pushTextForKind('start', meeting);
    console.log('🧪 Test meeting alert — pulse, then overdue UI (click tray or Dismiss alert to stop)');
    if (alertHub) {
        await alertHub.deliverMeeting({ kind: 'start', meeting, title, message, urgent, quick: true });
    } else if (notifier?.pulseAlert) {
        await notifier.pulseAlert(2, 600, { lights: true, sound: true, flash: true });
    }
    startAlert(meeting);
}

function startAlert(meeting) {
    // (Re)start a blinking red overdue alert for the given meeting.
    alert.active = true;
    alert.meeting = meeting;
    alert.blinkOn = true;
    if (alert.timer) clearInterval(alert.timer);
    renderAlertTitle();
    alert.timer = setInterval(() => {
        alert.blinkOn = !alert.blinkOn;
        renderAlertTitle();
    }, 600);

    // Keep bugging every minute until dismissed. blinkLight() drives sound +
    // lights + screen together via blink-on/blink-off events.
    const nagMs = Number(process.env.ORBIT_NAG_MS || process.env.MN_NAG_MS) || 60 * 1000;
    if (alert.nagTimer) clearInterval(alert.nagTimer);
    alert.nagTimer = setInterval(() => {
        const { title, message, urgent } = pushTextForKind('nag', meeting);
        if (alertHub) {
            alertHub.deliverMeeting({ kind: 'nag', meeting, title, message, urgent }).catch(() => {});
        } else {
            notifier?.blinkLight(2, 600);
            maybePushToPhone({ title, message, urgent, meeting });
        }
    }, nagMs);

    // Auto-dismiss when the meeting link is opened in a browser tab (covers
    // non-Zoom links; Zoom is handled separately via CptHost detection).
    if (alert.browserTimer) clearInterval(alert.browserTimer);
    alert.browserTimer = setInterval(async () => {
        const uri = alert.meeting?.videoEntryPoint?.uri;
        if (!alert.active || !uri) return;
        if (await isMeetingOpenInBrowser(uri)) {
            console.log('✓ Meeting link open in a browser — dismissing alert');
            stopAlert();
        }
    }, 4000);

    startDismissPolling();
    if (trayPaths) buildMenu(trayPaths);
}

function stopAlert(source = 'local') {
    if (!alert.active && !alert.timer && !alert.nagTimer && !alert.browserTimer && !alert.dismissPollTimer) return;
    if (alert.timer) clearInterval(alert.timer);
    if (alert.nagTimer) clearInterval(alert.nagTimer);
    if (alert.browserTimer) clearInterval(alert.browserTimer);
    stopDismissPolling();
    alert.timer = null;
    alert.nagTimer = null;
    alert.browserTimer = null;
    alert.active = false;
    alert.meeting = null;
    clearHaPhoneAlert().catch(() => {});
    updateTrayTitle();
    if (trayPaths) buildMenu(trayPaths);
    if (source === 'phone') console.log('✓ Mac alert silenced');
}

function updateDockBadge() {
    if (process.platform !== 'darwin' || !app.dock) return;

    let badge = '';
    if (alert.active) {
        badge = '!';
    } else {
        const meeting = notifier?.nextMeeting;
        if (meeting) {
            const msUntil = moment(meeting.start.dateTime).diff(moment());
            badge = msUntil <= 0 ? 'now' : formatCountdown(msUntil);
        }
    }

    if (badge === lastDockBadge) return;
    lastDockBadge = badge;
    app.dock.setBadge(badge);
}

function setTrayTitleIfChanged(title) {
    if (!tray || menuIsOpen) return;
    if (title === lastTrayTitle) return;
    lastTrayTitle = title;
    tray.setTitle(title);
}

function updateTrayTitle() {
    syncConnectionStatusUI();
    if (tray) {
        let title = '';
        let tooltip = 'Orbit';

        if (alert.active) {
            const name = truncate(alert.meeting?.summary || 'Meeting', 18);
            if (menuBarTitle) {
                const dot = alert.blinkOn ? '🔴' : '⚪';
                title = ` ${dot} ${name} STARTED`;
            }
            tooltip = `${alert.meeting?.summary || 'Meeting'} has started — click to dismiss`;
        } else {
            const meeting = notifier?.nextMeeting;
            const inMeeting = notifier?.zoomIsRunning;

            if (!meeting) {
                if (menuBarTitle) title = ' No meetings';
                tooltip = inMeeting ? 'In a meeting — no upcoming meetings' : 'Orbit — no upcoming meetings';
            } else {
                const start = moment(meeting.start.dateTime);
                const msUntil = start.diff(moment());
                const summary = meeting.summary || '(no title)';
                const countdown = msUntil <= 0 ? 'now' : formatCountdown(msUntil);
                const bar = countdownBar(msUntil, 10);
                const cal = calendarShortName(meeting._calendarId);

                if (menuBarTitle) {
                    title = ` ${truncate(summary, 18)}  ${countdown}${bar ? ' ' + bar : ''}`;
                }
                tooltip = `Next: ${summary} (${cal}) — ${countdown} (${start.format('h:mm a')})${inMeeting ? ' — in a meeting now' : ''}`;
            }
        }

        const connectionIssues = collectConnectionIssues();
        if (connectionIssues.length && !alert.active) {
            const issueTip = connectionIssues.map((i) => `${i.label}: ${i.detail}`).join(' · ');
            tooltip = tooltip === 'Orbit' ? issueTip : `${issueTip} · ${tooltip}`;
            if (menuBarTitle) {
                const issueLabel = connectionIssues.length === 1
                    ? truncate(connectionIssues[0].detail, 16)
                    : `${connectionIssues.length} disconnected`;
                title = ` ⚠ ${issueLabel}${title}`;
            }
        }

        // Always-visible phone-push indicator, even when the meeting title is hidden.
        const ppGlyph = phonePushGlyph();
        if (ppGlyph) {
            title = title ? `${ppGlyph}${title}` : ` ${ppGlyph}`;
            tooltip = `${tooltip} · Phone alerts ${phonePushState === false ? 'OFF' : 'ON'}`;
        }

        setTrayTitleIfChanged(title);
        tray.setToolTip(tooltip);
        updateTrayIcon();
    }
    updateDockBadge();
    updateHudWindow();
}

function attachMenuLifecycle(menu) {
    menu.on('menu-will-show', () => {
        menuIsOpen = true;
        // Pull the freshest phone-push state so a reopened menu reflects HA on demand.
        refreshPhonePushState().catch(() => {});
    });
    menu.on('menu-will-close', () => {
        menuIsOpen = false;
        if (pendingMenuRebuild && trayPaths) {
            pendingMenuRebuild = false;
            lastMenuSignature = null;
            buildMenu(trayPaths);
        }
        lastTrayTitle = null;
        updateTrayTitle();
    });
}

function menuStructureSignature(paths) {
    const next = notifier?.nextMeeting;
    const current = notifier?.currentMeeting;
    return JSON.stringify({
        alert: alert.active,
        status: notifier?.status,
        err: notifier?.lastError?.message,
        nextId: next?.id,
        nextStart: next?.start?.dateTime,
        nextCal: next?._calendarId,
        nextColor: calendarColorForMeeting(next),
        currentId: current?.id,
        currentStart: current?.start?.dateTime,
        zoom: notifier?.zoomIsRunning,
        callSource: notifier?.callSource,
        authUrl: !!notifier?.authUrl,
        nextLink: !!next?.videoEntryPoint?.uri,
        currentLink: !!current?.videoEntryPoint?.uri,
        lights: notifier?.keyLights?.length ?? 0,
        haPush: haPushConfigured(),
        phonePush: phonePushState,
        login: app.getLoginItemSettings().openAtLogin,
        dataDir: paths?.dataDir,
        tunnelHealth: tunnelHealth.ok,
        tunnelHealthErr: tunnelHealth.error,
        connectionIssues: collectConnectionIssues().map((i) => `${i.id}:${i.detail}`).join('|'),
        audioAutoRoute,
        waveLinkKeepAlive,
        elgatoCameraWatchdog,
        cameraRestarting: cameraWatchdog?.isRestarting() || false,
        audioDevice: lastAudioRoute.name,
        audioErr: lastAudioRoute.error,
        audioWarn: lastAudioRoute.warning,
        waveLink: lastAudioRoute.waveLink,
        waveLinkRestarting: audioRouter?.waveLinkStatus().restarting,
    });
}

function showAppMenu({ x, y } = {}) {
    if (!cachedAppMenu && trayPaths) {
        lastMenuSignature = null;
        buildMenu(trayPaths);
    }
    if (!cachedAppMenu) return;

    const popupOpts = { window: hudWindow ?? logWindow ?? undefined };
    if (Number.isFinite(x) && Number.isFinite(y)) {
        popupOpts.x = Math.round(x);
        popupOpts.y = Math.round(y);
    }
    try {
        cachedAppMenu.popup(popupOpts);
    } catch (err) {
        console.error('Failed to open app menu:', err.message);
    }
}

function applyMenu(menu) {
    cachedAppMenu = menu;
    attachMenuLifecycle(menu);
    if (tray && !tray.isDestroyed()) tray.setContextMenu(menu);
    if (process.platform === 'darwin' && app.dock?.setMenu) {
        app.dock.setMenu(menu);
    }
}

let displayFixRunning = false;

async function runDisplayFix() {
    if (displayFixRunning) return;
    displayFixRunning = true;
    if (trayPaths) buildMenu(trayPaths);
    console.log('🖥 Fix displays — restarting DisplayLink Manager…');
    try {
        const result = await fixDisplays();
        const body = result.error
            ? result.error
            : `${result.displays} of ${result.expected} displays connected`;
        if (result.ok) console.log(`🖥 Fix displays complete: ${body}`);
        else console.error(`🖥 Fix displays: ${body}`);
        postDesktopNotification({
            title: result.ok ? 'Displays fixed' : 'Displays still missing',
            body: result.ok ? body : `${body}. Power-cycle the hub if this persists.`,
        }).catch(() => {});
    } finally {
        displayFixRunning = false;
        if (trayPaths) buildMenu(trayPaths);
    }
}

function buildMenu(paths) {
    if (!tray) return;

    const signature = menuStructureSignature(paths);
    if (signature === lastMenuSignature) return;
    const items = [];
    const meeting = notifier?.nextMeeting;
    const desc = describeNextMeeting(meeting);

    if (alert.active) {
        items.push({
            label: `🔴 ${truncate(alert.meeting?.summary || 'Meeting', 30)} started`,
            enabled: false,
        });
        items.push({ label: 'Dismiss alert', click: () => stopAlert() });
        items.push({ type: 'separator' });
    }

    const connectionIssues = collectConnectionIssues();
    if (connectionIssues.length) {
        for (const issue of connectionIssues) {
            items.push({
                label: `⚠ ${issue.label}: ${truncate(issue.detail, 44)}`,
                enabled: false,
            });
        }
        items.push({ type: 'separator' });
    }

    if (notifier?.status === 'authenticating') {
        items.push({ label: 'Waiting for Google sign-in…', enabled: false });
        if (notifier.authUrl) {
            items.push({
                label: 'Open sign-in page',
                click: () => shell.openExternal(notifier.authUrl),
            });
        }
    } else if (notifier?.status === 'misconfigured') {
        items.push({
            label: 'Missing Google credentials in .env',
            enabled: false,
        });
        items.push({
            label: 'Open config folder',
            click: () => shell.openPath(paths.userData ?? path.dirname(paths.credentialsPath)),
        });
    } else if (notifier?.status === 'unauthenticated') {
        items.push({
            label: 'Not authenticated — see "Open config folder"',
            enabled: false,
        });
    } else if (notifier?.status === 'error' && notifier?.lastError) {
        items.push({
            label: `Error: ${notifier.lastError.message}`.slice(0, 80),
            enabled: false,
        });
    } else if (desc) {
        const calMeeting = notifier?.nextMeeting;
        items.push({
            label: calendarShortName(calMeeting?._calendarId),
            icon: createColoredDotImage(calendarColorForMeeting(calMeeting), 12),
            enabled: false,
        });
        items.push({ label: desc.label, enabled: false });
        if (desc.bar) {
            items.push({ label: `${desc.bar}  ${formatCountdown(desc.msUntil)} left`, enabled: false });
        }
    } else {
        items.push({ label: 'No upcoming meetings', enabled: false });
    }

    items.push({ type: 'separator' });

    const current = notifier?.currentMeeting;
    const next = notifier?.nextMeeting;

    // Show Open/Copy meeting link for both the current (in-progress) and next meeting.
    const addLinkItems = (which, m) => {
        if (!m?.videoEntryPoint?.uri) return;
        const name = truncate(m.summary || 'meeting', 28);
        items.push({ label: `${which}: ${name}`, enabled: false });
        items.push({
            label: `   Open ${which.toLowerCase()} link`,
            click: () => shell.openExternal(m.videoEntryPoint.uri),
        });
        items.push({
            label: `   Copy ${which.toLowerCase()} link`,
            click: () => clipboard.writeText(m.videoEntryPoint.uri),
        });
    };

    if (current?.videoEntryPoint?.uri) addLinkItems('Current meeting', current);
    if (next?.videoEntryPoint?.uri) addLinkItems('Next meeting', next);
    if (!current?.videoEntryPoint?.uri && !next?.videoEntryPoint?.uri) {
        items.push({ label: 'No meeting links available', enabled: false });
    }

    items.push({ type: 'separator' });

    items.push({
        label: notifier?.zoomIsRunning ? `In a call · ${notifier?.callSource || 'detected'}` : 'Not in a call',
        enabled: false,
    });

    const lightCount = notifier?.keyLights?.length ?? 0;
    items.push({
        label: `Elgato lights: ${lightCount}`,
        enabled: false,
    });

    items.push({
        label: `📱 ${phonePushStatusLabel()}`,
        type: haPushConfigured() ? 'checkbox' : 'normal',
        checked: phonePushState === true,
        enabled: haPushConfigured(),
        click: () => togglePhonePush().catch((err) => console.error('Toggle phone push:', err.message)),
    });

    items.push({
        label: 'Auto-route audio',
        type: 'checkbox',
        checked: audioAutoRoute,
        enabled: process.platform === 'darwin',
        click: (item) => applyUiSettings({ audioAutoRoute: item.checked }),
    });
    items.push({
        label: lastAudioRoute.name ? `Route audio now (${lastAudioRoute.name})` : 'Route audio now',
        enabled: process.platform === 'darwin',
        click: () => routeAudioNow({ notify: true }).catch((err) => log.audioError(err.message)),
    });
    items.push({
        label: 'Keep Wave Link running',
        type: 'checkbox',
        checked: waveLinkKeepAlive,
        enabled: process.platform === 'darwin',
        click: (item) => applyUiSettings({ waveLinkKeepAlive: item.checked }),
    });
    const waveState = audioRouter?.waveLinkStatus();
    if (waveState?.restarting) {
        items.push({ label: 'Wave Link restarting…', enabled: false });
    } else if (lastAudioRoute.waveLink === 'unreachable') {
        items.push({
            label: 'Wave Link not responding — restart now',
            click: () => audioRouter?.restartWaveLink('not responding').catch((err) => log.audioError(err.message)),
        });
    }

    items.push({
        label: 'Keep Elgato virtual camera alive',
        type: 'checkbox',
        checked: elgatoCameraWatchdog,
        enabled: process.platform === 'darwin',
        click: (item) => applyUiSettings({ elgatoCameraWatchdog: item.checked }),
    });
    items.push({
        label: cameraWatchdog?.isRestarting() ? 'Restarting Elgato camera…' : 'Fix Elgato camera',
        enabled: process.platform === 'darwin' && !cameraWatchdog?.isRestarting(),
        click: () => {
            if (!cameraWatchdog) startCameraWatchdog();
            cameraWatchdog.restartNow().then(() => trayPaths && buildMenu(trayPaths)).catch((err) => log.cameraWarn(err.message));
            if (trayPaths) buildMenu(trayPaths);
        },
    });

    items.push({
        label: displayFixRunning ? 'Fixing displays…' : 'Fix displays',
        enabled: process.platform === 'darwin' && !displayFixRunning,
        click: () => runDisplayFix(),
    });

    items.push({ type: 'separator' });

    items.push({
        label: 'Refresh now',
        click: () => notifier?.checkForNextMeeting(),
        enabled: notifier?.status === 'running',
    });
    if (activeAlerts.length) {
        items.push({ type: 'separator' });
        items.push({ label: 'Active alerts', enabled: false });
        items.push({ label: 'Dismiss all alerts', click: () => dismissAllAlerts() });
        for (const a of activeAlerts) {
            const age = moment(a.at).fromNow();
            items.push({
                label: truncate(`${a.title} — ${a.message} · ${age}`, 58),
                click: () => {
                    if (a.url) shell.openExternal(a.url);
                    else if (a.message) clipboard.writeText(a.message);
                },
            });
        }
    }

    items.push({
        label: 'Alert history…',
        click: () => createAlertHistoryWindow(),
    });
    if (haPushConfigured()) {
        items.push({
            label: 'Silence phone alarm',
            click: () => stopHaSpokenAlert().catch((err) => console.error('Silence phone alarm:', err.message)),
        });
    }
    items.push({
        label: 'Settings…',
        click: () => createSettingsWindow(),
    });
    items.push({
        label: 'Diagnostics…',
        submenu: [
            {
                label: 'Test blink',
                click: () => notifier?.blinkLight(1, 600),
                enabled: lightCount > 0,
            },
            {
                label: 'Test screen flash',
                click: () => flashScreen(2, 600),
            },
            {
                label: 'Test meeting alert',
                click: () => {
                    testMeetingAlert().catch((err) => console.error('Test meeting alert:', err.message));
                },
            },
            ...buildClickUpTestMenuItems(),
            {
                label: 'Test floating alert banner',
                click: () => {
                    showUserAlert({
                        title: 'Orbit test alert',
                        body: 'This should appear in the floating banner. Click to copy; links open in browser.',
                        source: 'test',
                    });
                },
            },
            {
                label: 'Test ClickUp sound',
                click: () => notifier?.playAlertSound('clickup'),
            },
            {
                label: 'Test meeting sound',
                click: () => notifier?.playAlertSound('meetings'),
            },
            {
                label: 'Fix Audio',
                enabled: process.platform === 'darwin',
                click: async () => {
                    console.log('🔊 Fix Audio — restarting Wave Link and resetting devices…');
                    const result = await fixAudio();
                    for (const step of result.steps) console.log(`  ✓ ${step}`);
                    if (result.ok) {
                        console.log('🔊 Fix Audio complete');
                    } else {
                        console.error('🔊 Fix Audio failed:', result.error);
                        dialog.showMessageBoxSync({
                            type: 'warning',
                            title: 'Fix Audio failed',
                            message: result.error || 'Unknown error',
                            detail: result.steps.length
                                ? `Completed before failure:\n${result.steps.join('\n')}`
                                : 'Install switchaudio-osx: brew install switchaudio-osx',
                        });
                    }
                },
            },
            { type: 'separator' },
            {
                label: 'Test overdue + phone push',
                enabled: haPushConfigured(),
                click: () => {
                    const meeting = notifier?.nextMeeting || { summary: 'Test meeting' };
                    startAlert(meeting);
                    const { title, message, urgent } = pushTextForKind('start', meeting);
                    sendHaPush({
                        title,
                        message,
                        urgent,
                        url: meeting?.videoEntryPoint?.uri,
                    });
                },
            },
            {
                label: 'Test phone push (gentle)',
                enabled: haPushConfigured(),
                click: () => sendHaPush({
                    title: 'Orbit test',
                    message: 'Gentle reminder channel',
                    urgent: false,
                }),
            },
            {
                label: 'Test overdue alert (Mac only)',
                click: () => startAlert(notifier?.nextMeeting || { summary: 'Test meeting' }),
            },
            { type: 'separator' },
            {
                label: 'Show console window',
                click: () => createLogWindow(),
            },
            {
                label: 'Open events log',
                click: () => shell.openPath(path.join(paths.dataDir, 'events-log.json')),
            },
            {
                label: 'Open config folder',
                click: () => shell.openPath(paths.userData ?? path.dirname(paths.credentialsPath)),
            },
            { type: 'separator' },
            {
                label: 'Run tunnel health check',
                enabled: Boolean(configStore?.getSection('tunnel')?.rules?.enabled),
                click: () => runTunnelHealthCheck({ notify: false }).catch((err) => {
                    console.error('Tunnel health check:', err.message);
                }),
            },
            {
                label: 'Open Tunnel settings',
                click: () => createSettingsWindow(),
            },
            { type: 'separator' },
            {
                label: 'Menu bar icon hidden?',
                click: () => {
                    dialog.showMessageBoxSync({
                        type: 'info',
                        title: 'Find Orbit in the menu bar',
                        message: 'macOS may hide menu bar icons when space is tight (especially on notched MacBooks).',
                        detail:
                            '1. Look for a small circle icon on the right side of the menu bar.\n\n' +
                            '2. Click the ◁ or >> control at the right edge of the menu bar to reveal hidden icons.\n\n' +
                            '3. System Settings → Control Center → Menu Bar Only → drag items you don\'t need into Control Center.\n\n' +
                            '4. Quit other menu bar apps to free space.\n\n' +
                            'The meeting countdown also appears in this dropdown menu even if the title is hidden.',
                        buttons: ['OK'],
                    });
                },
            },
            {
                label: 'Reload menu bar icon',
                click: () => recreateTray(),
            },
            {
                label: 'Fix menu bar visibility (macOS 26)',
                click: () => fixMenuBarVisibility(),
            },
        ],
    });

    items.push({ type: 'separator' });
    items.push({ role: 'quit', label: 'Quit Orbit' });

    if (menuIsOpen) {
        pendingMenuRebuild = true;
        return;
    }

    applyMenu(Menu.buildFromTemplate(items));
    lastMenuSignature = signature;
}

function refreshUI(paths) {
    updateTrayTitle();
    if (menuIsOpen) {
        pendingMenuRebuild = true;
        return;
    }
    buildMenu(paths);
}

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) return; // duplicate instance; already exiting

    const paths = resolvePaths();
    trayPaths = paths;
    const extraEnvSources = [];
    if (app.isPackaged) {
        extraEnvSources.push(
            path.join(app.getPath('appData'), 'meeting-notifier', '.env'),
            path.join(app.getPath('home'), 'meeting-notifier', '.env'),
        );
    }
    configStore = createConfigStore(paths.dataDir, { extraEnvSources });
    loadSettings(paths.dataDir);
    loadAlertHistory(paths.dataDir);
    initPresenceTracking();

    // Load .env from the user-data location (or project folder in dev) BEFORE
    // requiring index.js, since dotenv only fills missing process.env entries.
    for (const candidate of paths.envCandidates) {
        if (fs.existsSync(candidate)) {
            require('dotenv').config({ path: candidate });
            break;
        }
    }

    const { OrbitNotifier } = require('./index.js');

    repairMenuBarVisibility();
    createTray();

    if (process.platform === 'darwin' && app.dock && !dockShown) {
        app.dock.show();
        dockShown = true;
    }

    registerSettingsHandlers();
    registerAlertPanelHandlers();

    const soundResolver = createSoundResolver({
        soundsDir: paths.soundsDir,
        defaultPath: paths.soundPath,
        getAlertsConfig: () => configStore?.getSection('alerts'),
    });
    notifier = new OrbitNotifier({
        credentialsPath: paths.credentialsPath,
        dataDir: paths.dataDir,
        soundPath: paths.soundPath,
    });
    notifier._resolveAlertSound = (source) => soundResolver.resolve(source);
    notifier.lightsAllowed = isAtDesk;
    notifier.reinitializeSound();
    // Detect browser-based calls (Google Meet / Daily / Zoom web) in addition to
    // the native Zoom process, so lights/status reflect those too.
    notifier.addCallDetector(detectWebCall);
    // Detect a user-selected meeting camera actively streaming (catches embedded
    // calls like the ClickUp syncup that have no detectable tab URL).
    notifier.addCallDetector(detectSelectedCamera);
    notifier.zoomProcessDetectionEnabled = callDetectZoom;

    alertHub = new AlertHub({
        configStore,
        notifier,
        isAwayFromMac,
        isPushEnabled: () => pushEnabled,
        shouldPushForMeeting,
    });

    clickUpWatcher = new ClickUpWatcher({
        configStore,
        alertHub,
        dataDir: paths.dataDir,
    });

    alertHub.on('clickup-alert', () => {
        lastMenuSignature = null;
        if (trayPaths) refreshUI(trayPaths);
    });

    alertHub.on('delivered', ({ source, title, message, url, urgent, groupKey }) => {
        showUserAlert({ title, body: message, url, source, urgent, groupKey });
    });

    notifier.on('status', (status) => {
        refreshUI(paths);
        if (status === 'running') {
            applyTunnelWebhookHooks().catch((err) => console.error('Tunnel webhooks:', err.message));
        }
    });
    notifier.on('meeting-update', () => refreshUI(paths));

    // Detecting an active Zoom meeting (CptHost process) means you've joined,
    // so auto-dismiss the overdue alert.
    notifier.on('zoom-state', (running) => {
        if (running && alert.active) {
            console.log('✓ Detected you joined a meeting — dismissing alert');
            stopAlert();
        }
        lastMenuSignature = null;
        refreshUI(paths);
    });

    // Screen flash stays in lockstep with the lights + sound: the notifier emits
    // blink-on/blink-off on every pulse of blinkLight().
    notifier.on('blink-on', showFlash);
    notifier.on('blink-off', hideFlash);

    notifier.on('notification', async ({ kind, meeting }) => {
        const { title, message, urgent } = pushTextForKind(kind, meeting);
        if (alertHub) {
            await alertHub.deliverMeeting({ kind, meeting, title, message, urgent });
        } else {
            await maybePushToPhone({ title, message, urgent, meeting });
        }

        if (kind === 'start' && !(await isAlreadyInMeeting(meeting))) startAlert(meeting);
    });

    refreshUI(paths);
    createHudWindow();
    updateHudWindow();
    createAlertPanelWindow();
    startPhonePushPolling();
    startPhonePushSubscription();
    startAudioRouter();
    startCameraWatchdog();
    reapStaleNotifiers({ includeOrphans: true })
        .then((n) => n && log.orbit(`Cleaned up ${n} stuck notification process(es)`))
        .catch(() => {});
    setInterval(() => reapStaleNotifiers().catch(() => {}), 5 * 60 * 1000);
    log.orbit('Started — use menu → Show console window to watch live activity');

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        const result = dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Orbit — Setup needed',
            message: 'Missing configuration',
            detail:
                `Orbit needs a .env file at:\n\n${paths.envCandidates[0]}\n\n` +
                'It must define GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and ELGATO_KEY_LIGHTS.\n\n' +
                'Would you like to open the config folder now?',
            buttons: ['Open config folder', 'Continue without config'],
            defaultId: 0,
            cancelId: 1,
        });
        if (result === 0) {
            shell.openPath(paths.userData ?? path.dirname(paths.envCandidates[0]));
        }
    }

    try {
        notifier.start();
        startCloudflareTunnel()
            .catch((err) => console.error('Tunnel startup:', err.message))
            .finally(() => restartClickUpWatcher());
    } catch (error) {
        dialog.showErrorBox('Failed to start Orbit', error.message);
    }

    if (process.env.ORBIT_TEST_FLASH === '1' || process.env.MN_TEST_FLASH === '1') {
        setTimeout(() => {
            console.log('[test] flashing screen 3x');
            flashScreen(3, 600).then(() => console.log('[test] flash done'));
        }, 800);
    }

    if (!sawLaunchNotification) {
        sawLaunchNotification = true;
        saveSettings();
    }

    // Countdown tick — only updates badge/HUD/title when values change.
    setInterval(updateTrayTitle, 1000);
});

// Clicking the Dock icon re-opens/focuses the console window.
app.on('activate', () => {
    if (gotSingleInstanceLock) createLogWindow();
});

// If a second copy is launched, focus this instance's console window.
app.on('second-instance', () => {
    createLogWindow();
});

let cleanedUp = false;
function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (alert.timer) clearInterval(alert.timer);
    if (alert.nagTimer) clearInterval(alert.nagTimer);
    if (alert.browserTimer) clearInterval(alert.browserTimer);
    stopDismissPolling();
    if (phonePushPollTimer) clearInterval(phonePushPollTimer);
    phonePushPollTimer = null;
    if (phonePushSubscription) phonePushSubscription.close();
    phonePushSubscription = null;
    notifier?.stop();
    audioRouter?.stop();
    audioRouter = null;
    cameraWatchdog?.stop();
    cameraWatchdog = null;
    stopTunnelHealthMonitor();
    stopCloudflareTunnel();
    if (webhookServer) {
        log.webhook('Stopping webhook server…');
        try { webhookServer.close(); } catch { /* noop */ }
        webhookServer = null;
    }
    destroyFlashWindows();
    if (tray && !tray.isDestroyed()) {
        tray.destroy();
        tray = null;
    }
    if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.destroy();
        hudWindow = null;
    }
    if (alertPanelWindow && !alertPanelWindow.isDestroyed()) {
        alertPanelWindow.destroy();
        alertPanelWindow = null;
    }
    cachedAppMenu = null;
}

// Electron fires `before-quit` both for the menu "Quit" item and on SIGINT
// (Ctrl-C in `npm run tray`), so destroying the tray here removes the menu bar
// icon in every case instead of leaving a ghost.
app.on('before-quit', () => {
    isQuitting = true;
    cleanup();
});
