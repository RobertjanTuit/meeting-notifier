/**
 * Pick a listening output by name priority and point Wave Link Main at it.
 * Arctis USB-port UIDs change; matching is by name, then USB over Bluetooth.
 */
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    resolveSwitchAudioSource,
    listAudioDevicesJson,
    getCurrentDevice,
    isWaveLinkRunning,
    fixAudio,
} = require('./audio-fix.js');

const DEFAULT_AUDIO_PRIORITY = [
    'Arctis Nova Pro Wireless',
    'Pixel Buds',
    'MacBook Pro Speakers',
];
const WAVE_LINK_PORTS = [1884, 1885, 1886, 1887, 1888, 1889, 1890, 1891, 1892, 1893];
const WAVE_LINK_ORIGIN = 'streamdeck://';
const IGNORE_NAME = [
    /blackhole/i,
    /prism lens/i,
    /^ndi audio$/i,
    /zoomaudio/i,
    /wave link/i,
    /^usb audio$/i,
];

function normalizePriority(priority) {
    const list = Array.isArray(priority) ? priority : String(priority || '').split('\n');
    return list.map((s) => String(s || '').trim()).filter(Boolean);
}

function isIgnoredName(name) {
    const n = String(name || '');
    return IGNORE_NAME.some((re) => re.test(n));
}

function deviceScore(device, priority) {
    const name = String(device.name || '');
    if (!name || isIgnoredName(name)) return null;
    const lower = name.toLowerCase();
    const uid = String(device.id || device.uid || '');
    const usbPenalty = /AppleUSBAudioEngine/i.test(uid) ? 0 : 1;
    for (let i = 0; i < priority.length; i++) {
        const needle = priority[i].toLowerCase();
        if (needle && lower.includes(needle)) return i * 10 + usbPenalty;
    }
    return null;
}

function pickPreferredDevice(devices, { priority, currentId } = {}) {
    const pri = normalizePriority(priority);
    const ranked = [];
    for (const device of devices || []) {
        const score = deviceScore(device, pri);
        if (score == null) continue;
        ranked.push({ device, score });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => a.score - b.score);
    const bestScore = ranked[0].score;
    const tied = ranked.filter((r) => r.score === bestScore);
    if (currentId) {
        const keep = tied.find((r) => r.device.id === currentId || r.device.uid === currentId);
        if (keep) return keep.device;
    }
    return tied[0].device;
}

function encodeWsFrame(payload) {
    const data = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    let header;
    if (data.length < 126) {
        header = Buffer.from([0x81, 0x80 | data.length]);
    } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
    }
    return Buffer.concat([header, mask, masked]);
}

function takeWsFrames(buf) {
    const frames = [];
    let offset = 0;
    let closed = false;
    while (buf.length - offset >= 2) {
        const b1 = buf[offset];
        const b2 = buf[offset + 1];
        const opcode = b1 & 0x0f;
        let len = b2 & 0x7f;
        let hdr = 2;
        if (len === 126) {
            if (buf.length - offset < 4) break;
            len = buf.readUInt16BE(offset + 2);
            hdr = 4;
        } else if (len === 127) {
            if (buf.length - offset < 10) break;
            len = Number(buf.readBigUInt64BE(offset + 2));
            hdr = 10;
        }
        const masked = (b2 & 0x80) !== 0;
        const maskLen = masked ? 4 : 0;
        if (buf.length - offset < hdr + maskLen + len) break;
        let payload = buf.subarray(offset + hdr + maskLen, offset + hdr + maskLen + len);
        if (masked) {
            const mask = buf.subarray(offset + hdr, offset + hdr + 4);
            payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        }
        offset += hdr + maskLen + len;
        if (opcode === 1) frames.push(payload.toString('utf8'));
        if (opcode === 8) {
            closed = true;
            break;
        }
    }
    return { frames, closed, rest: buf.subarray(offset) };
}

function tcpOpen(port, timeoutMs = 400) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('timeout'));
        }, timeoutMs);
        socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function findWaveLinkPort() {
    for (const port of WAVE_LINK_PORTS) {
        try {
            const socket = await tcpOpen(port, 250);
            socket.destroy();
            return port;
        } catch {
            // try next
        }
    }
    return null;
}

