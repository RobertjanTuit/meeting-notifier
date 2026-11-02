const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Elgato Camera Hub';
const APP_BIN = '/Applications/Elgato Camera Hub.app/Contents/MacOS/Camera Hub';
const HUB_LOG = path.join(os.homedir(), 'Library/Logs/ElgatoCameraHub/CameraHub0.log');

// A frozen virtual camera logs this once a minute with ~1800 skipped frames
// (every frame at 30 fps); ordinary hiccups report 0-3.
const STALL_PATTERN = /^(\S+) .*Queue is full .*EGAVSinkVirtualCamera.*SLOW: (\d+) logs skipped/;

const DEFAULTS = {
    intervalMs: 30_000,
    windowMs: 150_000,
    minSkipped: 300,
    cooldownMs: 180_000,
    tailBytes: 64 * 1024,
};

function run(cmd, args, timeout = 15000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
    });
}

function readTail(file, bytes) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, bytes);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd != null) fs.closeSync(fd);
    }
}

/** Camera Hub writes `2026-11-02T14:07:49.196-0800`; Date.parse needs `-08:00`. */
function parseHubTime(stamp) {
    const ms = Date.parse(stamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isFinite(ms) ? ms : null;
}

function latestStall(text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = STALL_PATTERN.exec(lines[i]);
        if (m) return { at: parseHubTime(m[1]), stamp: m[1], skipped: Number(m[2]) };
    }
    return null;
}

async function hubPids() {
    const { stdout } = await run('/usr/bin/pgrep', ['-f', APP_BIN]);
    return stdout.split('\n').map(Number).filter((n) => n > 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Force-restarts Camera Hub; a normal quit is refused while the virtual camera has clients. */
async function restartCameraHub() {
    if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' };
    if (!fs.existsSync(APP_BIN)) return { ok: false, error: `${APP_NAME} is not installed` };

    for (const pid of await hubPids()) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    for (let i = 0; i < 10 && (await hubPids()).length; i++) await sleep(1000);
    for (const pid of await hubPids()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    const { err } = await run('/usr/bin/open', ['-g', '-a', APP_NAME, '--args', '--background']);
    if (err) return { ok: false, error: err.message };
    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        if ((await hubPids()).length) return { ok: true };
    }
    return { ok: false, error: `${APP_NAME} did not come back up` };
}

/**
 * Watches Camera Hub's log for a stalled virtual camera and restarts Camera Hub.
 * getConfig() → { enabled }; onRestart({ ok, reason, error, manual }) after each restart.
 */
function createElgatoCameraWatchdog({ getConfig, onLog = () => {}, onRestart = () => {}, options = {} } = {}) {
    const opts = { ...DEFAULTS, ...options };
    let timer = null;
    let restarting = false;
    let lastRestartAt = 0;

    async function restart(reason, manual = false) {
        if (restarting) return { ok: false, error: 'already restarting' };
        restarting = true;
        lastRestartAt = Date.now();
        onLog(`Restarting ${APP_NAME}: ${reason}`);
        try {
            const result = await restartCameraHub();
            onLog(result.ok ? `${APP_NAME} restarted` : `${APP_NAME} restart failed: ${result.error}`);
            onRestart({ ...result, reason, manual });
            return result;
        } finally {
            restarting = false;
        }
    }

    async function tick() {
        if (restarting || !getConfig().enabled || process.platform !== 'darwin') return null;
        const now = Date.now();
        if (now - lastRestartAt < opts.cooldownMs) return null;
        const stall = latestStall(readTail(HUB_LOG, opts.tailBytes));
        if (!stall || stall.at == null || stall.skipped < opts.minSkipped) return null;
        if (now - stall.at > opts.windowMs || stall.at <= lastRestartAt) return null;
        return restart(`virtual camera froze (${stall.skipped} frames dropped at ${stall.stamp})`);
    }

    return {
        start() {
            if (timer) return;
            timer = setInterval(() => tick().catch((err) => onLog(`Camera watchdog error: ${err.message}`)), opts.intervalMs);
            tick().catch((err) => onLog(`Camera watchdog error: ${err.message}`));
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
        tick,
        restartNow: () => restart('requested from the menu', true),
        isRestarting: () => restarting,
    };
}

module.exports = { createElgatoCameraWatchdog, restartCameraHub, latestStall, parseHubTime, DEFAULTS };
