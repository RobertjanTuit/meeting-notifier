const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

const { google } = require('googleapis');
const cron = require('node-cron');
const moment = require('moment');
const chalk = require('chalk');

require('dotenv').config();

const execAsync = promisify(exec);

// Elgato blink appearance: gentle, warm. brightness 0-100; temperature uses the
// Elgato API range (~143 cool .. 344 warm), higher = warmer/yellower.
const BLINK_BRIGHTNESS = 45;
const BLINK_TEMPERATURE = 320;

// Default per-calendar behavior. Override per calendar in calendars.json.
const DEFAULT_CALENDAR_CONFIG = {
    notify: true,        // schedule the pre-meeting blink/sound/screen alerts
    autoOpen: true,      // auto-open the meeting link when it starts
    warnNoLink: true,    // ding when a meeting has no detectable video link
    push: true,          // send HA phone push when away from the Mac
};

let openModulePromise;
function loadOpen() {
    if (!openModulePromise) {
        openModulePromise = import('open');
    }
    return openModulePromise;
}

class MeetingNotifier extends EventEmitter {
    constructor({
        credentialsPath = path.join(__dirname, 'credentials.json'),
        dataDir = __dirname,
        soundPath = path.join(__dirname, 'sounds', 'ding.wav'),
    } = {}) {
        super();
        this.credentialsPath = credentialsPath;
        this.dataDir = dataDir;
        this.soundPath = soundPath;
        this.calendar = null;
        this.isBlinking = false;
        this.nextMeeting = null;
        this.currentMeeting = null;
        this.scheduledNotifications = [];
        this.scheduledNotificationLogs = [];
        this.keyLights = [];
        this.status = 'idle';
        this.lastError = null;
        this._zoomIsRunning = null;
        this._zoomCheckInterval = null;
        this._meetingPollTask = null;
        this._authServer = null;
        this.authUrl = null;
    }

    get zoomIsRunning() {
        return this._zoomIsRunning;
    }

    set zoomIsRunning(value) {
        if (value === this._zoomIsRunning) return;
        this._zoomIsRunning = value;
        if (value) {
            console.log(chalk.green('✓ Zoom is running'));
            this.turnOnLights();
        } else {
            console.log(chalk.gray('No active Zoom processes found'));
            this.turnOffLights();
        }
        this.emit('zoom-state', value);
    }

    _setStatus(status, error = null) {
        this.status = status;
        this.lastError = error;
        this.emit('status', status, error);
    }

