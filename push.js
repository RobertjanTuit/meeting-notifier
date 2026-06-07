/**
 * Home Assistant mobile push notifications (Android companion app).
 * Urgent alerts use alarm_stream_max to bypass Do Not Disturb; gentle reminders
 * use a dedicated high-importance channel.
 */

const HA_CHANNEL = 'Orbit Reminders';
const HA_ALERT_TAG = 'orbit-alert';
const HA_ALERT_TAGS = [HA_ALERT_TAG, 'meeting-notifier-alert'];
const HA_DISMISS_ACTION = 'ORBIT_DISMISS';

function haBase() {
    return process.env.HA_URL.replace(/\/+$/, '');
}

function haHeaders() {
    return {
        Authorization: `Bearer ${process.env.HA_TOKEN}`,
        'Content-Type': 'application/json',
    };
}

function notifyEndpoint() {
    const target = resolveNotifyTarget(process.env.HA_NOTIFY_TARGET);
    return `${haBase()}/api/services/notify/${encodeURIComponent(target)}`;
}

function dismissEntityId() {
    return process.env.HA_DISMISS_ENTITY || 'input_boolean.orbit_dismiss';
}

function buildDismissActions(url) {
    const actions = [{ action: HA_DISMISS_ACTION, title: 'Dismiss' }];
    if (url) {
        actions.push({ action: 'URI', title: 'Open meeting', uri: url });
    }
    return actions;
}

function urgentUsesTts() {
    const mode = (process.env.PUSH_URGENT_MODE || 'tts').toLowerCase();
    return mode !== 'alarm_stream';
}

function isConfigured() {
    return !!(process.env.HA_URL && process.env.HA_TOKEN && process.env.HA_NOTIFY_TARGET);
}

/** Map .env value to the legacy notify service name (e.g. mobile_app_pixel_8_pro). */
function resolveNotifyTarget(raw) {
    let t = raw.replace(/^notify\./, '').trim();
    if (t.startsWith('mobile_app_')) return t;
    // Entity id suffix from notify.pixel_8_pro → mobile_app_pixel_8_pro
    if (/^[a-z0-9_]+$/i.test(t)) return `mobile_app_${t}`;
    // Friendly device name, e.g. "Pixel 8 Pro" → mobile_app_pixel_8_pro
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `mobile_app_${slug}`;
}

/**
 * @param {{ title: string, message: string, urgent?: boolean, url?: string, dismissible?: boolean }} opts
 * @returns {Promise<boolean>} true if HA accepted the push
 */
async function sendHaPush({ title, message, urgent = false, url, dismissible }) {
    if (!isConfigured()) {
        console.log('📱 Phone push skipped (HA_URL / HA_TOKEN / HA_NOTIFY_TARGET not set)');
        return false;
    }

    const endpoint = notifyEndpoint();
    const vibrationPattern = '100, 300, 100, 300, 100';
    const showDismiss = dismissible ?? urgent;
    let body;

    if (urgent && urgentUsesTts()) {
        // TTS + alarm_stream_max: speaks the alert at max alarm volume, bypasses DnD.
        const ttsText = [title, message].filter(Boolean).join('. ');
        const data = {
            tts_text: ttsText,
            media_stream: 'alarm_stream_max',
            priority: 'high',
            ttl: 0,
            sticky: true,
            vibrationPattern,
        };
        if (url) data.clickAction = url;
        if (showDismiss) {
            data.tag = HA_ALERT_TAG;
            data.actions = buildDismissActions(url);
        }
        body = { message: 'TTS', title, data };
    } else {
        const data = {
            priority: 'high',
            ttl: 0,
            sticky: urgent,
            vibrationPattern,
        };
        if (urgent) {
            data.channel = 'alarm_stream';
            data.importance = 'max';
        } else {
            data.channel = HA_CHANNEL;
            data.importance = 'high';
        }
        if (url) data.clickAction = url;
        if (showDismiss) {
            data.tag = HA_ALERT_TAG;
            data.actions = buildDismissActions(url);
        }
        body = { title, message, data };
    }

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: haHeaders(),
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`📱 HA push failed (${res.status}): ${body.slice(0, 200)}`);
            return false;
        }

        const mode = urgent && urgentUsesTts() ? 'TTS' : 'notify';
        console.log(`📱 Pushed to phone (${mode}): ${title}`);
        return true;
    } catch (err) {
        console.error('📱 HA push error:', err.message);
        return false;
    }
}

/** Clear sticky phone notifications for the active meeting alert. */
async function clearHaPhoneAlert() {
    if (!isConfigured()) return false;
    try {
        for (const tag of HA_ALERT_TAGS) {
            await fetch(notifyEndpoint(), {
                method: 'POST',
                headers: haHeaders(),
                body: JSON.stringify({
                    message: 'clear_notification',
                    data: { tag },
                }),
            });
        }
        return true;
    } catch (err) {
        console.error('📱 HA clear notification error:', err.message);
        return false;
    }
}

/** True when the HA helper entity was turned on by a phone Dismiss tap. */
async function isHaDismissRequested() {
    if (!isConfigured()) return false;
    const entity = dismissEntityId();
    try {
        const res = await fetch(`${haBase()}/api/states/${encodeURIComponent(entity)}`, {
            headers: haHeaders(),
        });
        if (!res.ok) return false;
        const state = await res.json();
        return state.state === 'on';
    } catch {
        return false;
    }
}

/** Reset the dismiss helper after the Mac has stopped the alert. */
async function acknowledgeHaDismiss() {
    if (!isConfigured()) return false;
    const entity = dismissEntityId();
    const domain = entity.split('.')[0];
    try {
        const res = await fetch(`${haBase()}/api/services/${domain}/turn_off`, {
            method: 'POST',
            headers: haHeaders(),
            body: JSON.stringify({ entity_id: entity }),
        });
        return res.ok;
    } catch (err) {
        console.error('📱 HA dismiss ack error:', err.message);
        return false;
    }
}

module.exports = {
    sendHaPush,
    clearHaPhoneAlert,
    isHaDismissRequested,
    acknowledgeHaDismiss,
    isConfigured,
    resolveNotifyTarget,
    dismissEntityId,
    HA_CHANNEL,
    HA_ALERT_TAG,
    HA_DISMISS_ACTION,
};