const WAVE_LINK_CONNECTION_ERROR = /ECONN|EPIPE|ETIMEDOUT|timed out|RPC port not found|handshake failed|socket closed/i;

function isWaveLinkConnectionError(err) {
    return WAVE_LINK_CONNECTION_ERROR.test(err?.code || '') || WAVE_LINK_CONNECTION_ERROR.test(err?.message || String(err));
}

async function waveLinkSession(fn, { timeoutMs = 4000 } = {}) {
    const port = await findWaveLinkPort();
    if (!port) throw new Error('Wave Link RPC port not found');

    const key = crypto.randomBytes(16).toString('base64');
    const socket = await tcpOpen(port, 800);
    const handshake = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: ${WAVE_LINK_ORIGIN}`,
        '',
        '',
    ].join('\r\n');

    let buf = Buffer.alloc(0);
    let upgraded = false;
    let nextId = 1;
    let failure = null;
    const pending = new Map();
    let onUpgrade = { resolve: () => {}, reject: () => {} };

    // A reset mid-session (Wave Link half-alive after a crash, 2026-10-15) must fail every
    // outstanding call; otherwise the router's inFlight flag never clears and routing stops.
    function failAll(err) {
        failure = failure || err;
        onUpgrade.reject(failure);
        for (const wait of pending.values()) {
            clearTimeout(wait.timer);
            wait.reject(failure);
        }
        pending.clear();
    }
    socket.on('error', failAll);
    socket.on('close', () => failAll(new Error('Wave Link socket closed')));

    function send(method, params = {}) {
        if (failure) return Promise.reject(failure);
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Wave Link ${method} timed out`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            socket.write(encodeWsFrame(JSON.stringify({ id, jsonrpc: '2.0', method, params })));
        });
    }

    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
            const idx = buf.indexOf('\r\n\r\n');
            if (idx < 0) return;
            const head = buf.subarray(0, idx).toString('utf8');
            buf = buf.subarray(idx + 4);
            if (!/^HTTP\/1\.1 101/i.test(head)) {
                failAll(new Error(`Wave Link websocket handshake failed: ${head.split('\r\n')[0]}`));
                return;
            }
            upgraded = true;
            onUpgrade.resolve();
        }
        const taken = takeWsFrames(buf);
        buf = taken.rest;
        for (const frame of taken.frames) {
            let msg;
            try { msg = JSON.parse(frame); } catch { continue; }
            if (msg.id != null && pending.has(msg.id)) {
                const wait = pending.get(msg.id);
                pending.delete(msg.id);
                clearTimeout(wait.timer);
                if (msg.error) wait.reject(new Error(msg.error.message || 'Wave Link RPC error'));
                else wait.resolve(msg.result);
            }
        }
        if (taken.closed) failAll(new Error('Wave Link socket closed'));
    });

    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Wave Link websocket handshake timed out')), timeoutMs);
            onUpgrade = {
                resolve: () => { clearTimeout(timer); resolve(); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            };
            socket.write(handshake);
        });
        await send('getApplicationInfo', {});
        return await fn(send);
    } finally {
        try { socket.end(); } catch { /* noop */ }
        socket.destroy();
    }
}

function normalizeWaveDevices(result) {
    const devices = (result?.outputDevices || []).map((d) => ({
        id: d.id,
        name: d.name,
        outputId: d.outputs?.[0]?.id || 'generic',
        deviceType: d.deviceType,
    }));
    return {
        devices,
        mainId: result?.mainOutput?.outputDeviceId || null,
        mainOutputId: result?.mainOutput?.outputId || null,
    };
}

async function listCoreAudioOutputs() {
    const bin = await resolveSwitchAudioSource();
    if (!bin) throw new Error('SwitchAudioSource not found — install with: brew install switchaudio-osx');
    const rows = await listAudioDevicesJson(bin, 'output');
    return {
        bin,
        devices: rows.map((r) => ({
            id: r.uid || String(r.id),
            uid: r.uid,
            name: r.name,
            outputId: 'generic',
        })),
        currentName: await getCurrentDevice(bin, 'output'),
    };
}

async function setSystemOutputByUid(bin, uid) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout, stderr } = await execFileAsync(bin, ['-u', uid, '-t', 'output'], { timeout: 10000 });
    return (stdout || stderr || '').trim();
}

