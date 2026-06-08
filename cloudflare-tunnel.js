const { spawn, execSync } = require('child_process');
const fs = require('fs');
const log = require('./orbit-log.js');

const WEBHOOK_PATHS = {
    googleCalendar: '/orbit/webhook/google-calendar',
    clickup: '/orbit/webhook/clickup',
    health: '/orbit/webhook/health',
};

function normalizeHostname(hostname) {
    return String(hostname || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
}

function buildPublicUrl(hostname, pathname = '') {
    const host = normalizeHostname(hostname);
    if (!host) return '';
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `https://${host}${path}`;
}

function buildWebhookUrls(hostname) {
    return {
        googleCalendar: buildPublicUrl(hostname, WEBHOOK_PATHS.googleCalendar),
        clickup: buildPublicUrl(hostname, WEBHOOK_PATHS.clickup),
        health: buildPublicUrl(hostname, WEBHOOK_PATHS.health),
    };
}

async function checkPublicTunnelHealth(hostname, { timeoutMs = 10000 } = {}) {
    const host = normalizeHostname(hostname);
    if (!host) return { ok: false, error: 'Set the public hostname first' };

    const url = buildWebhookUrls(host).health;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
        if (!body?.ok) return { ok: false, url, error: 'Unexpected health response' };
        return { ok: true, url, body, checkedAt: Date.now() };
    } catch (err) {
        return { ok: false, url, error: err.message || String(err) };
    }
}

function findCloudflaredBinary() {
    const candidates = [
        process.env.CLOUDFLARED_PATH,
        'cloudflared',
        '/opt/homebrew/bin/cloudflared',
        '/usr/local/bin/cloudflared',
    ].filter(Boolean);

    for (const bin of candidates) {
        try {
            if (bin.includes('/')) {
                if (fs.existsSync(bin)) return bin;
            } else {
                const resolved = execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim();
                if (resolved) return resolved;
            }
        } catch {
            // try next candidate
        }
    }
    return null;
}

class CloudflareTunnelManager {
    constructor() {
        this.proc = null;
        this.status = 'stopped';
        this.lastError = null;
        this.startedAt = null;
    }

    getStatus() {
        return {
            status: this.status,
            running: Boolean(this.proc && !this.proc.killed),
            lastError: this.lastError,
            startedAt: this.startedAt,
            binary: findCloudflaredBinary(),
        };
    }

    async start({ token } = {}) {
        if (!token) throw new Error('CLOUDFLARE_TUNNEL_TOKEN is not set');
        if (this.proc && !this.proc.killed) {
            this.status = 'running';
            log.tunnel('cloudflared already running');
            return this.getStatus();
        }

        const bin = findCloudflaredBinary();
        if (!bin) {
            throw new Error('cloudflared not found. Install with: brew install cloudflared');
        }

        this.lastError = null;
        this.status = 'starting';
        log.tunnel(`Launching cloudflared (${bin})…`);

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err) => {
                if (settled) return;
                settled = true;
                if (err) {
                    this.status = 'error';
                    this.lastError = err.message;
                    reject(err);
                } else {
                    this.status = 'running';
                    resolve(this.getStatus());
                }
            };

            this.proc = spawn(bin, ['tunnel', 'run', '--token', token], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env },
            });

            const onData = (chunk) => {
                const line = chunk.toString().trim();
                if (!line) return;
                log.tunnel(`cloudflared: ${line}`);
                if (/error|failed/i.test(line)) {
                    this.lastError = line;
                }
            };

            this.proc.stdout.on('data', onData);
            this.proc.stderr.on('data', onData);

            this.proc.on('error', (err) => {
                this.proc = null;
                log.tunnelError(`cloudflared process error: ${err.message}`);
                finish(err);
            });

            this.proc.on('exit', (code, signal) => {
                this.proc = null;
                if (this.status === 'running' || this.status === 'starting') {
                    this.status = code === 0 ? 'stopped' : 'error';
                    if (code === 0) {
                        log.tunnel('cloudflared disconnected');
                    } else {
                        this.lastError = this.lastError || `cloudflared exited (${signal || code})`;
                        log.tunnelError(`cloudflared exited (${signal || code})`);
                    }
                }
            });

            setTimeout(() => {
                if (this.proc && !this.proc.killed) {
                    this.startedAt = Date.now();
                    finish(null);
                } else if (!settled) {
                    finish(new Error(this.lastError || 'cloudflared failed to start'));
                }
            }, 2500);
        });
    }

    stop() {
        if (this.proc) {
            log.tunnel('Sending SIGTERM to cloudflared…');
            this.proc.kill('SIGTERM');
            this.proc = null;
        }
        this.status = 'stopped';
        this.startedAt = null;
    }
}

module.exports = {
    CloudflareTunnelManager,
    findCloudflaredBinary,
    buildPublicUrl,
    buildWebhookUrls,
    checkPublicTunnelHealth,
    WEBHOOK_PATHS,
};
