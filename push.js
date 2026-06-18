/**
 * Home Assistant mobile push notifications (Android companion app).
 * Urgent alerts use alarm_stream_max to bypass Do Not Disturb; gentle reminders
 * use a dedicated high-importance channel.
 */

const HA_CHANNEL = 'Orbit Reminders';
const HA_ALERT_TAG = 'orbit-alert';
const HA_ALERT_TAGS = [HA_ALERT_TAG, 'meeting-notifier-alert'];
const HA_DISMISS_ACTION = 'ORBIT_DISMISS';
const HA_PAUSE_ACTION = 'ORBIT_PAUSE_1H';

function haBase() {
    return process.env.HA_URL.replace(/\/+$/, '');
}

function haWsUrl() {
    return `${haBase().replace(/^http/i, 'ws')}/api/websocket`;
}

/**
 * Subscribe to HA `state_changed` events over WebSocket so Orbit reflects helper
 * toggles instantly instead of waiting for the next poll. Auto-reconnects.
 * @param {string[]} entityIds entities to watch
 * @param {(entityId: string, state: string|undefined) => void} onChange
 * @returns {{ close: () => void }}
 */
function subscribeHaStates(entityIds, onChange) {
    if (!isConfigured() || typeof WebSocket === 'undefined') return { close() {} };
    const watch = new Set(entityIds);
    let ws = null;
    let msgId = 1;
    let closed = false;
    let reconnectTimer = null;

    const scheduleReconnect = () => {
        if (closed || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, 5000);
    };

    function connect() {
        if (closed) return;
        try {
            ws = new WebSocket(haWsUrl());
        } catch (err) {
            console.error('📱 HA websocket connect error:', err.message);
            scheduleReconnect();
            return;
        }
        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'auth_required') {
                ws.send(JSON.stringify({ type: 'auth', access_token: process.env.HA_TOKEN }));
            } else if (msg.type === 'auth_ok') {
                ws.send(JSON.stringify({ id: msgId++, type: 'subscribe_events', event_type: 'state_changed' }));
                console.log('📱 HA websocket connected (live helper updates)');
            } else if (msg.type === 'auth_invalid') {
                console.error('📱 HA websocket auth failed — check HA_TOKEN');
                try { ws.close(); } catch { /* noop */ }
            } else if (msg.type === 'event') {
                const data = msg.event?.data;
                const id = data?.entity_id;
                if (id && watch.has(id)) onChange(id, data.new_state?.state);
            }
        });
        ws.addEventListener('close', scheduleReconnect);
        ws.addEventListener('error', () => { try { ws.close(); } catch { /* noop */ } });
    }

    connect();
    return {
        close() {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            try { ws?.close(); } catch { /* noop */ }
        },
    };
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

function pushEntityId() {
    return process.env.HA_PUSH_ENTITY || 'input_boolean.orbit_phone_push';
}

/**
 * Phone-side master switch. Reads an HA toggle helper so push can be silenced
 * from the phone without touching the Mac. Fails open: if the helper doesn't
 * exist or HA is unreachable, pushing is still allowed — only an explicit
 * `off` state disables it.
 * @returns {Promise<boolean>}
 */
async function isHaPushEnabled() {
    if (!isConfigured()) return false;
    const entity = pushEntityId();
    try {
        const res = await fetch(`${haBase()}/api/states/${encodeURIComponent(entity)}`, {
            headers: haHeaders(),
        });
        if (!res.ok) return true;
        const state = await res.json();
        return state.state !== 'off';
    } catch {
        return true;
    }
}

function buildDismissActions(url) {
    const actions = [{ action: HA_DISMISS_ACTION, title: 'Dismiss' }];
    if (url) {
        actions.push({ action: 'URI', title: 'Open meeting', uri: url });
    }
    actions.push({ action: HA_PAUSE_ACTION, title: 'Pause 1h' });
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
async function sendHaPush({ title, message, urgent = false, url, dismissible, spoken }) {
    if (!isConfigured()) {
        console.log('📱 Phone push skipped (HA_URL / HA_TOKEN / HA_NOTIFY_TARGET not set)');
        return false;
    }

    if (!(await isHaPushEnabled())) {
        console.log('📱 Phone push skipped (disabled from phone)');
        return false;
    }

    const endpoint = notifyEndpoint();
    const vibrationPattern = '100, 300, 100, 300, 100';
    const showDismiss = dismissible ?? urgent;
    let body;

    if (urgent && urgentUsesTts()) {
        // TTS + alarm_stream_max: speaks the alert at max alarm volume, bypasses DnD.
        // Prefer a short `spoken` phrase (e.g. "Zeb in General") over the full text.
        const ttsText = spoken || [title, message].filter(Boolean).join('. ');
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

/**
 * Silence an in-progress spoken (TTS) alert on the phone by dropping the alarm
 * stream volume to 0. The next urgent TTS uses `alarm_stream_max`, which restores
 * max volume automatically, so this only mutes the current one.
 */
async function stopHaSpokenAlert() {
    if (!isConfigured()) return false;
    try {
        await fetch(notifyEndpoint(), {
            method: 'POST',
            headers: haHeaders(),
            body: JSON.stringify({
                message: 'command_volume_level',
                data: { media_stream: 'alarm_stream', command: 0 },
            }),
        });
        await clearHaPhoneAlert();
        console.log('📱 Silenced phone spoken alert (alarm stream → 0)');
        return true;
    } catch (err) {
        console.error('📱 HA stop spoken alert error:', err.message);
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

/** Toggle the phone-push helper from the Mac (keeps phone + menu in sync). */
async function setHaPushEnabled(on) {
    if (!isConfigured()) return false;
    const entity = pushEntityId();
    const domain = entity.split('.')[0];
    const service = on ? 'turn_on' : 'turn_off';
    try {
        const res = await fetch(`${haBase()}/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: haHeaders(),
            body: JSON.stringify({ entity_id: entity }),
        });
        return res.ok;
    } catch (err) {
        console.error('📱 HA set push state error:', err.message);
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
    isHaPushEnabled,
    setHaPushEnabled,
    subscribeHaStates,
    stopHaSpokenAlert,
    isConfigured,
    resolveNotifyTarget,
    dismissEntityId,
    pushEntityId,
    HA_CHANNEL,
    HA_ALERT_TAG,
    HA_DISMISS_ACTION,
    HA_PAUSE_ACTION,
};
