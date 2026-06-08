const { spawn } = require('child_process');
const os = require('os');

function runCommand(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = '';
        const proc = spawn(cmd, args);
        const timer = setTimeout(() => {
            proc.kill();
            resolve(stdout);
        }, timeoutMs);
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.on('close', () => {
            clearTimeout(timer);
            resolve(stdout);
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve(stdout);
        });
    });
}

function parseBrowseInstances(output) {
    const names = new Set();
    for (const line of output.split('\n')) {
        if (!line.includes('Add') || !line.includes('_elg._tcp')) continue;
        const m = line.match(/_elg\._tcp\.\s+(.+?)\s*$/);
        if (m) names.add(m[1].trim());
    }
    return [...names];
}

function parseReachableHost(output) {
    const m = output.match(/can be reached at ([^\s]+?)(?::(\d+))?(?:\s|\()/);
    if (!m) return null;
    const hostname = m[1].replace(/\.$/, '');
    return { hostname, port: m[2] ? Number(m[2]) : 9123 };
}

function parseIpv4FromResolve(output) {
    const m = output.match(/\s(\d+\.\d+\.\d+\.\d+)\s+\d+\s*$/m);
    return m ? m[1] : null;
}

async function resolveIpv4Darwin(hostname, timeoutMs = 2500) {
    const out = await runCommand('dns-sd', ['-G', 'v4', hostname], timeoutMs);
    return parseIpv4FromResolve(out);
}

async function resolveInstanceDarwin(instanceName, timeoutMs = 2500) {
    const out = await runCommand('dns-sd', ['-L', instanceName, '_elg._tcp', 'local'], timeoutMs);
    const reachable = parseReachableHost(out);
    if (!reachable) return null;

    const ip = await resolveIpv4Darwin(reachable.hostname, timeoutMs);
    const host = ip || reachable.hostname;
    return {
        host,
        port: reachable.port,
        name: instanceName,
        hostname: reachable.hostname,
    };
}

async function browseInstancesDarwin(timeoutMs) {
    const out = await runCommand('dns-sd', ['-B', '_elg._tcp', 'local'], timeoutMs);
    return parseBrowseInstances(out);
}

async function verifyElgatoHost(host) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://${host}:9123/elgato/accessory-info`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const data = await res.json();
        return {
            host,
            name: data.displayName || data.name || host,
            model: data.productName || data.model || '',
        };
    } catch {
        return null;
    }
}

function localSubnetBases() {
    const bases = new Set();
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs || []) {
            if (addr.family !== 'IPv4' || addr.internal) continue;
            const parts = addr.address.split('.');
            if (parts.length !== 4) continue;
            bases.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
    }
    return [...bases];
}

async function discoverBySubnetScan() {
    const bases = localSubnetBases();
    const found = [];
    const tasks = [];
    for (const base of bases) {
        for (let i = 1; i < 255; i += 1) {
            const host = `${base}.${i}`;
            tasks.push(verifyElgatoHost(host).then((info) => {
                if (info) found.push(info);
            }));
        }
    }
    await Promise.all(tasks);
    const byHost = new Map();
    for (const light of found) byHost.set(light.host, light);
    return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

async function discoverElgatoLights({ timeoutMs = 4000 } = {}) {
    let candidates = [];

    if (process.platform === 'darwin') {
        const instances = await browseInstancesDarwin(timeoutMs);
        const resolved = await Promise.all(
            instances.map((name) => resolveInstanceDarwin(name, Math.min(timeoutMs, 3000))),
        );
        candidates = resolved.filter(Boolean);
    }

    if (!candidates.length) {
        return discoverBySubnetScan();
    }

    const lights = [];
    const seen = new Set();
    for (const c of candidates) {
        if (seen.has(c.host)) continue;
        seen.add(c.host);
        const verified = await verifyElgatoHost(c.host);
        lights.push(verified || { host: c.host, name: c.name, model: '' });
    }

    return lights.sort((a, b) => a.host.localeCompare(b.host));
}

module.exports = { discoverElgatoLights };
