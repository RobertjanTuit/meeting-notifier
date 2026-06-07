#!/usr/bin/env node
/**
 * Standalone HA push test — verifies gentle + urgent delivery.
 * Usage: npm run test-push [-- --urgent-only | --gentle-only]
 */
require('dotenv').config();
const { sendHaPush, isConfigured } = require('./push.js');

async function main() {
    const args = new Set(process.argv.slice(2));
    const gentleOnly = args.has('--gentle-only');
    const urgentOnly = args.has('--urgent-only');

    if (!isConfigured()) {
        console.error('Set HA_URL, HA_TOKEN, and HA_NOTIFY_TARGET in .env first.');
        process.exit(1);
    }

    if (!urgentOnly) {
        console.log('Sending gentle push (Meeting Reminders channel)...');
        await sendHaPush({
            title: 'Meeting Notifier test',
            message: 'Gentle reminder — override DnD on this channel in Android settings',
            urgent: false,
        });
    }

    if (!gentleOnly) {
        console.log('Sending urgent push (TTS / alarm_stream_max)...');
        await sendHaPush({
            title: 'Meeting started',
            message: 'Standup with the team',
            urgent: true,
        });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