async function listCandidateOutputs(waveLinkProcess = process.env.WAVE_LINK_PROCESS || 'WaveLinkMacOS') {
    const names = new Map();
    const add = (name) => {
        const n = String(name || '').trim();
        if (!n || isIgnoredName(n)) return;
        const key = n.toLowerCase();
        if (!names.has(key)) names.set(key, n);
    };
    if (process.platform === 'darwin' && await isWaveLinkRunning(waveLinkProcess)) {
        try {
            await waveLinkSession(async (send) => {
                const listed = normalizeWaveDevices(await send('getOutputDevices', {}));
                for (const d of listed.devices) add(d.name);
                return listed;
            });
        } catch {
            // fall through to Core Audio
        }
    }
    try {
        const core = await listCoreAudioOutputs();
        for (const d of core.devices) add(d.name);
    } catch {
        // SwitchAudioSource missing
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   changed: boolean,
 *   device?: { id: string, name: string },
 *   via?: 'wavelink' | 'system',
 *   waveLink: 'ok' | 'off' | 'unreachable',
 *   steps: string[],
 *   warning?: string,
 *   error?: string,
 * }>}
 */
async function applyRoute({
    priority = DEFAULT_AUDIO_PRIORITY,
    force = false,
    waveLinkProcess = process.env.WAVE_LINK_PROCESS || 'WaveLinkMacOS',
} = {}) {
    const steps = [];
    const pri = normalizePriority(priority);
    let waveLink = 'off';
    let warning;

    try {
        const waveRunning = process.platform === 'darwin' && await isWaveLinkRunning(waveLinkProcess);
        if (waveRunning) {
            waveLink = 'ok';
            let outcome = null;
            try {
                outcome = await waveLinkSession(async (send) => {
                const listed = normalizeWaveDevices(await send('getOutputDevices', {}));
                const device = pickPreferredDevice(listed.devices, {
                    priority: pri,
                    currentId: listed.mainId,
                });
                if (!device) {
                    return { picked: null, mainId: listed.mainId, changed: false, missing: true };
                }
                const already = listed.mainId === device.id;
                if (!already || force) {
                    await send('setOutputDevice', {
                        mainOutput: {
                            outputDeviceId: device.id,
                            outputId: device.outputId || 'generic',
                        },
                    });
                    const after = normalizeWaveDevices(await send('getOutputDevices', {}));
                    steps.push(`Wave Link Main → ${device.name}`);
                    return { picked: device, mainId: after.mainId, changed: after.mainId !== listed.mainId || force };
                }
                steps.push(`Wave Link Main already ${device.name}`);
                return { picked: device, mainId: listed.mainId, changed: false };
                });
            } catch (err) {
                if (!isWaveLinkConnectionError(err)) throw err;
                // Process alive, RPC dead: apps still play into Wave Link's capture device and nothing
                // comes out. Point the system output at the headset so there is sound while the
                // keep-alive restarts Wave Link.
                waveLink = 'unreachable';
                warning = `Wave Link not responding (${err.message})`;
                steps.push(`${warning} — routing system output instead`);
            }
            if (outcome) {
                const { picked, mainId, changed } = outcome;
                if (!picked) {
                    return { ok: false, changed: false, waveLink, steps, error: `No matching output (priority: ${pri.join(', ') || '—'})` };
                }
                return {
                    ok: true,
                    changed: Boolean(changed),
                    device: { id: picked.id, name: picked.name },
                    via: 'wavelink',
                    waveLink,
                    steps,
                    currentId: mainId,
                };
            }
        }

        const reason = waveLink === 'off' ? 'Wave Link not running' : 'Wave Link not responding';
        const core = await listCoreAudioOutputs();
        const picked = pickPreferredDevice(core.devices, { priority: pri });
        if (!picked) {
            return { ok: false, changed: false, waveLink, steps, warning, error: `No matching output (priority: ${pri.join(', ') || '—'})` };
        }
        if (!force && core.currentName === picked.name) {
            steps.push(`macOS output already ${picked.name} (${reason})`);
            return { ok: true, changed: false, device: { id: picked.id, name: picked.name }, via: 'system', waveLink, steps, warning };
        }
        const uid = picked.uid || picked.id;
        steps.push(await setSystemOutputByUid(core.bin, uid) || `macOS output → ${picked.name}`);
        steps.push(`${reason} — set system output instead of Main mix`);
        return { ok: true, changed: true, device: { id: picked.id, name: picked.name }, via: 'system', waveLink, steps, warning };
    } catch (err) {
        return {
            ok: false,
            changed: false,
            waveLink,
            steps,
            warning,
            error: err.message || String(err),
        };
    }
}

