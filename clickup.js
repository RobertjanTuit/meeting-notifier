const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { resolveClickUpConfig } = require('./clickup-config.js');
const log = require('./orbit-log.js');

const WEBHOOK_EVENTS = ['taskCommentPosted', 'taskAssigneeUpdated', 'taskTagUpdated'];

function verifyClickUpSignature(rawBody, signature, secret) {
    if (!signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    try {
        return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
        return provided === expected;
    }
}

class ClickUpClient {
    constructor({ baseUrl, token }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = token;
    }

    async request(apiPath, { method = 'GET', body } = {}) {
        const url = `${this.baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
        const res = await fetch(url, {
            method,
            headers: {
                Authorization: this.token,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!res.ok) {
            const msg = data.err || data.message || data.ECODE || res.statusText || `HTTP ${res.status}`;
            throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
        return data;
    }

    getUser() { return this.request('/api/v2/user'); }
    getTeams() { return this.request('/api/v2/team'); }
    getChannels(workspaceId) {
        return this.request(`/api/v3/workspaces/${workspaceId}/chat/channels?limit=100`);
    }
    getMessages(workspaceId, channelId, cursor) {
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=25` : '?limit=25';
        return this.request(`/api/v3/workspaces/${workspaceId}/chat/channels/${channelId}/messages${q}`);
    }
    async getTaggedUsers(taggedUsersUrl) {
        if (!taggedUsersUrl) return [];
        const apiPath = taggedUsersUrl.startsWith('http')
            ? taggedUsersUrl.replace(this.baseUrl, '')
            : taggedUsersUrl;
        try {
            const data = await this.request(apiPath);
            return data.data || data.tagged_users || data.users || [];
        } catch {
            return [];
        }
    }

    createWebhook(teamId, { endpoint, events }) {
        return this.request(`/api/v2/team/${teamId}/webhook`, {
            method: 'POST',
            body: { endpoint, events },
        });
    }

    listWebhooks(teamId) {
        return this.request(`/api/v2/team/${teamId}/webhook`);
    }

    deleteWebhook(webhookId) {
        return this.request(`/api/v2/webhook/${webhookId}`, { method: 'DELETE' });
    }
}

class ClickUpWatcher extends EventEmitter {
    constructor({ configStore, alertHub, dataDir }) {
        super();
        this.configStore = configStore;
        this.alertHub = alertHub;
        this.dataDir = dataDir;
        this._timer = null;
        this._running = false;
    }

    _seenPath(environment) {
        return path.join(this.dataDir, `clickup-seen-${environment || 'staging'}.json`);
    }

    _loadSeen(environment) {
        try { return new Set(JSON.parse(fs.readFileSync(this._seenPath(environment), 'utf8'))); }
        catch { return new Set(); }
    }

    _saveSeen(environment, seen) {
        fs.writeFileSync(this._seenPath(environment), `${JSON.stringify([...seen].slice(-5000), null, 2)}\n`);
    }

    _rules() { return this.configStore.getSection('clickup'); }

    _client(overrides = {}) {
        const section = this._rules();
        const rules = section.rules || {};
        const cfg = resolveClickUpConfig({
            CLICKUP_ENV: overrides.env ?? section.env,
            CLICKUP_API_TOKEN: overrides.apiToken ?? section.apiToken,
            CLICKUP_WORKSPACE_ID: overrides.workspaceId ?? section.workspaceId,
            CLICKUP_API_BASE_URL: section.apiBaseUrl,
            workspaceId: overrides.workspaceId ?? rules.workspaceId,
        });
        if (!cfg.token) throw new Error('CLICKUP API token is not set — enter it above');
        if (!cfg.workspaceId) throw new Error('CLICKUP workspace ID is not set');
        return { client: new ClickUpClient(cfg), cfg };
    }

    _memberItems(team) {
        return (team?.members || []).map((m) => {
            const user = m.user || m;
            const id = String(user.id || m.userid || '');
            if (!id) return null;
            return {
                id,
                label: user.username || user.email || id,
                sublabel: user.email || user.username || '',
            };
        }).filter(Boolean);
    }

    _memberLabel(userId) {
        const id = String(userId);
        const cached = this._membersCache?.items?.find((m) => String(m.id) === id);
        return cached?.label || `User ${id}`;
    }

    getWatchedPeopleLabels() {
        const rules = this._rules().rules || {};
        return (rules.watchPeople || []).map((userId) => ({
            id: String(userId),
            label: this._memberLabel(userId),
        }));
    }

    async warmMemberCache() {
        await this.browseMembers({ search: '' });
    }

    /** Preview what a watched-person chat message alert looks like. */
    async testWatchedPersonAlert(personId) {
        if (!this.alertHub) throw new Error('Alert hub not initialized');

        const rules = this._rules().rules;
        if (!rules?.enabled) throw new Error('ClickUp is disabled in Settings');

        const id = String(personId);
        const watchIds = this._watchUserIds(rules);
        if (!watchIds.has(id)) throw new Error(`User ${id} is not on the watch list`);

        const { client, cfg } = this._client();
        try {
            await this.warmMemberCache();
        } catch {
            // names fall back to User {id}
        }
        const name = this._memberLabel(id);

        let channelName = 'team-chat';
        let channelId = '';
        try {
            const channelsRes = await client.getChannels(cfg.workspaceId);
            const channels = channelsRes.data || channelsRes.channels || [];
            if (channels[0]) {
                channelName = channels[0].name || channelName;
                channelId = String(channels[0].id || '');
            }
        } catch {
            // use fallback channel label
        }

        const message = 'Hey — can you take a quick look when you get a chance?';
        log.clickup(`Test alert — ${name} says something in #${channelName}`);

        await this.alertHub.deliver({
            source: 'clickup',
            title: `ClickUp: ${channelName}`,
            message,
            urgent: false,
            url: channelId
                ? `https://app.clickup.com/${cfg.workspaceId}/chat/r/${channelId}`
                : `https://app.clickup.com/${cfg.workspaceId}/chat`,
            meta: { reason: 'dm-from-watched-person', test: true, fromUserId: id, fromName: name },
        });
        return { name, channelName };
    }

    async browseMembers({ search = '', env, apiToken, workspaceId } = {}) {
        const { client, cfg } = this._client({ env, apiToken, workspaceId });
        const cacheKey = String(cfg.workspaceId);
        const now = Date.now();
        if (!this._membersCache || this._membersCache.teamId !== cacheKey || now - this._membersCache.at > 5 * 60 * 1000) {
            const teams = await client.getTeams();
            const team = teams.teams?.find((t) => String(t.id) === cacheKey);
            this._membersCache = {
                at: now,
                teamId: cacheKey,
                items: this._memberItems(team),
            };
        }
        let items = this._membersCache.items;
        const q = search.trim().toLowerCase();
        if (q) {
            items = items.filter(
                (i) => i.label.toLowerCase().includes(q)
                    || String(i.sublabel || '').toLowerCase().includes(q)
                    || String(i.id).includes(q),
            );
        }
        return { items, hasMore: false };
    }

    async browseTasks({ search = '', page = 0, env, apiToken, workspaceId } = {}) {
        const { client, cfg } = this._client({ env, apiToken, workspaceId });
        const data = await client.request(
            `/api/v2/team/${cfg.workspaceId}/task?page=${page}&include_closed=false&subtasks=true`,
        );
        let items = (data.tasks || []).map((t) => ({
            id: String(t.id),
            label: t.name || String(t.id),
            sublabel: [t.status?.status, t.url ? '' : ''].filter(Boolean).join('') || (t.list?.name || ''),
        }));
        const q = search.trim().toLowerCase();
        if (q) {
            items = items.filter(
                (i) => i.label.toLowerCase().includes(q) || String(i.id).includes(q),
            );
        }
        return { items, hasMore: (data.tasks || []).length >= 100 };
    }

    async testConnection() {
        const { client, cfg } = this._client();
        const user = await client.getUser();
        const teams = await client.getTeams();
        let channelCount = 0;
        try {
            const ch = await client.getChannels(cfg.workspaceId);
            channelCount = (ch.data || ch.channels || []).length;
        } catch (err) {
            console.warn('ClickUp channels:', err.message);
        }
        const u = user.user || user;
        return {
            environment: cfg.environment,
            baseUrl: cfg.baseUrl,
            workspaceId: cfg.workspaceId,
            username: u.username || u.email || u.id,
            userId: u.id,
            teamCount: (teams.teams || []).length,
            channelCount,
        };
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            log.clickup('Watcher stopped');
        }
        this._running = false;
    }

    start() {
        this.stop();
        const section = this._rules();
        const rules = section.rules;
        if (!rules?.enabled || !section.apiToken) return;

        this._running = true;
        const intervalMs = Math.max(10, Number(rules.pollIntervalSeconds) || 30) * 1000;
        const tick = () => this.poll().catch((err) => {
            log.clickupError(`Poll error: ${err.message}`);
            this.emit('error', err);
        });
        tick();
        this._timer = setInterval(tick, intervalMs);
        log.clickup(`Watcher started (${section.env || 'staging'}, poll every ${intervalMs / 1000}s)`);
    }

    restart() { this.start(); }

    _watchUserIds(rules) {
        return new Set((rules.watchPeople || []).map((p) => String(p).trim()).filter(Boolean));
    }

    _snippet(content) {
        if (!content) return '';
        return String(content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    async _shouldAlert(msg, rules, client, myUserId) {
        const r = rules.rules || {};
        const senderId = String(msg.user_id || '');
        const watchIds = this._watchUserIds(rules);

        if (r.dmFromPeople && watchIds.size && watchIds.has(senderId)) {
            return { notify: true, reason: 'dm-from-watched-person', urgent: false };
        }

        const taggedUrl = msg.links?.tagged_users;
        if (taggedUrl && (r.mentionMe || r.mentionMyGroups)) {
            const tagged = await client.getTaggedUsers(taggedUrl);
            if (r.mentionMe && myUserId) {
                const hit = tagged.some((t) => String(t.user_id || t.id || t.user?.id) === String(myUserId));
                if (hit) return { notify: true, reason: 'mention-me', urgent: true };
            }
            if (r.mentionMyGroups && tagged.some((t) => t.type === 'group' || t.group_id)) {
                return { notify: true, reason: 'mention-group', urgent: true };
            }
        }
        return { notify: false };
    }

    async poll() {
        const section = this._rules();
        const rules = section.rules;
        if (!rules?.enabled) return;

        const { client, cfg } = this._client();
        const seen = this._loadSeen(cfg.environment);
        let myUserId = rules.myUserId;
        if (!myUserId) {
            const user = await client.getUser();
            myUserId = user.user?.id || user.id;
        }

        const channelsRes = await client.getChannels(cfg.workspaceId);
        const channels = channelsRes.data || channelsRes.channels || [];
        const watchIds = new Set((rules.watchChannelIds || []).map(String));
        const targets = watchIds.size ? channels.filter((c) => watchIds.has(String(c.id))) : channels;

        for (const channel of targets) {
            const res = await client.getMessages(cfg.workspaceId, channel.id);
            const messages = res.data || res.messages || [];
            for (const msg of messages) {
                const key = `${channel.id}:${msg.id}`;
                if (seen.has(key)) continue;
                seen.add(key);

                if (Date.now() - Number(msg.date || 0) > 10 * 60 * 1000) continue;
                if (String(msg.user_id) === String(myUserId)) continue;

                const decision = await this._shouldAlert(msg, rules, client, myUserId);
                if (!decision.notify) continue;

                log.clickup(`Chat alert (${decision.reason}) in #${channel.name || channel.id}: ${this._snippet(msg.content)}`);

                await this.alertHub.deliver({
                    source: 'clickup',
                    title: `ClickUp: ${channel.name || channel.id}`,
                    message: this._snippet(msg.content) || '(no text)',
                    urgent: Boolean(decision.urgent),
                    url: `https://app.clickup.com/${cfg.workspaceId}/chat/r/${channel.id}`,
                    meta: { reason: decision.reason, messageId: msg.id },
                });
            }
        }
        this._saveSeen(cfg.environment, seen);
    }

    async _myUserId(client, rules) {
        if (rules.myUserId) return String(rules.myUserId);
        const user = await client.getUser();
        const id = user.user?.id || user.id;
        if (id && this.configStore) {
            this.configStore.saveSection('clickup', { rules: { myUserId: id } });
        }
        return String(id);
    }

    _taskUrl(workspaceId, taskId) {
        return `https://app.clickup.com/t/${taskId}`;
    }

    _historyItems(body) {
        return Array.isArray(body.history_items) ? body.history_items : [];
    }

    _commentText(item) {
        const c = item.comment || item.data?.comment || item;
        return String(c.text_content || c.comment_text || c.text || '').trim();
    }

    _assigneeIds(item) {
        const after = item.after || item.data?.after || {};
        const assignees = after.assignees || after.assignee || item.assignees || [];
        const list = Array.isArray(assignees) ? assignees : [assignees];
        return list.map((a) => String(a?.id || a?.user_id || a)).filter(Boolean);
    }

    _tagNames(item, body) {
        const after = item.after || item.data?.after || body.after || {};
        const tags = after.tags || item.tags || [];
        return (Array.isArray(tags) ? tags : []).map((t) => String(t.name || t.tag || t).toLowerCase());
    }

    _mentionsUser(text, userId, watchIds) {
        const hay = String(text).toLowerCase();
        if (userId && (hay.includes(`@${userId}`) || hay.includes(`user:${userId}`))) return true;
        for (const id of watchIds) {
            if (hay.includes(`@${id}`) || hay.includes(`user:${id}`)) return true;
        }
        return false;
    }

    async _evaluateWebhookEvent(body, rules, myUserId) {
        const r = rules.rules || {};
        const watchIds = this._watchUserIds(rules);
        const event = body.event;
        const taskId = body.task_id || body.task?.id;
        const taskName = body.task?.name || body.task_name || taskId || 'Task';
        const watchTasks = new Set((rules.watchTaskIds || []).map((id) => String(id)).filter(Boolean));
        if (watchTasks.size && taskId && !watchTasks.has(String(taskId))) {
            return { notify: false, skipped: 'task-not-watched' };
        }

        if (event === 'taskAssigneeUpdated' && r.taskAssignedToMe) {
            for (const item of this._historyItems(body)) {
                if (this._assigneeIds(item).includes(myUserId)) {
                    return {
                        notify: true,
                        reason: 'task-assigned-to-me',
                        urgent: true,
                        title: `ClickUp: Assigned — ${taskName}`,
                        message: 'You were assigned to a task',
                        taskId,
                    };
                }
            }
        }

        if (event === 'taskTagUpdated') {
            const watchTags = new Set((r.taskTagMatch || []).map((t) => String(t).toLowerCase()).filter(Boolean));
            if (watchTags.size) {
                for (const item of this._historyItems(body)) {
                    const tags = this._tagNames(item, body);
                    if (tags.some((t) => watchTags.has(t))) {
                        return {
                            notify: true,
                            reason: 'task-tag-match',
                            urgent: true,
                            title: `ClickUp: Tag — ${taskName}`,
                            message: `Tag matched: ${tags.join(', ')}`,
                            taskId,
                        };
                    }
                }
            }
        }

        if (event === 'taskCommentPosted' && r.taskCommentMention) {
            for (const item of this._historyItems(body)) {
                const text = this._commentText(item);
                const authorId = String(item.user?.id || item.user_id || '');
                if (watchIds.size && r.dmFromPeople && watchIds.has(authorId)) {
                    return {
                        notify: true,
                        reason: 'task-comment-from-watched-person',
                        urgent: false,
                        title: `ClickUp: Comment — ${taskName}`,
                        message: this._snippet(text) || '(comment)',
                        taskId,
                    };
                }
                if (this._mentionsUser(text, myUserId, watchIds)) {
                    return {
                        notify: true,
                        reason: 'task-comment-mention',
                        urgent: true,
                        title: `ClickUp: Mention — ${taskName}`,
                        message: this._snippet(text) || '(comment)',
                        taskId,
                    };
                }
            }
        }

        return { notify: false };
    }

    _normalizeWebhookEndpoint(url) {
        return String(url || '').trim().replace(/\/+$/, '');
    }

    async _adoptExistingWebhook(client, cfg, endpoint) {
        const url = this._normalizeWebhookEndpoint(endpoint);
        const list = await client.listWebhooks(cfg.workspaceId);
        const match = (list.webhooks || []).find(
            (wh) => this._normalizeWebhookEndpoint(wh.endpoint) === url,
        );
        if (!match?.id || !match?.secret) return null;

        this.configStore.saveSection('clickup', {
            rules: {
                webhookUrl: url,
                webhookId: match.id,
                webhookSecret: match.secret,
            },
        });
        this.configStore.reloadIntoProcess();

        log.clickup(`Webhooks reconciled from ClickUp (${cfg.environment}) → ${url}`);
        if (match.health?.status === 'failing') {
            log.clickupWarn(
                `ClickUp reports webhook delivery failing (${match.health.fail_count || 0} failures) — check tunnel health`,
            );
        }
        return {
            webhookId: match.id,
            endpoint: url,
            events: match.events,
            environment: cfg.environment,
            adopted: true,
            health: match.health,
        };
    }

    async registerWebhooks(endpoint) {
        const url = String(endpoint || '').trim();
        if (!url) throw new Error('Webhook URL is required');
        if (!url.startsWith('https://')) throw new Error('ClickUp requires an HTTPS webhook URL (use a tunnel)');

        const { client, cfg } = this._client();
        const section = this._rules();
        const rules = section.rules || {};
        const events = WEBHOOK_EVENTS;

        const adopted = await this._adoptExistingWebhook(client, cfg, url);
        if (adopted) return adopted;

        if (rules.webhookId) {
            try { await client.deleteWebhook(rules.webhookId); } catch { /* may already be removed */ }
        }

        try {
            const res = await client.createWebhook(cfg.workspaceId, { endpoint: url, events });
            const wh = res.webhook || res;
            const webhookId = wh.id || res.id;
            const webhookSecret = wh.secret;
            if (!webhookId || !webhookSecret) {
                throw new Error('ClickUp did not return webhook id/secret');
            }

            this.configStore.saveSection('clickup', {
                rules: {
                    webhookUrl: url,
                    webhookId,
                    webhookSecret,
                },
            });
            this.configStore.reloadIntoProcess();

            log.clickup(`Webhooks registered (${cfg.environment}) → ${url}`);
            log.clickup(`  Events: ${events.join(', ')}`);
            return { webhookId, endpoint: url, events, environment: cfg.environment };
        } catch (err) {
            if (/already exists/i.test(err.message)) {
                const retry = await this._adoptExistingWebhook(client, cfg, url);
                if (retry) return retry;
            }
            throw err;
        }
    }

    async handleWebhook({ headers, rawBody, body }) {
        const section = this._rules();
        const rules = section.rules || {};
        const event = body?.event || 'unknown';
        const taskId = body?.task_id || body?.task?.id || '';
        log.clickup(`Webhook received: ${event}${taskId ? ` (task ${taskId})` : ''}`);

        if (!rules.enabled) {
            log.clickup('Webhook ignored — ClickUp disabled in settings');
            return { ok: true, skipped: 'disabled' };
        }

        const secret = rules.webhookSecret;
        const signature = headers['x-signature'] || headers['X-Signature'];
        if (!verifyClickUpSignature(rawBody, signature, secret)) {
            log.clickupWarn('Webhook rejected — invalid signature');
            return { ok: false, error: 'invalid-signature' };
        }

        const { client, cfg } = this._client();
        const myUserId = await this._myUserId(client, rules);
        const seen = this._loadSeen(cfg.environment);

        const items = this._historyItems(body);
        const historyId = items.map((i) => i.id).filter(Boolean).join(',') || body.task_id || body.event;
        const dedupKey = `wh:${body.webhook_id || 'wh'}:${historyId}`;
        if (seen.has(dedupKey)) {
            log.clickup(`Webhook duplicate ignored: ${dedupKey}`);
            return { ok: true, skipped: 'duplicate' };
        }
        seen.add(dedupKey);

        const decision = await this._evaluateWebhookEvent(body, rules, myUserId);
        if (decision.notify) {
            log.clickup(`Webhook alert (${decision.reason}): ${decision.title} — ${decision.message}`);
            await this.alertHub.deliver({
                source: 'clickup',
                title: decision.title,
                message: decision.message,
                urgent: Boolean(decision.urgent),
                url: decision.taskId ? this._taskUrl(cfg.workspaceId, decision.taskId) : undefined,
                meta: { reason: decision.reason, event: body.event, taskId: decision.taskId },
            });
        }

        this._saveSeen(cfg.environment, seen);
        if (!decision.notify) log.clickup(`Webhook processed — no alert (${event})`);
        return { ok: true, notified: Boolean(decision.notify) };
    }
}

module.exports = { ClickUpClient, ClickUpWatcher, verifyClickUpSignature, WEBHOOK_EVENTS };
