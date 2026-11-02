/** Tagged log lines for the Orbit console (captured by tray.js). */
function write(level, tag, message, ...extra) {
    const prefix = `[${tag}] ${message}`;
    if (extra.length) console[level](prefix, ...extra);
    else console[level](prefix);
}

module.exports = {
    orbit: (message, ...extra) => write('log', 'orbit', message, ...extra),
    tunnel: (message, ...extra) => write('log', 'tunnel', message, ...extra),
    tunnelWarn: (message, ...extra) => write('warn', 'tunnel', message, ...extra),
    tunnelError: (message, ...extra) => write('error', 'tunnel', message, ...extra),
    webhook: (message, ...extra) => write('log', 'webhook', message, ...extra),
    webhookWarn: (message, ...extra) => write('warn', 'webhook', message, ...extra),
    calendar: (message, ...extra) => write('log', 'calendar', message, ...extra),
    calendarError: (message, ...extra) => write('error', 'calendar', message, ...extra),
    clickup: (message, ...extra) => write('log', 'clickup', message, ...extra),
    clickupWarn: (message, ...extra) => write('warn', 'clickup', message, ...extra),
    clickupError: (message, ...extra) => write('error', 'clickup', message, ...extra),
    audio: (message, ...extra) => write('log', 'audio', message, ...extra),
    audioWarn: (message, ...extra) => write('warn', 'audio', message, ...extra),
    audioError: (message, ...extra) => write('error', 'audio', message, ...extra),
    camera: (message, ...extra) => write('log', 'camera', message, ...extra),
    cameraWarn: (message, ...extra) => write('warn', 'camera', message, ...extra),
};
