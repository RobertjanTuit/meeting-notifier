const { execFile } = require('child_process');
const { Notification } = require('electron');
const notifier = require('node-notifier');
// Keep in sync with package.json build.appId; the packaged package.json has no build section.
const BUNDLE_ID = 'com.rjtuit.orbit-app';

const OSASCRIPT = '/usr/bin/osascript';
const NOTIFIER_TIMEOUT_S = 20;
// terminal-notifier never exits when -sender is set, so each one is reaped after its timeout.
const NOTIFIER_GRACE_S = 10;
const NOTIFIER_PROCESS = 'terminal-notifier.app/Contents/MacOS/terminal-notifier';

/** Parses ps etime (`[[dd-]hh:]mm:ss`) into seconds. */
function etimeSeconds(etime) {
    const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime];
    const parts = rest.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Kills Orbit's terminal-notifier processes that outlived their timeout: our own
 * children, plus (with includeOrphans) ones left behind by an earlier Orbit run.
 */
function reapStaleNotifiers({ includeOrphans = false } = {}) {
    if (process.platform !== 'darwin') return Promise.resolve(0);
    return new Promise((resolve) => {
        execFile('/bin/ps', ['-axo', 'pid=,ppid=,etime=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(0);
            let killed = 0;
            for (const line of String(stdout).split('\n')) {
                const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
                if (!m || !m[4].includes('Orbit.app/') || !m[4].includes(NOTIFIER_PROCESS)) continue;
                const pid = Number(m[1]);
                const ppid = Number(m[2]);
                const ours = ppid === process.pid || (includeOrphans && ppid === 1);
                if (!ours || etimeSeconds(m[3]) < NOTIFIER_TIMEOUT_S + NOTIFIER_GRACE_S) continue;
                try {
                    process.kill(pid, 'SIGTERM');
                    killed++;
                } catch {
                    // already gone
                }
            }
            resolve(killed);
        });
    });
}

function showMacOsascriptNotification({ title, body, subtitle }) {
    let script = `display notification ${JSON.stringify(body || ' ')} with title ${JSON.stringify(title || 'Orbit')}`;
    if (subtitle) script += ` subtitle ${JSON.stringify(subtitle)}`;
    return new Promise((resolve, reject) => {
        execFile(OSASCRIPT, ['-e', script], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function showNodeNotifier({ title, body, subtitle, open, onClick }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            fn(value);
        };
        // The callback never fires when terminal-notifier hangs; treat that as a timeout
        // so callers don't fall back to a second, duplicate notification.
        const deadline = setTimeout(() => {
            settle(resolve, { response: 'timeout' });
            reapStaleNotifiers().catch(() => {});
        }, (NOTIFIER_TIMEOUT_S + NOTIFIER_GRACE_S) * 1000 + 1000);
        notifier.notify({
            title: title || 'Orbit',
            message: body || ' ',
            subtitle: subtitle || '',
            sound: false,
            open: open || undefined,
            wait: Boolean(onClick && !open),
            appID: BUNDLE_ID,
            timeout: NOTIFIER_TIMEOUT_S,
            sender: BUNDLE_ID,
        }, (err, response) => {
            if (err) {
                settle(reject, err);
                return;
            }
            if (onClick && !open && response && response !== 'timeout') {
                try {
                    onClick();
                } catch (clickErr) {
                    settle(reject, clickErr);
                    return;
                }
            }
            settle(resolve, { response });
        });
    });
}

function showElectronNotification({ title, body, onClick }) {
    return new Promise((resolve, reject) => {
        if (!Notification.isSupported()) {
            reject(new Error('Notifications not supported'));
            return;
        }
        const n = new Notification({
            title: title || 'Orbit',
            body: body || '',
            silent: true,
        });
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
        };
        n.on('show', () => finish());
        n.on('failed', (_e, error) => finish(error || new Error('notification failed')));
        if (onClick) n.on('click', onClick);
        n.show();
        setTimeout(() => finish(), 1500);
    });
}

async function showDesktopNotification({ title, body, subtitle, open, onClick } = {}) {
    const opts = { title: title || 'Orbit', body: body || '', subtitle, open, onClick };

    if (process.platform === 'darwin') {
        try {
            const result = await showNodeNotifier(opts);
            return { method: 'terminal-notifier', ...result };
        } catch (err) {
            try {
                await showMacOsascriptNotification(opts);
                return { method: 'osascript' };
            } catch {
                await showElectronNotification(opts);
                return { method: 'electron' };
            }
        }
    }

    await showElectronNotification(opts);
    return { method: 'electron' };
}

module.exports = { BUNDLE_ID, showDesktopNotification, reapStaleNotifiers, etimeSeconds };
