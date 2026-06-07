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
    isConfigured: haPushConfigured,
    dismissEntityId,
} = require('./push.js');
const { fixAudio } = require('./audio-fix.js');

let tray = null;
let notifier = null;
let flashWindows = null;
let isFlashing = false;
let trayPaths = null;
let logWindow = null;
let hudWindow = null;
let isQuitting = false;
let menuIsOpen = false;
let pendingMenuRebuild = false;
let lastTrayTitle = null;
let lastDockBadge = null;
let lastMenuSignature = null;
let dockShown = false;
let hudUserPosition = null;
let cachedAppMenu = null;
let lastTrayIconKey = null;
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
let menuBarTitle = false;
/** 'text' = ● in menu bar (most visible); 'dot' = tiny icon; 'ring' = colorful ring */
let trayIconStyle = 'text';
/** Floating pill under the menu bar — reliable on macOS 26 when Control Center hides the tray */
let showFloatingHud = true;
let settingsPath = null;

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
        if (raw.sawLaunchNotification === true) sawLaunchNotification = true;
    } catch {
        // first run — defaults apply
    }
}

function saveSettings() {
    if (!settingsPath) return;
    try {
        const data = {
            pushEnabled, menuBarTitle, trayIconStyle, showFloatingHud, sawLaunchNotification,
        };
        if (hudUserPosition) {
            data.hudX = hudUserPosition.x;
            data.hudY = hudUserPosition.y;
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
    powerMonitor.on('resume', () => { screenLocked = false; });
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

// Mirror all console output into an in-app buffer (and the console window, if
// open) so the app can be run from the Dock without a terminal and still show
// its logs. The original terminal output is preserved.
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function formatLogArg(a) {
    return typeof a === 'string' ? a : util.inspect(a, { depth: 3, colors: false });
}
function pushLog(level, args) {
    const line = args.map(formatLogArg).join(' ').replace(ANSI_RE, '');
    logBuffer.push({ line, level });
    if (logBuffer.length > 2000) logBuffer.shift();
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('log-line', { line, level });
    }
}
for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
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

    return {
        userData: configDir,
        envCandidates: [path.join(configDir, '.env')],
        credentialsPath: path.join(configDir, 'credentials.json'),
        dataDir: configDir,
        soundPath,
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

function createOrbitIconImage(hex, arcFraction, logicalSize = 18, { alert = false } = {}) {
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

function orbitIconCacheKey(state) {
    const prefix = trayIconStyle;
    if (state.alert) {
        return `${prefix}-alert-${state.color}-${Math.floor((state.arc ?? 0) * 60)}`;
    }
    if (state.arc == null) return `${prefix}-dot-${state.color}`;
    if (state.arc > 1 / 60) return `${prefix}-arc-${state.color}-${Math.floor(state.arc * 60)}`;
    return `${prefix}-arc-${state.color}-${Math.floor(state.arc * 360)}`;
}

function trayImageForState() {
    const state = orbitVisualState();
    return createOrbitIconImage(state.color, state.arc, 18, { alert: state.alert });
}

function updateTrayIcon() {
    if (!tray || tray.isDestroyed()) return;
    const state = orbitVisualState();
    const iconKey = orbitIconCacheKey(state);
    if (iconKey === lastTrayIconKey) return;
    lastTrayIconKey = iconKey;
    tray.setImage(trayImageForState());
}

/** macOS 26 Tahoe can allow an app in Menu Bar settings but still hide its NSStatusItem off-screen. */
function repairMenuBarVisibility({ restartControlCenter = false } = {}) {
    if (process.platform !== 'darwin' || !app.isPackaged) return;

    const { execSync } = require('child_process');
    const bundleId = require('./package.json').build?.appId || 'com.rjtuit.orbit';

    for (let i = 0; i < 8; i++) {
        const key = `NSStatusItem VisibleCC Item-${i}`;
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
        execSync(`defaults write ${bundleId} "NSStatusItem VisibleCC Item-0" -bool true`);
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
    tray = new Tray(trayImageForState());

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
    if (alert.active) {
        return `🔴 ${truncate(alert.meeting?.summary || 'Meeting', 18)}`;
    }
    const meeting = notifier?.nextMeeting;
    if (!meeting) return 'No meetings';
    const desc = describeNextMeeting(meeting);
    if (!desc) return 'No meetings';
    return `${truncate(desc.summary, 16)}  ${formatCountdown(desc.msUntil)}`;
}

function positionHudWindowDefault() {
    if (!hudWindow || hudWindow.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
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
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    hudWindow.setAlwaysOnTop(true, 'floating', 1);
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
        if (!hudWindow.isVisible()) hudWindow.showInactive();
    }).catch(() => {
        if (!hudWindow.isDestroyed() && !hudWindow.isVisible()) {
            positionHudWindow();
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
        notifier?.blinkLight(2, 600);
        const { title, message, urgent } = pushTextForKind('nag', meeting);
        maybePushToPhone({ title, message, urgent, meeting });
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

        setTrayTitleIfChanged(title);
        tray.setToolTip(tooltip);
        updateTrayIcon();
    }
    updateDockBadge();
    updateHudWindow();
}

function attachMenuLifecycle(menu) {
    menu.on('menu-will-show', () => { menuIsOpen = true; });
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
        nextCal: next?._calendarId,
        nextColor: calendarColorForMeeting(next),
        currentId: current?.id,
        zoom: notifier?.zoomIsRunning,
        authUrl: !!notifier?.authUrl,
        nextLink: !!next?.videoEntryPoint?.uri,
        currentLink: !!current?.videoEntryPoint?.uri,
        lights: notifier?.keyLights?.length ?? 0,
        pushEnabled,
        menuBarTitle,
        trayIconStyle,
        showFloatingHud,
        haPush: haPushConfigured(),
        login: app.getLoginItemSettings().openAtLogin,
        dataDir: paths?.dataDir,
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
        label: notifier?.zoomIsRunning ? 'Zoom: in meeting' : 'Zoom: idle',
        enabled: false,
    });

    const lightCount = notifier?.keyLights?.length ?? 0;
    items.push({
        label: `Elgato lights: ${lightCount}`,
        enabled: false,
    });

    items.push({ type: 'separator' });

    items.push({
        label: 'Refresh now',
        click: () => notifier?.checkForNextMeeting(),
        enabled: notifier?.status === 'running',
    });
    items.push({
        label: 'Test blink',
        click: () => notifier?.blinkLight(1, 600),
        enabled: lightCount > 0,
    });
    items.push({
        label: 'Test screen flash',
        click: () => flashScreen(2, 600),
    });
    items.push({
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
    });
    items.push({
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
    });
    items.push({
        label: 'Test phone push (gentle)',
        enabled: haPushConfigured(),
        click: () => sendHaPush({
            title: 'Orbit test',
            message: 'Gentle reminder channel',
            urgent: false,
        }),
    });
    items.push({
        label: 'Test overdue alert (Mac only)',
        click: () => startAlert(notifier?.nextMeeting || { summary: 'Test meeting' }),
    });
    items.push({
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
    });
    items.push({
        label: 'Show console window',
        click: () => createLogWindow(),
    });
    items.push({
        label: 'Open events log',
        click: () => shell.openPath(path.join(paths.dataDir, 'events-log.json')),
    });
    items.push({
        label: 'Open config folder',
        click: () => shell.openPath(paths.userData ?? path.dirname(paths.credentialsPath)),
    });

    items.push({ type: 'separator' });

    items.push({
        label: 'Show countdown in menu bar',
        type: 'checkbox',
        checked: menuBarTitle,
        click: (item) => {
            menuBarTitle = item.checked;
            saveSettings();
            updateTrayTitle();
        },
    });

    items.push({
        label: 'Menu bar icon',
        submenu: [
            {
                label: 'Orbit countdown (last hour)',
                type: 'radio',
                checked: trayIconStyle === 'text',
                click: () => {
                    trayIconStyle = 'text';
                    saveSettings();
                    applyTrayIconStyle();
                },
            },
            {
                label: 'Dot only (calendar color)',
                type: 'radio',
                checked: trayIconStyle === 'dot',
                click: () => {
                    trayIconStyle = 'dot';
                    saveSettings();
                    applyTrayIconStyle();
                },
            },
            {
                label: 'Full ring + countdown',
                type: 'radio',
                checked: trayIconStyle === 'ring',
                click: () => {
                    trayIconStyle = 'ring';
                    saveSettings();
                    applyTrayIconStyle();
                },
            },
        ],
    });

    items.push({
        label: 'Reload menu bar icon',
        click: () => recreateTray(),
    });

    items.push({
        label: 'Fix menu bar visibility (macOS 26)',
        click: () => fixMenuBarVisibility(),
    });

    items.push({
        label: 'Show floating countdown',
        type: 'checkbox',
        checked: showFloatingHud,
        click: (item) => {
            showFloatingHud = item.checked;
            saveSettings();
            updateHudWindow();
        },
    });

    items.push({
        label: 'Push to phone when away',
        type: 'checkbox',
        checked: pushEnabled,
        enabled: haPushConfigured(),
        click: (item) => {
            pushEnabled = item.checked;
            saveSettings();
        },
    });

    items.push({
        label: 'Launch at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
            app.setLoginItemSettings({
                openAtLogin: item.checked,
                openAsHidden: true,
            });
        },
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
    loadSettings(paths.dataDir);
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

    createTray();

    if (process.platform === 'darwin' && app.dock && !dockShown) {
        app.dock.show();
        dockShown = true;
    }

    notifier = new OrbitNotifier({
        credentialsPath: paths.credentialsPath,
        dataDir: paths.dataDir,
        soundPath: paths.soundPath,
    });
    notifier.on('status', () => refreshUI(paths));
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
        await maybePushToPhone({ title, message, urgent, meeting });

        // When a meeting starts, raise a blinking red overdue alert — unless you've
        // already joined (Zoom or meeting link open in a browser).
        if (kind === 'start' && !(await isAlreadyInMeeting(meeting))) startAlert(meeting);
    });

    refreshUI(paths);
    createHudWindow();
    updateHudWindow();

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
    } catch (error) {
        dialog.showErrorBox('Failed to start Orbit', error.message);
    }

    if (process.env.ORBIT_TEST_FLASH === '1' || process.env.MN_TEST_FLASH === '1') {
        setTimeout(() => {
            console.log('[test] flashing screen 3x');
            flashScreen(3, 600).then(() => console.log('[test] flash done'));
        }, 800);
    }

    if (Notification.isSupported() && !sawLaunchNotification) {
        const n = new Notification({
            title: 'Orbit is running',
            body: 'Menu bar orbit color matches your calendar. Right-click the Dock icon or floating pill for the menu.',
            silent: true,
        });
        n.on('click', () => createLogWindow());
        n.show();
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
    notifier?.stop();
    destroyFlashWindows();
    if (tray && !tray.isDestroyed()) {
        tray.destroy();
        tray = null;
    }
    if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.destroy();
        hudWindow = null;
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
