const fs = require('fs');
const path = require('path');

const SOURCE_KEYS = ['meetings', 'clickup', 'email', 'datadog'];

/**
 * @param {object} opts
 * @param {string} opts.soundsDir - directory with {source}.wav files
 * @param {string} opts.defaultPath - bundled ding.wav fallback
 * @param {() => object} opts.getAlertsConfig
 */
function createSoundResolver({ soundsDir, defaultPath, getAlertsConfig }) {
    function resolve(source) {
        const key = SOURCE_KEYS.includes(source) ? source : 'meetings';
        try {
            const alerts = getAlertsConfig?.() || {};
            const custom = String(alerts.sounds?.[key] || '').trim();
            if (custom && fs.existsSync(custom)) return custom;
            const fallback = String(alerts.sounds?.default || '').trim()
                || String(process.env.ALERT_SOUND || '').trim();
            if (fallback && fs.existsSync(fallback)) return fallback;
        } catch {
            // use bundled
        }
        const bundled = path.join(soundsDir, `${key}.wav`);
        if (fs.existsSync(bundled)) return bundled;
        return defaultPath;
    }

    return { resolve, SOURCE_KEYS };
}

module.exports = { createSoundResolver, SOURCE_KEYS };
