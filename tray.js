const path = require('path');
const fs = require('fs');
const util = require('util');
const { app, Tray, Menu, shell, nativeImage, clipboard, dialog, screen, BrowserWindow, ipcMain } = require('electron');
const moment = require('moment');

let tray = null;
let notifier = null;
let flashWindows = null;
let isFlashing = false;
let trayPaths = null;
let logWindow = null;
let isQuitting = false;
const logBuffer = [];

// Screen flash appearance: a soft, warm yellow that's easy on the eyes.
const FLASH_COLOR = '#FFD980';
const FLASH_OPACITY = 0.4;
const alert = { active: false, meeting: null, blinkOn: false, timer: null, nagTimer: null };

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
        title: 'Meeting Notifier — Console',
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

function resolvePaths() {
    let configDir;
    let soundPath;

    if (app.isPackaged) {
        // Packaged: use a deterministic config dir so it doesn't depend on
        // app.getName() (which differs between builds). Always:
        //   ~/Library/Application Support/meeting-notifier/
        configDir = path.join(app.getPath('appData'), 'meeting-notifier');
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

function buildTrayImage() {
    const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
    if (fs.existsSync(iconPath)) {
        const img = nativeImage.createFromPath(iconPath);
        img.setTemplateImage(true);
        return img;
    }
    return nativeImage.createEmpty();
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
    const dot = alert.blinkOn ? '🔴' : '⚪';
    tray.setTitle(` ${dot} ${name} STARTED`);
    tray.setToolTip(`${alert.meeting?.summary || 'Meeting'} has started — click to dismiss`);
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
    const nagMs = Number(process.env.MN_NAG_MS) || 60 * 1000;
    if (alert.nagTimer) clearInterval(alert.nagTimer);
    alert.nagTimer = setInterval(() => {
        notifier?.blinkLight(2, 600);
    }, nagMs);

    if (trayPaths) buildMenu(trayPaths);
}

function stopAlert() {
    if (!alert.active && !alert.timer && !alert.nagTimer) return;
    if (alert.timer) clearInterval(alert.timer);
    if (alert.nagTimer) clearInterval(alert.nagTimer);
    alert.timer = null;
    alert.nagTimer = null;
    alert.active = false;
    alert.meeting = null;
    updateTrayTitle();
    if (trayPaths) buildMenu(trayPaths);
}

function updateTrayTitle() {
    if (!tray) return;

    // While an overdue alert is active, the blink timer owns the title.
    if (alert.active) {
        renderAlertTitle();
        return;
    }

    const meeting = notifier?.nextMeeting;
    const inMeeting = notifier?.zoomIsRunning;

    // Always show the next meeting + countdown, even while in a meeting.
    if (!meeting) {
        tray.setTitle(' No meetings');
        tray.setToolTip(inMeeting ? 'In a meeting — no upcoming meetings' : 'Meeting Notifier — no upcoming meetings');
        return;
    }

    const start = moment(meeting.start.dateTime);
    const msUntil = start.diff(moment());
    const summary = meeting.summary || '(no title)';
    const countdown = msUntil <= 0 ? 'now' : formatCountdown(msUntil);
    const bar = countdownBar(msUntil, 10);

    tray.setTitle(` ${truncate(summary, 18)}  ${countdown}${bar ? ' ' + bar : ''}`);
    tray.setToolTip(`Next: ${summary} at ${start.format('h:mm a')}${inMeeting ? ' (in a meeting now)' : ''}`);
}

function buildMenu(paths) {
    if (!tray) return;
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
        label: 'Test overdue alert',
        click: () => startAlert(notifier?.nextMeeting || { summary: 'Test meeting' }),
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
    items.push({ role: 'quit', label: 'Quit Meeting Notifier' });

    tray.setContextMenu(Menu.buildFromTemplate(items));
}

function refreshUI(paths) {
    updateTrayTitle();
    buildMenu(paths);
}

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) return; // duplicate instance; already exiting

    const paths = resolvePaths();
    trayPaths = paths;

    // Load .env from the user-data location (or project folder in dev) BEFORE
    // requiring index.js, since dotenv only fills missing process.env entries.
    for (const candidate of paths.envCandidates) {
        if (fs.existsSync(candidate)) {
            require('dotenv').config({ path: candidate });
            break;
        }
    }

    const { MeetingNotifier } = require('./index.js');

    tray = new Tray(buildTrayImage());

    // Clicking the tray dismisses an active overdue alert.
    tray.on('click', () => { if (alert.active) stopAlert(); });
    tray.on('right-click', () => { if (alert.active) stopAlert(); });

    notifier = new MeetingNotifier({
        credentialsPath: paths.credentialsPath,
        dataDir: paths.dataDir,
        soundPath: paths.soundPath,
    });
    notifier.on('status', () => refreshUI(paths));
    notifier.on('zoom-state', () => refreshUI(paths));
    notifier.on('meeting-update', () => refreshUI(paths));

    // Screen flash stays in lockstep with the lights + sound: the notifier emits
    // blink-on/blink-off on every pulse of blinkLight().
    notifier.on('blink-on', showFlash);
    notifier.on('blink-off', hideFlash);

    notifier.on('notification', ({ kind, meeting }) => {
        // When a meeting starts, raise a blinking red overdue alert until dismissed.
        if (kind === 'start') startAlert(meeting);
    });

    refreshUI(paths);

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        const result = dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Meeting Notifier — Setup needed',
            message: 'Missing configuration',
            detail:
                `Meeting Notifier needs a .env file at:\n\n${paths.envCandidates[0]}\n\n` +
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
        dialog.showErrorBox('Failed to start Meeting Notifier', error.message);
    }

    if (process.env.MN_TEST_FLASH === '1') {
        setTimeout(() => {
            console.log('[test] flashing screen 3x');
            flashScreen(3, 600).then(() => console.log('[test] flash done'));
        }, 800);
    }

    // Show the console window on launch so a Dock-launched app has a visible
    // window (it can be minimized or closed; the app keeps running in the tray).
    createLogWindow();

    // Smooth countdown: update the menu bar title every second (cheap, doesn't
    // disrupt an open menu). Rebuild the dropdown menu less often.
    setInterval(updateTrayTitle, 1000);
    setInterval(() => buildMenu(paths), 15 * 1000);
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
    notifier?.stop();
    destroyFlashWindows();
    if (tray && !tray.isDestroyed()) {
        tray.destroy();
        tray = null;
    }
}

// Electron fires `before-quit` both for the menu "Quit" item and on SIGINT
// (Ctrl-C in `npm run tray`), so destroying the tray here removes the menu bar
// icon in every case instead of leaving a ghost.
app.on('before-quit', () => {
    isQuitting = true;
    cleanup();
});
