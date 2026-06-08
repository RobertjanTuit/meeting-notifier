const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Google Calendar push notifications via events.watch (requires public HTTPS webhook). */
class CalendarWatchManager {
    constructor({ calendarApi, dataDir, onChange }) {
        this.calendarApi = calendarApi;
        this.dataDir = dataDir;
        this.onChange = onChange;
        this._channels = [];
        this._renewTimer = null;
    }

    _statePath() {
        return path.join(this.dataDir, 'google-watch-state.json');
    }

    _loadState() {
        try {
            return JSON.parse(fs.readFileSync(this._statePath(), 'utf8'));
        } catch {
            return { channels: [] };
        }
    }

    _saveState(state) {
        fs.writeFileSync(this._statePath(), `${JSON.stringify(state, null, 2)}\n`);
    }

    async stop() {
        if (this._renewTimer) {
            clearTimeout(this._renewTimer);
            this._renewTimer = null;
        }
        const state = this._loadState();
        for (const ch of state.channels) {
            try {
                await this.calendarApi.channels.stop({ requestBody: { id: ch.id, resourceId: ch.resourceId } });
            } catch {
                // channel may already be expired
            }
        }
        this._channels = [];
        this._saveState({ channels: [] });
    }

    async start({ calendarIds, webhookUrl }) {
        await this.stop();
        if (!webhookUrl || !calendarIds?.length) return;

        const channels = [];
        let earliestExpiry = Infinity;

        for (const calendarId of calendarIds) {
            const id = crypto.randomUUID();
            try {
                const res = await this.calendarApi.events.watch({
                    calendarId,
                    requestBody: {
                        id,
                        type: 'web_hook',
                        address: webhookUrl,
                    },
                });
                const exp = Number(res.data.expiration || 0);
                channels.push({
                    calendarId,
                    id,
                    resourceId: res.data.resourceId,
                    expiration: exp,
                });
                if (exp > 0) earliestExpiry = Math.min(earliestExpiry, exp);
                console.log(`✓ Calendar push watch registered: ${calendarId}`);
            } catch (err) {
                console.error(`Calendar watch failed for ${calendarId}:`, err.message);
            }
        }

        this._channels = channels;
        this._saveState({ channels });

        if (earliestExpiry < Infinity) {
            const renewIn = Math.max(60000, earliestExpiry - Date.now() - 3600000);
            this._renewTimer = setTimeout(() => {
                this.start({ calendarIds, webhookUrl }).catch((e) => console.error('Calendar watch renew:', e.message));
            }, renewIn);
        }
    }

    handlePush(headers) {
        const state = headers['x-goog-resource-state'] || headers['X-Goog-Resource-State'];
        if (state === 'sync') return;
        console.log(`📅 Calendar push notification (${state}) — refreshing`);
        if (this.onChange) this.onChange(headers);
    }
}

module.exports = { CalendarWatchManager };
