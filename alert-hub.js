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

    async maybePush({ source, title, message, urgent, url, meeting }) {
        const cfg = this.getSourceDelivery(source);
        if (!cfg.push || !this.isPushEnabled()) return false;
        if (source === 'meetings') {
            if (!this.shouldPushForMeeting(meeting)) return false;
        } else if (!this.isAwayFromMac()) {
            return false;
        }
        const { sendHaPush } = require('./push.js');
        await sendHaPush({ title, message, urgent, url });
        return true;
    }

    async deliver({ source, title, message, urgent = false, url, meeting, meta }) {
        if (this.inQuietHours()) {
            console.log(`🔕 Alert skipped (quiet hours): [${source}] ${title}`);
            return { delivered: false, reason: 'quiet-hours' };
        }

        const cfg = this.getSourceDelivery(source);
        const times = urgent ? 2 : 1;

        if (this.notifier?.pulseAlert && (cfg.lights || cfg.sound || (cfg.flash && urgent))) {
            await this.notifier.pulseAlert(times, 600, {
                lights: cfg.lights,
                sound: cfg.sound,
                flash: cfg.flash && urgent,
            });
        }

        await this.maybePush({ source, title, message, urgent, url, meeting });

        if (source === 'clickup') {
            this.lastClickUpSummary = { title, message, at: Date.now(), meta };
            this.emit('clickup-alert', this.lastClickUpSummary);
        }

        console.log(`🔔 [${source}] ${title} — ${message}`);
        this.emit('delivered', { source, title, message, urgent, meta });
        return { delivered: true };
    }

    async deliverMeeting({ kind, meeting, title, message, urgent }) {
        if (this.inQuietHours()) {
            console.log(`🔕 Meeting alert skipped (quiet hours): ${title}`);
            return { delivered: false, reason: 'quiet-hours' };
        }

        const cfg = this.getSourceDelivery('meetings');
        const pulseByKind = {
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
            });
        }

        const pushed = await this.maybePush({ source: 'meetings', title, message, urgent, meeting });
        console.log(`🔔 [meetings] ${title} — ${message}`);
        this.emit('delivered', { source: 'meetings', title, message, urgent, kind, meeting });
        return { delivered: true, pushed };
    }
}

module.exports = { AlertHub };
