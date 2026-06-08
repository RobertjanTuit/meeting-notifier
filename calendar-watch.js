const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./orbit-log.js');

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
        log.calendar('Push watch channels stopped');
    }

    async start({ calendarIds, webhookUrl, resolveCalendarApi } = {}) {
        await this.stop();
        if (!webhookUrl || !calendarIds?.length) return;
        this._resolveCalendarApi = resolveCalendarApi;

        const channels = [];
        let earliestExpiry = Infinity;

        for (const calendarId of calendarIds) {
            const id = crypto.randomUUID();
            const api = resolveCalendarApi
                ? await resolveCalendarApi(calendarId)
                : this.calendarApi;
            if (!api) continue;
            try {
                const res = await api.events.watch({
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
                log.calendar(`Push watch registered for ${calendarId} → ${webhookUrl}`);
            } catch (err) {
                log.calendarError(`Watch failed for ${calendarId}: ${err.message}`);
            }
        }

        this._channels = channels;
        this._saveState({ channels });

        if (earliestExpiry < Infinity) {
            const renewIn = Math.max(60000, earliestExpiry - Date.now() - 3600000);
            log.calendar(`Watch renew scheduled in ${Math.round(renewIn / 60000)} min`);
            this._renewTimer = setTimeout(() => {
                log.calendar('Renewing push watch channels…');
                this.start({
                    calendarIds,
                    webhookUrl,
                    resolveCalendarApi: this._resolveCalendarApi,
                }).catch((e) => log.calendarError(`Watch renew failed: ${e.message}`));
            }, renewIn);
        }
    }

    handlePush(headers, body) {
        const state = headers['x-goog-resource-state'] || headers['X-Goog-Resource-State'] || 'unknown';
        const resourceId = headers['x-goog-resource-id'] || headers['X-Goog-Resource-Id'] || '';
        if (state === 'sync') {
            log.calendar(`Push received (sync) — channel verified${resourceId ? ` [${resourceId.slice(0, 8)}…]` : ''}`);
            return;
        }
        log.calendar(`Push received (${state}) — refreshing calendars${resourceId ? ` [${resourceId.slice(0, 8)}…]` : ''}`);
        if (body && Object.keys(body).length) log.calendar('Push body', body);
        if (this.onChange) this.onChange(headers);
    }
}

module.exports = { CalendarWatchManager };
