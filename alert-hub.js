const EventEmitter = require('events');

const DEFAULT_SOURCE = {
    lights: true,
    sound: true,
    flash: false,
    push: true,
};

class AlertHub extends EventEmitter {
    /**
     * @param {object} opts
     * @param {import('./config-store').createConfigStore extends Function ? ReturnType<import('./config-store').createConfigStore> : object} opts.configStore
     * @param {import('./index').OrbitNotifier} opts.notifier
     * @param {() => boolean} opts.isAwayFromMac
     * @param {() => boolean} opts.isPushEnabled
     * @param {(meeting: object) => boolean} [opts.shouldPushForMeeting]
     */
    constructor({ configStore, notifier, isAwayFromMac, isPushEnabled, shouldPushForMeeting }) {
        super();
        this.configStore = configStore;
        this.notifier = notifier;
        this.isAwayFromMac = isAwayFromMac;
        this.isPushEnabled = isPushEnabled;
        this.shouldPushForMeeting = shouldPushForMeeting || (() => true);
        this.lastClickUpSummary = null;
        // Content-based de-duplication: the same logical alert (even if pushed
        // multiple times by polling + webhook, or webhook retries) only fires once
        // within the window.
        this._recentDeliveries = new Map();
        this._dedupWindowMs = 60 * 60 * 1000;
    }

    _dedupKey({ source, title, message, meta, kind, meeting }) {
        if (source === 'meetings') {
            const day = new Date().toISOString().slice(0, 10);
            return `meetings|${kind || ''}|${meeting?.id || meeting?.iCalUID || title}|${day}`;
        }
        if (source === 'clickup') {
            const id = meta?.messageId || meta?.taskId || meta?.event || '';
            return `clickup|${meta?.reason || ''}|${id}|${title}|${message}`;
        }
        return `${source}|${title}|${message}|${meta?.url || ''}`;
    }

    /** True if this alert was already delivered within the dedup window. */
    _isDuplicate(key) {
        const now = Date.now();
        for (const [k, ts] of this._recentDeliveries) {
            if (now - ts > this._dedupWindowMs) this._recentDeliveries.delete(k);
        }
        if (this._recentDeliveries.has(key)) return true;
        this._recentDeliveries.set(key, now);
        return false;
    }

    getAlertsConfig() {
        try {
            return this.configStore.getSection('alerts');
        } catch {
            return { quietHours: null, sources: {} };
        }
    }

    getSourceDelivery(source) {
        const alerts = this.getAlertsConfig();
        return { ...DEFAULT_SOURCE, ...(alerts.sources?.[source] || {}) };
    }

    inQuietHours() {
        const { quietHours } = this.getAlertsConfig();
        if (!quietHours?.start || !quietHours?.end) return false;
        const parse = (hhmm) => {
            const [h, m] = String(hhmm).split(':').map((n) => Number(n) || 0);
            return h * 60 + m;
        };
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const start = parse(quietHours.start);
        const end = parse(quietHours.end);
        if (end <= start) return mins >= start || mins < end;
        return mins >= start && mins < end;
    }

    async maybePush({ source, title, message, urgent, url, meeting, spoken }) {
        const cfg = this.getSourceDelivery(source);
        if (!cfg.push || !this.isPushEnabled()) return false;
        if (source === 'meetings') {
            if (!this.shouldPushForMeeting(meeting)) return false;
        } else if (!this.isAwayFromMac()) {
            return false;
        }
        const { sendHaPush } = require('./push.js');
        await sendHaPush({ title, message, urgent, url, spoken });
        return true;
    }

    async deliver({ source, title, message, urgent = false, url, meeting, meta, spoken }) {
        if (this.inQuietHours()) {
            console.log(`🔕 Alert skipped (quiet hours): [${source}] ${title}`);
            return { delivered: false, reason: 'quiet-hours' };
        }

        const dedupKey = this._dedupKey({ source, title, message, meta });
        if (this._isDuplicate(dedupKey)) {
            console.log(`♻️ Duplicate alert suppressed: [${source}] ${title}`);
            return { delivered: false, reason: 'duplicate' };
        }

        const cfg = this.getSourceDelivery(source);
        const times = urgent ? 2 : 1;

        if (this.notifier?.pulseAlert && (cfg.lights || cfg.sound || (cfg.flash && urgent))) {
            await this.notifier.pulseAlert(times, 600, {
                lights: cfg.lights,
                sound: cfg.sound,
                flash: cfg.flash && urgent,
                soundSource: source,
            });
        }

        await this.maybePush({ source, title, message, urgent, url, meeting, spoken });

        if (source === 'clickup') {
            this.lastClickUpSummary = { title, message, at: Date.now(), meta };
            this.emit('clickup-alert', this.lastClickUpSummary);
        }

        const groupKey = meta?.taskId
            ? `clickup:task:${meta.taskId}`
            : (source === 'clickup' && url ? `clickup:url:${url}` : undefined);
        console.log(`🔔 [${source}] ${title} — ${message}`);
        this.emit('delivered', { source, title, message, urgent, meta, url, groupKey });
        return { delivered: true };
    }

    async deliverMeeting({ kind, meeting, title, message, urgent, quick = false }) {
        if (this.inQuietHours()) {
            console.log(`🔕 Meeting alert skipped (quiet hours): ${title}`);
            return { delivered: false, reason: 'quiet-hours' };
        }

        const cfg = this.getSourceDelivery('meetings');
        const pulseByKind = quick ? {
            '5min': [1, 500],
            '1min': [1, 500],
            start: [2, 600],
            nag: [1, 500],
        } : {
            '5min': [1, 2000],
            '1min': [2, 1500],
            start: [5, 1000],
            nag: [2, 600],
        };
        const [times, duration] = pulseByKind[kind] || [1, 1000];

        if (this.notifier?.pulseAlert && (cfg.lights || cfg.sound || cfg.flash)) {
            await this.notifier.pulseAlert(times, duration, {
                lights: cfg.lights,
                sound: cfg.sound,
                flash: cfg.flash,
                soundSource: 'meetings',
            });
        }

        const url = meeting?.videoEntryPoint?.uri;
        const pushed = await this.maybePush({ source: 'meetings', title, message, urgent, meeting });
        const groupKey = `meetings:${meeting?.id || meeting?.iCalUID || title}`;
        console.log(`🔔 [meetings] ${title} — ${message}`);
        this.emit('delivered', { source: 'meetings', title, message, urgent, kind, meeting, url, groupKey });
        return { delivered: true, pushed };
    }
}

module.exports = { AlertHub };
