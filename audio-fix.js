/**
 * Restart Elgato Wave Link and reset macOS default input/output devices.
 * Requires switchaudio-osx: brew install switchaudio-osx
 *
 * On this Mac, Wave Link runs as process "WaveLinkMacOS"
 * (/Applications/Elgato Wave Link.app/Contents/MacOS/WaveLinkMacOS).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SWITCH_AUDIO_CANDIDATES = [
    'SwitchAudioSource',
    '/opt/homebrew/bin/SwitchAudioSource',
    '/usr/local/bin/SwitchAudioSource',
];

const DEFAULTS = {
    outputDevice: 'BlackHole 2ch',
    inputDevice: 'Elgato Wave Link Chat Mix',
    waveLinkProcess: 'WaveLinkMacOS',
    waveLinkAppPath: '/Applications/Elgato Wave Link.app',
    waveLinkBundleId: 'com.elgato.WaveLink3',
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function config() {
    return {
        outputDevice: process.env.AUDIO_OUTPUT_DEVICE || DEFAULTS.outputDevice,
        inputDevice: process.env.AUDIO_INPUT_DEVICE || DEFAULTS.inputDevice,
        waveLinkProcess: process.env.WAVE_LINK_PROCESS || DEFAULTS.waveLinkProcess,
        waveLinkAppPath: process.env.WAVE_LINK_APP_PATH || DEFAULTS.waveLinkAppPath,
        waveLinkBundleId: process.env.WAVE_LINK_BUNDLE_ID || DEFAULTS.waveLinkBundleId,
        waveLinkQuitMs: Number(process.env.WAVE_LINK_QUIT_MS) || 2000,
    };
}

async function resolveSwitchAudioSource() {
    for (const candidate of SWITCH_AUDIO_CANDIDATES) {
        try {
            await execFileAsync(candidate, ['-c', '-t', 'output'], { timeout: 5000 });
            return candidate;
        } catch (err) {
            if (err.code === 'ENOENT') continue;
            if (candidate.includes('/') || candidate === 'SwitchAudioSource') return candidate;
        }
    }
    return null;
}

async function runSwitchAudio(bin, args) {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 10000 });
    return (stdout || stderr || '').trim();
}

async function listAudioDevices(bin, type) {
    const out = await runSwitchAudio(bin, ['-a', '-t', type]);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function getCurrentDevice(bin, type) {
    try {
        return await runSwitchAudio(bin, ['-c', '-t', type]);
    } catch {
        return null;
    }
}

async function setAudioDevice(bin, deviceName, type) {
    const available = await listAudioDevices(bin, type);
    if (!available.includes(deviceName)) {
        throw new Error(
            `${type} device "${deviceName}" not found. Available: ${available.join(', ')}`,
        );
    }
    const line = await runSwitchAudio(bin, ['-s', deviceName, '-t', type]);
    if (line && !/set to/i.test(line)) {
        throw new Error(line);
    }
    return line || `${type} audio device set to "${deviceName}"`;
}

async function isWaveLinkRunning(processName) {
    try {
        await execFileAsync('pgrep', ['-x', processName], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function restartWaveLink(cfg) {
    const { waveLinkProcess, waveLinkAppPath, waveLinkQuitMs } = cfg;
    const wasRunning = await isWaveLinkRunning(waveLinkProcess);

    if (wasRunning) {
        // Graceful quit via bundle id, then ensure the main process exited.
        try {
            await execFileAsync('osascript', [
                '-e',
                `tell application id "${cfg.waveLinkBundleId}" to quit`,
            ], { timeout: 10000 });
        } catch {
            // Fall back to SIGTERM on the known main executable.
            try {
                await execFileAsync('pkill', ['-x', waveLinkProcess], { timeout: 5000 });
            } catch {
                // Already gone.
            }
        }
        for (let i = 0; i < 25; i++) {
            if (!(await isWaveLinkRunning(waveLinkProcess))) break;
            await sleep(200);
        }
        if (await isWaveLinkRunning(waveLinkProcess)) {
            await execFileAsync('pkill', ['-9', '-x', waveLinkProcess], { timeout: 5000 });
            await sleep(300);
        }
    }

    await sleep(waveLinkQuitMs);
    await execFileAsync('open', [waveLinkAppPath], { timeout: 10000 });
    return `Restarted Wave Link (${waveLinkProcess})`;
}

/**
 * @returns {Promise<{ ok: boolean, steps: string[], error?: string }>}
 */
async function fixAudio() {
    if (process.platform !== 'darwin') {
        return { ok: false, steps: [], error: 'Fix Audio is only supported on macOS' };
    }

    const cfg = config();
    const steps = [];
    const bin = await resolveSwitchAudioSource();
    if (!bin) {
        return {
            ok: false,
            steps,
            error: 'SwitchAudioSource not found — install with: brew install switchaudio-osx',
        };
    }

    const outBefore = await getCurrentDevice(bin, 'output');
    const inBefore = await getCurrentDevice(bin, 'input');
    if (outBefore || inBefore) {
        steps.push(`Before — output: ${outBefore || '?'}, input: ${inBefore || '?'}`);
    }

    try {
        steps.push(await restartWaveLink(cfg));
        await sleep(500);
        steps.push(await setAudioDevice(bin, cfg.outputDevice, 'output'));
        steps.push(await setAudioDevice(bin, cfg.inputDevice, 'input'));
        steps.push(`After — output: ${await getCurrentDevice(bin, 'output')}, input: ${await getCurrentDevice(bin, 'input')}`);
        return { ok: true, steps };
    } catch (err) {
        return {
            ok: false,
            steps,
            error: err.stderr?.trim() || err.message || String(err),
        };
    }
}

module.exports = {
    fixAudio,
    config,
    resolveSwitchAudioSource,
    listAudioDevices,
    isWaveLinkRunning,
    DEFAULTS,
};
