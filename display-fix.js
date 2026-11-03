const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(os.homedir(), '.local/bin/displaylink-wake.sh');
const EXPECTED_DISPLAYS = Number(process.env.ORBIT_EXPECTED_DISPLAYS || 4);

function run(cmd, args, timeout) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
    });
}

async function countDisplays() {
    const { stdout } = await run('/usr/sbin/system_profiler', ['SPDisplaysDataType'], 15000);
    return (stdout.match(/Resolution:/g) || []).length;
}

/** Restarts DisplayLink Manager via the same script sleepwatcher runs on wake. */
async function fixDisplays() {
    if (!fs.existsSync(SCRIPT)) {
        return { ok: false, error: `Missing ${SCRIPT}` };
    }
    const { err } = await run('/bin/bash', [SCRIPT, 'manual'], 90000);
    if (err) return { ok: false, error: err.message };
    const displays = await countDisplays();
    return { ok: displays >= EXPECTED_DISPLAYS, displays, expected: EXPECTED_DISPLAYS };
}

/** True when every desk monitor is attached, i.e. the laptop is docked in the office. */
async function isAtDesk() {
    return (await countDisplays()) >= EXPECTED_DISPLAYS;
}

module.exports = { fixDisplays, countDisplays, isAtDesk, EXPECTED_DISPLAYS };
