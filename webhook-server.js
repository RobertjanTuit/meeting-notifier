const express = require('express');
const log = require('./orbit-log.js');

function clientHint(req) {
    return req.headers['cf-connecting-ip']
        || String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || 'local';
}

/**
 * Local webhook receiver for Google Calendar push, ClickUp task events, and future Datadog.
 * Expose via Nabu Casa / Cloudflare tunnel to the public URLs configured in Settings.
 */
function startWebhookServer({ port = 3921, onGoogleCalendarPush, onClickUpWebhook } = {}) {
    const app = express();

    app.use((req, res, next) => {
        const from = clientHint(req);
        log.webhook(`${req.method} ${req.path} ← ${from}`);
        next();
    });

    app.post('/orbit/webhook/google-calendar', express.json({ limit: '1mb' }), (req, res) => {
        res.status(200).send('OK');
        onGoogleCalendarPush?.(req.headers, req.body);
    });

    app.post('/orbit/webhook/clickup', express.json({
        limit: '1mb',
        verify: (req, _res, buf) => {
            req.rawBody = buf.toString('utf8');
        },
    }), (req, res) => {
        res.status(200).send('OK');
        Promise.resolve(onClickUpWebhook?.({
            headers: req.headers,
            rawBody: req.rawBody || JSON.stringify(req.body),
            body: req.body,
        })).catch((err) => log.webhookWarn(`ClickUp handler error: ${err.message}`));
    });

    app.get('/orbit/webhook/health', (_req, res) => {
        res.json({ ok: true, service: 'orbit-webhooks' });
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => {
            log.webhook(`Listening on http://127.0.0.1:${port}`);
            resolve(server);
        });
        server.on('error', reject);
    });
}

module.exports = { startWebhookServer };
