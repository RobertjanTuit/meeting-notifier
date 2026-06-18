const { execFile } = require('child_process');
const { Notification } = require('electron');
const notifier = require('node-notifier');

const OSASCRIPT = '/usr/bin/osascript';

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
        notifier.notify({
            title: title || 'Orbit',
            message: body || ' ',
            subtitle: subtitle || '',
            sound: false,
            open: open || undefined,
            wait: Boolean(onClick && !open),
            appID: 'com.rjtuit.orbit',
            timeout: 20,
            sender: 'com.rjtuit.orbit',
        }, (err, response) => {
            if (err) {
                reject(err);
                return;
            }
            if (onClick && !open && response && response !== 'timeout') {
                try {
                    onClick();
                } catch (clickErr) {
                    reject(clickErr);
                    return;
                }
            }
            resolve({ response });
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

module.exports = { showDesktopNotification };
