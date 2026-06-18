#!/usr/bin/env node
/** Generate distinct bundled alert tones (run once: node scripts/generate-alert-sounds.js) */
const fs = require('fs');
const path = require('path');

function writeWav(filePath, tones) {
    const sampleRate = 44100;
    const totalMs = Math.max(...tones.map((t) => t.startMs + t.durationMs), 1);
    const numSamples = Math.ceil((sampleRate * totalMs) / 1000);
    const data = Buffer.alloc(numSamples * 2);

    for (const { freq, startMs, durationMs, volume = 0.25 } of tones) {
        const start = Math.floor((sampleRate * startMs) / 1000);
        const len = Math.floor((sampleRate * durationMs) / 1000);
        for (let i = 0; i < len; i++) {
            const idx = start + i;
            if (idx >= numSamples) break;
            const t = i / sampleRate;
            const attack = Math.min(1, i / (sampleRate * 0.008));
            const release = Math.min(1, (len - i) / (sampleRate * 0.04));
            const sample = Math.sin(2 * Math.PI * freq * t) * attack * release * volume;
            const prev = data.readInt16LE(idx * 2);
            const next = Math.max(-32768, Math.min(32767, prev + sample * 32767));
            data.writeInt16LE(next, idx * 2);
        }
    }

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

const dir = path.join(__dirname, '..', 'sounds');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

writeWav(path.join(dir, 'meetings.wav'), [
    { freq: 440, startMs: 0, durationMs: 160, volume: 0.28 },
    { freq: 554, startMs: 110, durationMs: 200, volume: 0.28 },
]);
writeWav(path.join(dir, 'clickup.wav'), [
    { freq: 880, startMs: 0, durationMs: 90, volume: 0.32 },
    { freq: 1318, startMs: 80, durationMs: 120, volume: 0.28 },
]);
writeWav(path.join(dir, 'email.wav'), [
    { freq: 392, startMs: 0, durationMs: 220, volume: 0.22 },
    { freq: 494, startMs: 180, durationMs: 280, volume: 0.2 },
]);
writeWav(path.join(dir, 'datadog.wav'), [
    { freq: 988, startMs: 0, durationMs: 90, volume: 0.35 },
    { freq: 988, startMs: 140, durationMs: 90, volume: 0.35 },
    { freq: 1175, startMs: 280, durationMs: 160, volume: 0.32 },
]);

console.log('Wrote meetings.wav, clickup.wav, email.wav, datadog.wav');