    start() {
        console.log(chalk.green('🚀 Meeting Notifier started!'));

        this.initializeElgatoLights();

        this._zoomCheckInterval = setInterval(() => {
            this.checkIfZoomRunning();
        }, 1000);

        this._meetingPollTask = cron.schedule('*/1 * * * *', () => {
            if (!this.calendar) return;
            console.log(chalk.gray('🔄 Checking for meeting updates...'));
            this.checkForNextMeeting();
        });

        this.initializeGoogleCalendar();

        if (this.calendar) {
            console.log(chalk.blue('📱 Checking for meetings every 1 minute...'));
            this._setStatus('running');
            this.checkForNextMeeting();
        } else if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
            console.log(chalk.red('✗ Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env'));
            this._setStatus('misconfigured');
        } else {
            // No stored tokens yet: spin up the one-time OAuth server automatically.
            this.startAuthServer();
        }
    }

    stop() {
        if (this._zoomCheckInterval) {
            clearInterval(this._zoomCheckInterval);
            this._zoomCheckInterval = null;
        }
        if (this._meetingPollTask?.destroy) {
            this._meetingPollTask.destroy();
            this._meetingPollTask = null;
        }
        this.stopAuthServer();
        this.clearScheduledNotifications();
        this._setStatus('stopped');
    }

    _createOAuthClient() {
        return new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
    }

    _activateCalendar(oauth2Client) {
        this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        console.log(chalk.green('✓ Google Calendar authenticated successfully'));
        this._setStatus('running');
        this.checkForNextMeeting();
    }

    /**
     * Start a small local web server that walks the user through the Google
     * OAuth consent flow. Once tokens are received they are written to disk,
     * the server is shut down, and the calendar is activated automatically.
     */
    async startAuthServer() {
        if (this._authServer) return;

        const express = require('express');
        const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

        let port = 3000;
        try {
            const parsed = new URL(redirectUri);
            if (parsed.port) port = Number(parsed.port);
        } catch {
            // keep default port 3000
        }

        const oauth2Client = this._createOAuthClient();
        const app = express();

        app.get('/', (req, res) => res.redirect('/auth'));

        app.get('/auth', (req, res) => {
            const url = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
                prompt: 'consent',
            });
            res.redirect(url);
        });

        app.get('/oauth2callback', async (req, res) => {
            const { code } = req.query;
            if (!code) {
                res.status(400).send('Missing authorization code.');
                return;
            }
            try {
                const { tokens } = await oauth2Client.getToken(code);
                fs.writeFileSync(this.credentialsPath, JSON.stringify(tokens, null, 2));
                oauth2Client.setCredentials(tokens);
                res.send('<h2>✅ Authentication successful!</h2><p>You can close this window. Meeting Notifier is now running.</p>');
                console.log(chalk.green('✓ Authentication completed! Credentials saved.'));
                this.stopAuthServer();
                this._activateCalendar(oauth2Client);
            } catch (error) {
                console.error(chalk.red('Authentication failed:'), error.message);
                res.status(500).send('Authentication failed: ' + error.message);
            }
        });

        const authUrl = `http://localhost:${port}/auth`;
        this.authUrl = authUrl;

        await new Promise((resolve) => {
            this._authServer = app.listen(port, () => {
                this._setStatus('authenticating');
                console.log(chalk.yellow('⚠ No credentials yet — starting one-time Google sign-in.'));
                console.log(chalk.cyan(`🔐 Opening ${authUrl}`));
                console.log(chalk.gray('   (If your browser does not open, visit that URL manually.)'));
                resolve();
            });
            this._authServer.on('error', (error) => {
                console.error(chalk.red(`Could not start auth server on port ${port}:`), error.message);
                this._setStatus('error', error);
            });
        });

        if (process.env.MN_NO_OPEN === '1') return;

        try {
            const open = await loadOpen();
            await open.default(authUrl);
        } catch {
            // Browser auto-open failed; the URL was logged above.
        }
    }

    stopAuthServer() {
        if (this._authServer) {
            this._authServer.close();
            this._authServer = null;
            this.authUrl = null;
        }
    }

    async checkIfZoomRunning() {
        this.zoomIsRunning = await this.isZoomRunning();
    }

    /**
     * Check if Zoom is currently running by looking for active Zoom processes
     * @returns {Promise<boolean>} True if Zoom process is found, false otherwise
     */
    async isZoomRunning() {
        try {
            if (process.platform === 'win32') {
                const command = `powershell -Command "Get-Process | Where {$_.MainWindowTitle -Like '*zoom meeting*'} | Select-Object Id, ProcessName, MainWindowTitle"`;
                const { stdout, stderr } = await execAsync(command);
                if (stderr) {
                    console.error(chalk.red('Error checking for Zoom processes:'), stderr);
                    return false;
                }
                const output = stdout.trim();
                return !!(output && output.length > 0 && output.includes('ProcessName'));
            }

            if (process.platform === 'darwin') {
                // macOS: the `CptHost` process only runs during an active Zoom meeting.
                try {
                    const { stdout } = await execAsync('pgrep -x CptHost');
                    return stdout.trim().length > 0;
                } catch {
                    return false;
                }
            }

            try {
                const { stdout } = await execAsync('pgrep -f zoom');
                return stdout.trim().length > 0;
            } catch {
                return false;
            }
        } catch (error) {
            console.error(chalk.red('Error checking for Zoom processes:'), error.message);
            return false;
        }
    }

    initializeElgatoLights() {
        const raw = process.env.ELGATO_KEY_LIGHTS;
        if (!raw) {
            console.log(chalk.yellow('⚠ ELGATO_KEY_LIGHTS not set; no lights will be controlled.'));
            this.keyLights = [];
            return;
        }
        this.keyLights = raw.split(',').map((host) => host.trim()).filter(Boolean);
        console.log(chalk.green(`✓ Configured ${this.keyLights.length} Elgato light(s):`));
        this.keyLights.forEach((light, index) => {
            console.log(chalk.blue(`  Light ${index + 1}: ${light}`));
        });
    }

    initializeGoogleCalendar() {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        if (!fs.existsSync(this.credentialsPath)) {
            this._setStatus('unauthenticated');
            return;
        }

        try {
            const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
            oauth2Client.setCredentials(credentials);
            this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            console.log(chalk.green('✓ Google Calendar authenticated successfully'));
        } catch (error) {
            console.log(chalk.red('Failed to load credentials:'), error.message);
            this._setStatus('unauthenticated', error);
        }
    }

    getCalendarIds() {
        const raw = process.env.CALENDAR_ID || 'primary';
        const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
        return ids.length ? ids : ['primary'];
    }

    /**
     * Per-calendar behavior overrides, read from calendars.json in the config
     * dir (cached, reloaded when the file changes). Returns defaults merged with
     * any overrides for the given calendar id.
     */
    getCalendarConfig(calendarId) {
        const configPath = path.join(this.dataDir, 'calendars.json');
        try {
            const stat = fs.statSync(configPath);
            if (!this._calCfgCache || this._calCfgMtime !== stat.mtimeMs) {
                this._calCfgCache = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this._calCfgMtime = stat.mtimeMs;
                console.log(chalk.gray(`⚙️  Loaded per-calendar config from ${configPath}`));
            }
        } catch {
            this._calCfgCache = this._calCfgCache || {};
        }
        const overrides = (calendarId && this._calCfgCache[calendarId]) || {};
        return { ...DEFAULT_CALENDAR_CONFIG, ...overrides };
    }

    async getNextMeeting() {
        if (!this.calendar) {
            throw new Error('Google Calendar not initialized');
        }

        try {
            // Start the window a few hours back so meetings already in progress
            // (which started before "now") are still returned and can be shown
            // as the "current" meeting.
            const timeMin = moment().subtract(4, 'hours').toISOString();
            const timeMax = moment().add(24, 'hours').toISOString();
            const calendarIds = this.getCalendarIds();

            console.log(chalk.blue(`🔍 Searching ${calendarIds.length} calendar(s) for meetings between ${timeMin} and ${timeMax}`));

            // Query each calendar and merge the results. A failure on one
            // calendar doesn't prevent the others from being checked.
            let events = [];
            for (const calendarId of calendarIds) {
                try {
                    const response = await this.calendar.events.list({
                        calendarId,
                        timeMin,
                        timeMax,
                        maxResults: 30,
                        singleEvents: true,
                        orderBy: 'startTime',
                    });
                    const items = (response.data.items || []).map((e) => ({ ...e, _calendarId: calendarId }));
                    events.push(...items);
                } catch (error) {
                    console.error(chalk.red(`Error fetching calendar "${calendarId}":`), error.message);
                }
            }

            // De-duplicate the same event appearing on multiple calendars
            // (matched by iCalUID + start), then sort all events by start time.
            const seen = new Set();
            events = events.filter((e) => {
                const key = `${e.iCalUID || e.id}|${e.start?.dateTime || e.start?.date}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            events.sort((a, b) => {
                const as = a.start?.dateTime || a.start?.date || '';
                const bs = b.start?.dateTime || b.start?.date || '';
                return new Date(as) - new Date(bs);
            });

            const eventsLogFile = path.join(this.dataDir, 'events-log.json');
            try {
                fs.writeFileSync(eventsLogFile, JSON.stringify(events, null, 2));
                console.log(chalk.gray(`📝 Events logged to ${eventsLogFile}`));
            } catch (error) {
                console.error(chalk.red('Error writing events to file:'), error.message);
            }

            // Shared "is this a real meeting we care about" predicate.
            const isActionable = (event) => {
                if (!event.start?.dateTime) return false;                // skip all-day
                if (event.colorId === '2' || event.colorId === '3') return false;
                if (event.eventType === 'outOfOffice') return false;
                if (!event.attendees || event.attendees.length < 2) return false; // skip solo
                const self = event.attendees.find((a) => a.self);
                if (self?.responseStatus === 'declined') return false;   // skip declined
                return true;
            };

            const nowMoment = moment();

            // Current = started but not yet ended, and not a multi-hour/day block
            // (e.g. an all-day "out of office" or "not here" event). Next = future.
            const currentMeeting = events.find((event) => {
                if (!isActionable(event) || !event.end?.dateTime) return false;
                const start = moment(event.start.dateTime);
                const end = moment(event.end.dateTime);
                if (!start.isSameOrBefore(nowMoment) || !end.isAfter(nowMoment)) return false;
                if (end.diff(start, 'hours', true) > 6) return false; // skip long/multi-day blocks
                return true;
            }) || null;

            const nextMeeting = events.find((event) =>
                isActionable(event) && moment(event.start.dateTime).isAfter(nowMoment)
            ) || null;

            this.resolveVideoEntryPoint(currentMeeting);
            this.resolveVideoEntryPoint(nextMeeting);
            this.currentMeeting = currentMeeting;

            if (!nextMeeting) {
                console.log(chalk.gray('No actionable upcoming meeting in the next 24h'));
            }

            return nextMeeting;
        } catch (error) {
            console.error(chalk.red('Error fetching calendar events:'), error.message);
            this._setStatus('error', error);
            return null;
        }
    }

    /**
     * Find a video/conference link for a meeting from its conferenceData,
     * description (Zoom links) or location, and cache it on meeting.videoEntryPoint.
     * Idempotent: returns early if already resolved.
     */
    resolveVideoEntryPoint(meeting) {
        if (!meeting || meeting.videoEntryPoint) return;

        meeting.videoEntryPoint = meeting.conferenceData?.entryPoints?.find(
            (entryPoint) => entryPoint.entryPointType === 'video'
        );

        if (!meeting.videoEntryPoint && meeting.description) {
            const cleanDescription = meeting.description.replace(/<[^>]*>/g, '');
            const zoomRegex = /https:\/\/[^\s]*zoom\.us\/j\/[\w\s]*/gi;
            const zoomMatch = cleanDescription.match(zoomRegex);
            if (zoomMatch && zoomMatch.length > 0) {
                meeting.videoEntryPoint = { entryPointType: 'video', uri: zoomMatch[0] };
            }
        }

        if (!meeting.videoEntryPoint && meeting.location) {
            meeting.videoEntryPoint = { entryPointType: 'video', uri: meeting.location };
        }
    }

    async getElgatoLightData(host) {
        try {
            const responseGet = await fetch(`http://${host}:9123/elgato/lights`);
            return await responseGet.json();
        } catch (error) {
            console.error(chalk.red('Error fetching Elgato light data:'), error.message);
            return null;
        }
    }

    async setElgatoLightData(host, data) {
        const body = JSON.stringify({ lights: [data] });
        try {
            const response = await fetch(`http://${host}:9123/elgato/lights`, {
                method: 'PUT',
                body,
                headers: { 'Content-type': 'application/json' },
            });
            await response.text();
        } catch (error) {
            console.error(chalk.red('Error setting Elgato light data:'), error.message);
            return null;
        }
    }

    async playDingSound() {
        const customSound = this.soundPath;

        if (!fs.existsSync(customSound)) {
            return;
        }

        let command;
        if (process.platform === 'win32') {
            command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SoundPlayer]::new('${customSound}').PlaySync()"`;
        } else if (process.platform === 'darwin') {
            command = `afplay "${customSound}"`;
        } else {
            command = `sh -c 'paplay "${customSound}" 2>/dev/null || aplay "${customSound}" 2>/dev/null'`;
        }

        exec(command, (error) => {
            if (error) {
                console.error(chalk.red('Error playing sound:'), error.message);
            }
        });
        console.log(chalk.magenta('🔔 *custom ding*'));
    }

    async turnOnLights() {
        await Promise.all(this.keyLights.map((light) => this.setElgatoLightData(light, { on: 1 })));
    }

    async turnOffLights() {
        await Promise.all(this.keyLights.map((light) => this.setElgatoLightData(light, { on: 0 })));
    }

    /**
     * Pulse light + sound + (via 'blink-on'/'blink-off' events) the screen, all
     * in lockstep. Each iteration: play the ding, emit 'blink-on' and turn the
     * lights bright, hold, then emit 'blink-off' and turn them off. Listeners
     * (e.g. the tray's screen flash) react to those events so every pulse fires
     * the light, sound and screen together. Works even with no lights configured
     * (sound + screen still pulse).
     */
    async blinkLight(times = 1, duration = 1000) {
        if (this.isBlinking) return;

        const hasLights = this.keyLights.length > 0;
        this.isBlinking = true;
        if (hasLights) {
            console.log(chalk.blue(`💡 Blinking ${this.keyLights.length} light(s) ${times} time(s)`));
        }

        try {
            const originalStates = {};
            if (hasLights) {
                for (const light of this.keyLights) {
                    originalStates[light] = (await this.getElgatoLightData(light))?.lights?.[0];
                }
            }

            for (let i = 0; i < times; i++) {
                // Fire all three together: sound, screen (via event), and lights.
                this.playDingSound();
                this.emit('blink-on');
                if (hasLights) {
                    await Promise.all(this.keyLights.map((light) =>
                        this.setElgatoLightData(light, {
                            on: 1,
                            brightness: BLINK_BRIGHTNESS,
                            temperature: BLINK_TEMPERATURE,
                        })
                    ));
                }

                await this.sleep(duration / 2);

                this.emit('blink-off');
                if (hasLights) {
                    // Dip back to the light's original state instead of full black,
                    // so a light that was already on just returns to normal.
                    await Promise.all(this.keyLights.map((light) => {
                        const orig = originalStates[light];
                        return this.setElgatoLightData(light, orig?.on === 1 ? orig : { on: 0 });
                    }));
                }

                if (i < times - 1) {
                    await this.sleep(duration / 2);
                }
            }

            if (hasLights) {
                await this.sleep(500);
                await Promise.all(this.keyLights.map((light) =>
                    originalStates[light] ? this.setElgatoLightData(light, originalStates[light]) : null
                ));
            }
        } catch (error) {
            console.error(chalk.red('Error controlling lights:'), error.message);
        } finally {
            this.isBlinking = false;
        }
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    clearScheduledNotifications() {
        this.scheduledNotifications.forEach((task) => {
            if (task.destroy) task.destroy();
        });
        this.scheduledNotifications = [];
        this.scheduledNotificationLogs = [];
    }

    scheduleLog(message) {
        this.scheduledNotificationLogs.push(message);
    }

    outputScheduledNotificationLogs() {
        console.log(chalk.yellow('================================================================'));
        this.scheduledNotificationLogs.forEach((message) => {
            console.log(chalk.blue(message));
        });
    }

    scheduleNotifications(meeting) {
        this.clearScheduledNotifications();

        const cfg = this.getCalendarConfig(meeting._calendarId);
        if (!cfg.notify) {
            this.scheduleLog(chalk.gray(`🔕 Notifications disabled for this calendar — "${meeting.summary}" tracked but silent`));
            return;
        }

        this.resolveVideoEntryPoint(meeting);
        if (meeting.videoEntryPoint) {
            console.log(chalk.green(`🔗 Meeting link: ${meeting.videoEntryPoint.uri}`));
        }

        const meetingTime = moment(meeting.start.dateTime);
        const now = moment();

        this.scheduleLog(chalk.green(`📅 Next meeting: ${meeting.summary}`));
        this.scheduleLog(chalk.green(`⏰ Start time: ${meetingTime.format('MMMM Do YYYY, h:mm:ss a')}`));

        const fiveMinutesBefore = meetingTime.clone().subtract(5, 'minutes');
        if (fiveMinutesBefore.isAfter(now)) {
            const cronTime = fiveMinutesBefore.format('s m H D M d');
            const task1 = cron.schedule(cronTime, () => {
                console.log(chalk.yellow('🔔 5 minutes until meeting!'));
                this.blinkLight(1, 2000);
                this.emit('notification', { kind: '5min', meeting });
            }, { scheduled: false });

            task1.start();
            this.scheduledNotifications.push(task1);
            this.scheduleLog(chalk.blue(`⏱ Scheduled 1 blink at ${fiveMinutesBefore.format('h:mm:ss a')}`));
        }

        const oneMinuteBefore = meetingTime.clone().subtract(1, 'minutes');
        if (oneMinuteBefore.isAfter(now)) {
            const cronTime = oneMinuteBefore.format('s m H D M d');
            const task2 = cron.schedule(cronTime, () => {
                console.log(chalk.yellow('🔔 1 minute until meeting!'));
                this.blinkLight(2, 1500);
                this.emit('notification', { kind: '1min', meeting });
            }, { scheduled: false });

            task2.start();
            this.scheduledNotifications.push(task2);
            this.scheduleLog(chalk.blue(`⏱ Scheduled 2 blinks at ${oneMinuteBefore.format('h:mm:ss a')}`));
        }

        const cronTime = meetingTime.format('s m H D M d');
        const task3 = cron.schedule(cronTime, async () => {
            console.log(chalk.red('🔔 Meeting starting now!'));
            await this.blinkLight(5, 1000);
            if (cfg.autoOpen) this.openMeetingVideo(meeting);
            this.emit('notification', { kind: 'start', meeting });
        }, { scheduled: false });

        task3.start();
        this.scheduledNotifications.push(task3);
        this.scheduleLog(chalk.blue(`⏱ Scheduled 5 blinks at ${meetingTime.format('h:mm:ss a')}`));
        if (meeting.videoEntryPoint) {
            if (cfg.autoOpen) {
                this.scheduleLog(chalk.blue(`⏱ Scheduled open meeting video: ${meeting.videoEntryPoint.uri} at ${meetingTime.format('h:mm:ss a')}`));
            }
        } else if (cfg.warnNoLink) {
            this.scheduleLog(chalk.red(`⏱ No video entry point found for meeting: ${meeting.summary}`));
            this.playDingSound();
        } else {
            this.scheduleLog(chalk.gray(`⏱ No video link for "${meeting.summary}" (warning disabled for this calendar)`));
        }
    }

    async openMeetingVideo(meeting) {
        if (!meeting?.videoEntryPoint) return;
        console.log(chalk.blue(`🔗 Opening meeting video: ${meeting.videoEntryPoint.uri}`));
        try {
            const open = await loadOpen();
            await open.default(meeting.videoEntryPoint.uri);
        } catch (error) {
            console.error(chalk.red('Error opening meeting URL:'), error.message);
        }
    }

    async checkForNextMeeting() {
        if (!this.calendar) {
            return;
        }
        try {
            const nextMeeting = await this.getNextMeeting();

            if (
                this.nextMeeting &&
                nextMeeting &&
                this.nextMeeting.id === nextMeeting.id &&
                this.nextMeeting.start.dateTime === nextMeeting.start.dateTime
            ) {
                console.log(chalk.gray('📅 No new meetings found'));
                this.outputScheduledNotificationLogs();
                this.emit('meeting-update', this.nextMeeting);
                return;
            }

            this.nextMeeting = nextMeeting;

            if (nextMeeting) {
                this.scheduleNotifications(nextMeeting);
                this.outputScheduledNotificationLogs();
            } else {
                console.log(chalk.gray('📅 No upcoming meetings found for today'));
                this.clearScheduledNotifications();
            }

            this.emit('meeting-update', this.nextMeeting);
        } catch (error) {
            console.error(chalk.red('Error checking for meetings:'), error.message);
            this._setStatus('error', error);
        }
    }
}

module.exports = { MeetingNotifier };

// Run as a CLI when invoked directly (e.g. `npm start`).
if (require.main === module) {
    const notifier = new MeetingNotifier();
    notifier.start();

    process.on('SIGINT', () => {
        console.log(chalk.yellow('\n👋 Shutting down Meeting Notifier...'));
        notifier.stop();
        process.exit(0);
    });
}