async function waitForWaveLinkRpc({ timeoutMs = 30000, pollMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await waveLinkSession(async () => true, { timeoutMs: 2000 });
            return true;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
    }
    return false;
}

/** Newest Wave Link crash report written after `sinceMs`, or null. */
function waveLinkCrashReportSince(sinceMs) {
    const dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
    try {
        const hits = fs.readdirSync(dir)
            .filter((name) => /^WaveLinkMacOS-.*\.ips$/.test(name))
            .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
            .filter((entry) => entry.mtimeMs >= sinceMs)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        return hits[0]?.name || null;
    } catch {
        return null;
    }
}

const WAVE_LINK_UNREACHABLE_TICKS = 3;
const WAVE_LINK_RESTART_COOLDOWN_MS = 3 * 60_000;

function createAudioRouter({
    getConfig,
    onChange,
    onLog,
    onWaveLinkRestart,
    monitorPath,
    recover = fixAudio,
    intervalMs = Number(process.env.ORBIT_AUDIO_ROUTE_MS) || 15000,
    waveLinkProcess = process.env.WAVE_LINK_PROCESS || 'WaveLinkMacOS',
} = {}) {
    let timer = null;
    let monitor = null;
    let inFlight = false;
    let pending = false;
    let lastKey = null;
    let debounce = null;
    let followUp = null;
    let lastFingerprint = null;
    let stopping = false;
    let waveSeenRunningAt = 0;
    let unreachableTicks = 0;
    let lastRestartAt = 0;
    let restarting = null;
    const waveStats = { restarts: 0, lastRestartAt: null, lastRestartReason: null, lastRestartError: null };

    function log(message) {
        onLog?.(message);
    }

    // Wave Link crashed at 03:28 on 2026-10-15, relaunched itself two seconds later and sat for a
    // day with its RPC port accepting TCP and resetting every handshake. Nothing short of a quit +
    // relaunch brings it back, so that is what the keep-alive does, bounded by a cooldown.
    async function restartWaveLink(reason) {
        if (restarting) return restarting;
        const sinceLast = Date.now() - lastRestartAt;
        if (sinceLast < WAVE_LINK_RESTART_COOLDOWN_MS) {
            log(`Wave Link ${reason} — restart skipped, last one ${Math.round(sinceLast / 1000)}s ago`);
            return null;
        }
        lastRestartAt = Date.now();
        restarting = (async () => {
            const report = waveLinkCrashReportSince((waveSeenRunningAt || Date.now() - 24 * 60 * 60_000) - 60_000);
            log(`Wave Link ${reason}${report ? ` (crash report ${report})` : ''} — restarting`);
            try {
                const result = await recover();
                for (const step of result.steps || []) log(`  ${step}`);
                if (!result.ok) throw new Error(result.error || 'Fix Audio failed');
                const rpc = await waitForWaveLinkRpc();
                log(rpc ? 'Wave Link RPC back' : 'Wave Link restarted but RPC still not answering after 30s');
                waveStats.restarts += 1;
                waveStats.lastRestartAt = new Date().toISOString();
                waveStats.lastRestartReason = reason;
                waveStats.lastRestartError = rpc ? null : 'RPC not answering after restart';
                onWaveLinkRestart?.({ ok: rpc, reason, report });
            } catch (err) {
                waveStats.lastRestartError = err.message || String(err);
                log(`Wave Link restart failed: ${waveStats.lastRestartError}`);
                onWaveLinkRestart?.({ ok: false, reason, report, error: waveStats.lastRestartError });
            } finally {
                unreachableTicks = 0;
                restarting = null;
            }
            return tick({ force: true });
        })();
        return restarting;
    }

    function watchWaveLink(result, cfg) {
        if (process.platform !== 'darwin' || stopping) return;
        const now = Date.now();
        if (result.waveLink === 'ok') {
            waveSeenRunningAt = now;
            unreachableTicks = 0;
            return;
        }
        if (cfg.waveLinkKeepAlive === false || restarting) return;
        if (result.waveLink === 'unreachable') {
            unreachableTicks += 1;
            if (unreachableTicks >= WAVE_LINK_UNREACHABLE_TICKS) {
                void restartWaveLink(`not responding for ${unreachableTicks} checks`);
            }
            return;
        }
        if (result.waveLink === 'off' && waveSeenRunningAt) {
            void restartWaveLink('exited');
        }
    }

    async function tick({ force = false } = {}) {
        if (inFlight) {
            pending = true;
            return lastStatus();
        }
        const cfg = getConfig ? getConfig() : {};
        if (!force && cfg.enabled === false) return lastStatus();
        // Mid-restart the system output is being reset by Fix Audio; a poll here would undo it.
        if (restarting && !force) return lastStatus();
        inFlight = true;
        try {
            const result = await applyRoute({
                priority: cfg.priority || DEFAULT_AUDIO_PRIORITY,
                force,
                waveLinkProcess,
            });
            const key = [
                result.ok ? 'ok' : 'err',
                result.device?.id || '',
                result.device?.name || '',
                result.waveLink || '',
                result.error || '',
            ].join('|');
            if (force || result.changed || key !== lastKey) {
                lastKey = key;
                onChange?.(result);
            }
            watchWaveLink(result, cfg);
            return result;
        } finally {
            inFlight = false;
            if (pending) {
                pending = false;
                tick().catch(() => {});
            }
        }
    }

    function lastStatus() {
        return { ok: true, changed: false, skipped: true, steps: [] };
    }

    function onHardwareChange(fingerprint) {
        if (fingerprint && fingerprint === lastFingerprint) return;
        if (fingerprint) lastFingerprint = fingerprint;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            tick().catch(() => {});
            clearTimeout(followUp);
            followUp = setTimeout(() => tick().catch(() => {}), 1500);
        }, 400);
    }

    function startMonitor() {
        if (!monitorPath || !fs.existsSync(monitorPath) || monitor) return;
        const proc = spawn(monitorPath, [], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        monitor = proc;
        let buf = '';
        let sawInitial = false;
        proc.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('changed')) continue;
                const fp = line.split('\t')[1] || '';
                if (!sawInitial) {
                    sawInitial = true;
                    lastFingerprint = fp;
                    continue;
                }
                onHardwareChange(fp);
            }
        });
        proc.stderr.on('data', (chunk) => {
            const msg = chunk.toString().trim();
            if (msg) log(`device monitor: ${msg}`);
        });
        proc.on('exit', (code) => {
            if (monitor === proc) monitor = null;
            if (stopping) return;
            log(`device monitor exited (${code ?? 'null'}) — retrying`);
            setTimeout(() => {
                if (!stopping) startMonitor();
            }, 2000);
        });
        if (typeof proc.unref === 'function') proc.unref();
    }

    function start() {
        if (timer) return;
        stopping = false;
        tick().catch(() => {});
        startMonitor();
        timer = setInterval(() => tick().catch(() => {}), intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    function stop() {
        stopping = true;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        clearTimeout(debounce);
        clearTimeout(followUp);
        if (monitor) {
            try { monitor.kill('SIGTERM'); } catch { /* noop */ }
            monitor = null;
        }
    }

    return {
        start,
        stop,
        applyNow: (opts) => tick({ force: true, ...opts }),
        tick,
        restartWaveLink: (reason = 'restart requested') => {
            lastRestartAt = 0;
            return restartWaveLink(reason);
        },
        waveLinkStatus: () => ({ ...waveStats, restarting: Boolean(restarting), unreachableTicks }),
    };
}

module.exports = {
    applyRoute,
    pickPreferredDevice,
    listCandidateOutputs,
    normalizePriority,
    createAudioRouter,
    isWaveLinkConnectionError,
    waitForWaveLinkRpc,
    waveLinkCrashReportSince,
    DEFAULT_AUDIO_PRIORITY,
};

if (require.main === module) {
    applyRoute({ force: true }).then((result) => {
        for (const step of result.steps) console.log(`  ${step}`);
        if (!result.ok) {
            console.error(result.error);
            process.exitCode = 1;
            return;
        }
        console.log(result.changed ? `Routed to ${result.device?.name} via ${result.via}` : `Already ${result.device?.name}`);
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
