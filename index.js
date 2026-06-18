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
    color: null,         // optional #hex or name — tray/HUD tint for this calendar
};

let openModulePromise;
function loadOpen() {
    if (!openModulePromise) {
        openModulePromise = import('open');
    }
    return openModulePromise;
}

class OrbitNotifier extends EventEmitter {
    constructor({
        credentialsPath = path.join(__dirname, 'credentials.json'),
        dataDir = __dirname,
        soundPath = path.join(__dirname, 'sounds', 'ding.wav'),
    } = {}) {
        super();
        this.credentialsPath = credentialsPath;
        this.dataDir = dataDir;
        this._defaultSoundPath = soundPath;
        this.soundPath = soundPath;
        this.calendar = null;
        this.calendarClients = [];
        this._pendingAuthAccountId = 'primary';
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
        this._callDetectors = [];
        /** Whether the native Zoom (CptHost) process check is allowed to mark you in-call. */
        this.zoomProcessDetectionEnabled = true;
        /** Human label of whatever is currently marking you "in a call" (or null). */
        this.callSource = null;
        this._meetingPollTask = null;
        this._meetingPollTimer = null;
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
            console.log(chalk.green('✓ In a call (Zoom / Meet / ClickUp)'));
        } else {
            console.log(chalk.gray('No active call detected'));
        }
        this._syncMeetingLights().catch((err) => {
            console.error(chalk.red('Error syncing meeting lights:'), err.message);
        });
        this.emit('zoom-state', value);
    }

    /** Keep Key Lights on while in a Zoom call; off when idle. */
    async _syncMeetingLights() {
        if (this._zoomIsRunning) {
            await this.turnOnLights();
        } else {
            await this.turnOffLights();
        }
    }

    _restoreLightAfterPulse(host, original) {
        if (this._zoomIsRunning) {
            return this.setElgatoLightData(host, { on: 1 });
        }
        return this.setElgatoLightData(host, original?.on === 1 ? original : { on: 0 });
    }

    _setStatus(status, error = null) {
        this.status = status;
        this.lastError = error;
        this.emit('status', status, error);
    }

    start() {
        console.log(chalk.green('🚀 Orbit started!'));

        this.initializeElgatoLights();

        this._zoomCheckInterval = setInterval(() => {
            this.checkIfZoomRunning();
        }, 1000);

        this.initializeGoogleCalendar();
        this.restartMeetingPoll();

        if (this.calendarClients.length) {
            const sec = this._meetingPollSeconds();
            console.log(chalk.blue(`📱 Checking for meetings every ${sec} seconds...`));
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
        if (this._meetingPollTimer) {
            clearInterval(this._meetingPollTimer);
            this._meetingPollTimer = null;
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

    _activateCalendar() {
        if (this.calendarClients.length) {
            console.log(chalk.green(`✓ Google Calendar authenticated (${this.calendarClients.length} account(s))`));
            this._setStatus('running');
            this.checkForNextMeeting();
        }
    }

    _readGoogleRules() {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'google-rules.json'), 'utf8'));
        } catch {
            return { pollIntervalSeconds: 60, accounts: {} };
        }
    }

    _getGoogleAccounts() {
        const { DEFAULT_GOOGLE_ACCOUNTS } = require('./config-store.js');
        const rules = this._readGoogleRules();
        return { ...DEFAULT_GOOGLE_ACCOUNTS, ...(rules.accounts || {}) };
    }

    _credentialsPathForAccount(accountId) {
        const acct = this._getGoogleAccounts()[accountId];
        const file = acct?.credentialsFile
            || (accountId === 'primary' ? 'credentials.json' : `credentials-${accountId}.json`);
        return path.join(this.dataDir, file);
    }

    /**
     * Start a small local web server that walks the user through the Google
     * OAuth consent flow. Once tokens are received they are written to disk,
     * the server is shut down, and the calendar is activated automatically.
     */
    async startAuthServer({ accountId = 'primary' } = {}) {
        if (this._authServer) return;
        this._pendingAuthAccountId = accountId;

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
                const credPath = this._credentialsPathForAccount(this._pendingAuthAccountId);
                fs.writeFileSync(credPath, JSON.stringify(tokens, null, 2));
                oauth2Client.setCredentials(tokens);
                const acct = this._getGoogleAccounts()[this._pendingAuthAccountId];
                const label = acct?.label || this._pendingAuthAccountId;
                res.send(`<h2>✅ Authentication successful!</h2><p>${label} connected. You can close this window.</p>`);
                console.log(chalk.green(`✓ Authentication completed for ${label} (${path.basename(credPath)})`));
                this.stopAuthServer();
                this.initializeGoogleCalendar();
                this._activateCalendar();
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

        if (process.env.ORBIT_NO_OPEN === '1' || process.env.MN_NO_OPEN === '1') return;

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

    /**
     * Register an extra async detector. It should return a truthy *reason label*
     * (string) when you're in a call, or a falsy value otherwise. OR'd with Zoom.
     */
    addCallDetector(fn) {
        if (typeof fn === 'function') this._callDetectors.push(fn);
    }

    async checkIfZoomRunning() {
        let source = null;
        if (this.zoomProcessDetectionEnabled !== false && await this.isZoomRunning()) {
            source = 'Zoom';
        }
        if (!source) {
            for (const detect of this._callDetectors) {
                try {
                    const reason = await detect();
                    if (reason) { source = typeof reason === 'string' ? reason : 'In a call'; break; }
                } catch { /* detector failed — ignore */ }
            }
        }
        this.callSource = source;
        this.zoomIsRunning = Boolean(source);
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
        this.calendarClients = [];
        const accounts = this._getGoogleAccounts();

        for (const [accountId, acct] of Object.entries(accounts)) {
            if (acct.enabled === false) continue;
            const credPath = path.join(this.dataDir, acct.credentialsFile || `credentials-${accountId}.json`);
            if (!fs.existsSync(credPath)) continue;
            try {
                const oauth2Client = this._createOAuthClient();
                oauth2Client.setCredentials(JSON.parse(fs.readFileSync(credPath, 'utf8')));
                this.calendarClients.push({
                    accountId,
                    label: acct.label || accountId,
                    calendar: google.calendar({ version: 'v3', auth: oauth2Client }),
                });
            } catch (error) {
                console.log(chalk.red(`Failed to load credentials for ${accountId}:`), error.message);
            }
        }

        this.calendar = this.calendarClients[0]?.calendar || null;
        if (!this.calendarClients.length) {
            this._setStatus('unauthenticated');
        }
    }

    disconnectGoogleAccount(accountId = 'primary') {
        const credPath = this._credentialsPathForAccount(accountId);
        if (fs.existsSync(credPath)) {
            fs.unlinkSync(credPath);
            console.log(chalk.yellow(`Disconnected Google account: ${accountId}`));
        }
        this.initializeGoogleCalendar();
        if (!this.calendarClients.length) {
            this._setStatus('unauthenticated');
        } else {
            this.checkForNextMeeting();
        }
    }

    async resolveCalendarApiFor(calendarId) {
        const timeMin = new Date().toISOString();
        for (const client of this.calendarClients) {
            try {
                await client.calendar.events.list({
                    calendarId,
                    timeMin,
                    maxResults: 1,
                    singleEvents: true,
                });
                return client.calendar;
            } catch {
                // try next account
            }
        }
        return this.calendar;
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
        const fileDefaults = this._calCfgCache._defaults || {};
        const overrides = (calendarId && this._calCfgCache[calendarId]) || {};
        return { ...DEFAULT_CALENDAR_CONFIG, ...fileDefaults, ...overrides };
    }

    async _fetchCalendarEvents(calendarId, timeMin, timeMax) {
        for (const client of this.calendarClients) {
            try {
                const response = await client.calendar.events.list({
                    calendarId,
                    timeMin,
                    timeMax,
                    maxResults: 30,
                    singleEvents: true,
                    orderBy: 'startTime',
                });
                return (response.data.items || []).map((e) => ({
                    ...e,
                    _calendarId: calendarId,
                    _accountId: client.accountId,
                }));
            } catch {
                // try next Google account
            }
        }
        console.error(chalk.red(`Error fetching calendar "${calendarId}": no connected account has access`));
        return [];
    }

    async getNextMeeting() {
        if (!this.calendarClients.length) {
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
                const items = await this._fetchCalendarEvents(calendarId, timeMin, timeMax);
                events.push(...items);
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

            // Cheap "does this event have a video/conference link?" check used to
            // keep real calls that only list you as an attendee (e.g. large
            // all-hands / webinars) while still dropping solo personal blocks.
            const hasVideoLink = (event) => {
                if (event.conferenceData?.entryPoints?.some((e) => e.entryPointType === 'video')) return true;
                if (event.hangoutLink) return true;
                const desc = (event.description || '').replace(/<[^>]*>/g, '');
                if (/zoom\.us\/j\/|meet\.google\.com\/|teams\.microsoft\.com\//i.test(desc)) return true;
                if (event.location && /^https?:\/\//i.test(event.location.trim())) return true;
                return false;
            };

            // Shared "is this a real meeting we care about" predicate.
            const isActionable = (event) => {
                if (!event.start?.dateTime) return false;                // skip all-day
                if (event.colorId === '2' || event.colorId === '3') return false;
                if (event.eventType === 'outOfOffice') return false;
                const self = (event.attendees || []).find((a) => a.self);
                if (self?.responseStatus === 'declined') return false;   // skip declined
                // Skip solo events (no co-attendees) unless they carry a video link —
                // a 1-attendee event with a Zoom/Meet link is usually a broadcast/all-hands.
                if ((!event.attendees || event.attendees.length < 2) && !hasVideoLink(event)) return false;
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

    resolveAlertSoundPath(source) {
        if (typeof this._resolveAlertSound === 'function') {
            return this._resolveAlertSound(source);
        }
        return this.soundPath;
    }

    async playAlertSound(source) {
        const soundFile = this.resolveAlertSoundPath(source);

        if (!soundFile || !fs.existsSync(soundFile)) {
            return;
        }

        let command;
        if (process.platform === 'win32') {
            command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SoundPlayer]::new('${soundFile}').PlaySync()"`;
        } else if (process.platform === 'darwin') {
            command = `afplay "${soundFile}"`;
        } else {
            command = `sh -c 'paplay "${soundFile}" 2>/dev/null || aplay "${soundFile}" 2>/dev/null'`;
        }

        exec(command, (error) => {
            if (error) {
                console.error(chalk.red('Error playing alert sound:'), error.message);
            }
        });
        console.log(chalk.magenta(`🔔 ${path.basename(soundFile)}`));
    }

    async playDingSound(source) {
        return this.playAlertSound(source);
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

    async pulseAlert(times = 1, duration = 1000, {
        lights = true, sound = true, flash = true, soundSource = 'meetings',
    } = {}) {
        if (this.isBlinking) return;
        const hasLights = lights && this.keyLights.length > 0;
        this.isBlinking = true;
        try {
            const originalStates = {};
            if (hasLights) {
                for (const light of this.keyLights) {
                    originalStates[light] = (await this.getElgatoLightData(light))?.lights?.[0];
                }
            }
            for (let i = 0; i < times; i++) {
                if (sound) this.playAlertSound(soundSource);
                if (flash) this.emit('blink-on');
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
                if (flash) this.emit('blink-off');
                if (hasLights) {
                    await Promise.all(this.keyLights.map((light) =>
                        this._restoreLightAfterPulse(light, originalStates[light])
                    ));
                }
                if (i < times - 1) await this.sleep(duration / 2);
            }
            if (hasLights) {
                await this.sleep(500);
                if (this._zoomIsRunning) {
                    await this.turnOnLights();
                } else {
                    await Promise.all(this.keyLights.map((light) =>
                        originalStates[light] ? this.setElgatoLightData(light, originalStates[light]) : null
                    ));
                }
            }
        } catch (error) {
            console.error(chalk.red('Error pulsing alert:'), error.message);
        } finally {
            this.isBlinking = false;
        }
    }

    async blinkLight(times = 1, duration = 1000) {
        return this.pulseAlert(times, duration, { lights: true, sound: true, flash: true });
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
                this.emit('notification', { kind: '1min', meeting });
            }, { scheduled: false });

            task2.start();
            this.scheduledNotifications.push(task2);
            this.scheduleLog(chalk.blue(`⏱ Scheduled 2 blinks at ${oneMinuteBefore.format('h:mm:ss a')}`));
        }

        const cronTime = meetingTime.format('s m H D M d');
        const task3 = cron.schedule(cronTime, async () => {
            console.log(chalk.red('🔔 Meeting starting now!'));
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
        if (!this.calendarClients.length) {
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

    _meetingPollSeconds() {
        const sec = Number(this._readGoogleRules().pollIntervalSeconds);
        return Number.isFinite(sec) && sec >= 15 ? sec : 60;
    }

    restartMeetingPoll() {
        if (this._meetingPollTimer) {
            clearInterval(this._meetingPollTimer);
            this._meetingPollTimer = null;
        }
        const sec = this._meetingPollSeconds();
        this._meetingPollTimer = setInterval(() => {
            if (!this.calendarClients.length) return;
            console.log(chalk.gray('🔄 Checking for meeting updates...'));
            this.checkForNextMeeting();
        }, sec * 1000);
    }

    reinitializeLights() {
        this.initializeElgatoLights();
    }

    reinitializeSound() {
        const custom = process.env.ALERT_SOUND?.trim();
        if (custom && fs.existsSync(custom)) {
            this.soundPath = custom;
            console.log(chalk.green(`✓ Alert sound: ${custom}`));
            return;
        }
        if (custom) {
            console.warn(chalk.yellow(`⚠ Alert sound not found: ${custom} — using default`));
        }
        this.soundPath = this._defaultSoundPath;
    }

    reloadCalendarAuth() {
        this.calendar = null;
        this.calendarClients = [];
        this.initializeGoogleCalendar();
        this.restartMeetingPoll();
        if (this.calendarClients.length) this.checkForNextMeeting();
    }

    async listCalendars() {
        if (!this.calendarClients.length) return [];
        const all = [];
        const seen = new Set();
        for (const client of this.calendarClients) {
            try {
                const res = await client.calendar.calendarList.list({ minAccessRole: 'reader' });
                for (const c of res.data.items || []) {
                    if (seen.has(c.id)) continue;
                    seen.add(c.id);
                    all.push({
                        id: c.id,
                        summary: c.summary || c.id,
                        primary: Boolean(c.primary),
                        backgroundColor: c.backgroundColor,
                        accountId: client.accountId,
                        accountLabel: client.label,
                    });
                }
            } catch (error) {
                console.error(chalk.red(`Failed to list calendars for ${client.accountId}:`), error.message);
            }
        }
        return all;
    }

    async discoverElgatoLights(options) {
        const { discoverElgatoLights } = require('./elgato-discover.js');
        return discoverElgatoLights(options);
    }

    async blinkLightAt(host, times = 1, duration = 600) {
        if (!host || this.isBlinking) return;
        this.isBlinking = true;
        try {
            const original = (await this.getElgatoLightData(host))?.lights?.[0];
            for (let i = 0; i < times; i++) {
                this.playDingSound();
                this.emit('blink-on');
                await this.setElgatoLightData(host, { on: 1, brightness: BLINK_BRIGHTNESS, temperature: BLINK_TEMPERATURE });
                await this.sleep(duration / 2);
                this.emit('blink-off');
                await this._restoreLightAfterPulse(host, original);
                if (i < times - 1) await this.sleep(duration / 2);
            }
            if (this._zoomIsRunning) {
                await this.setElgatoLightData(host, { on: 1 });
            } else if (original) {
                await this.setElgatoLightData(host, original);
            }
        } catch (error) {
            console.error(chalk.red(`Error blinking light ${host}:`), error.message);
            throw error;
        } finally {
            this.isBlinking = false;
        }
    }
}

module.exports = { OrbitNotifier };

// Run as a CLI when invoked directly (e.g. `npm start`).
if (require.main === module) {
    const notifier = new OrbitNotifier();
    notifier.start();

    process.on('SIGINT', () => {
        console.log(chalk.yellow('\n👋 Shutting down Orbit...'));
        notifier.stop();
        process.exit(0);
    });
}
