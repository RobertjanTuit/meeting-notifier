(async () => {
    const fetch = require('node-fetch');
    const { google } = require('googleapis');
    const cron = require('node-cron');
    const moment = require('moment');
    const chalk = require('chalk');
    const open =  await import('open');
    const { exec } = require('child_process');
    const { promisify } = require('util');

    const execAsync = promisify(exec);

    require('dotenv').config();

    class MeetingNotifier {
        constructor() {
            this.calendar = null;
            this.isBlinking = false;
            this.nextMeeting = null;
            this.scheduledNotifications = [];
            this.scheduledNotificationLogs = [];
            this.keyLights = [];
            
            this.initializeGoogleCalendar();
            this.initializeElgatoLights();

            setInterval(() => {
                this.checkIfZoomRunning();
            }, 1000);
        }

        _zoomIsRunning = null;
        get zoomIsRunning() {
            return this._zoomIsRunning;
        }
        set zoomIsRunning(value) {
            if (value != this._zoomIsRunning) {
                this._zoomIsRunning = value;
                if (value) {
                    console.log(chalk.green('✓ Zoom is running'));
                    this.turnOnLights();
                } else {
                    console.log(chalk.gray('No active Zoom processes found'));
                    this.turnOffLights();
                }
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
                // Use PowerShell to check for Zoom processes
                const command = `powershell -Command "Get-Process | Where {$_.MainWindowTitle -Like '*zoom meeting*'} | Select-Object Id, ProcessName, MainWindowTitle"`;
                
                const { stdout, stderr } = await execAsync(command);
                
                if (stderr) {
                    console.error(chalk.red('Error checking for Zoom processes:'), stderr);
                    return false;
                }

                // Check if any zoom-related processes were found
                const output = stdout.trim();
                if (output && output.length > 0 && output.includes('ProcessName')) {
                    return true;
                } else {
                    return false;
                }
            } catch (error) {
                console.error(chalk.red('Error checking for Zoom processes:'), error.message);
                return false;
            }
        }

        initializeElgatoLights() {
            this.keyLights = process.env.ELGATO_KEY_LIGHTS.split(',');
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

            // Check if we have stored credentials
            try {
                const credentials = require('./credentials.json');
                oauth2Client.setCredentials(credentials);
                this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
                console.log(chalk.green('✓ Google Calendar authenticated successfully'));
            } catch (error) {
                console.log(chalk.yellow('⚠ No stored credentials found. Please run authentication first.'));
                this.authenticateGoogle(oauth2Client);
            }
        }

        async authenticateGoogle(oauth2Client) {
            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/calendar.readonly'],
            });

            console.log(chalk.blue('Please visit this URL to authenticate:'));
            console.log(chalk.cyan(authUrl));
            console.log(chalk.yellow('After authentication, paste the authorization code here:'));
            
            // For production, you'd want to implement a proper OAuth flow
            // For now, we'll assume credentials are provided
            process.exit(1);
        }

        async getNextMeeting() {
            if (!this.calendar) {
                throw new Error('Google Calendar not initialized');
            }

            try {
                const now = moment().toISOString();
                const nowPlus24Hours = moment().add(24, 'hours').toISOString();

                console.log(chalk.blue(`🔍 Searching for meetings between ${now} and ${nowPlus24Hours}`));
                const response = await this.calendar.events.list({
                    calendarId: process.env.CALENDAR_ID || 'primary',
                    timeMin: now,
                    timeMax: nowPlus24Hours,
                    maxResults: 20,
                    singleEvents: true,
                    orderBy: 'startTime',
                });

                const events = response.data.items || [];
                
                // Write events to a JSON file for debugging/logging
                const fs = require('fs');
                const eventsLogFile = './events-log.json';
                
                try {
                    fs.writeFileSync(eventsLogFile, JSON.stringify(events, null, 2));
                    console.log(chalk.gray(`📝 Events logged to ${eventsLogFile}`));
                } catch (error) {
                    console.error(chalk.red('Error writing events to file:'), error.message);
                }

                // Filter out all-day events and find the next meeting
                const nextMeeting = events.find(event => 
                    event.start.dateTime && 
                    moment(event.start.dateTime).isAfter(moment())  &&
                    event.colorId !== '2' &&
                    event.colorId !== '3' &&
                    event.eventType !== 'outOfOffice'
                );

                if (!nextMeeting?.attendees?.length || nextMeeting?.attendees?.length < 2) {
                    console.log(chalk.red('Next meeting only has 1 attendee, warning'));
                    console.log(chalk.red(nextMeeting));
                    await this.blinkLight(5, 500);
                    return null;
                }

                return nextMeeting;
            } catch (error) {
                console.error(chalk.red('Error fetching calendar events:'), error.message);
                return null;
            }
        }

        async getElgatoLightData(host) {
            // {"numberOfLights":1,"lights":[{"on":1,"brightness":76,"temperature":344}]}
            try {
                const responseGet = await fetch(`http://${host}:9123/elgato/lights`);
                return await responseGet.json();
            } catch (error) {
                console.error(chalk.red('Error fetching Elgato light data:'), error.message);
                return null;
            }
        }

        async setElgatoLightData(host, data) {
            // {"numberOfLights":1,"lights":[{"on":1,"brightness":76,"temperature":344}]}
            data = JSON.stringify({lights: [data]});
            try {
                // console.log(chalk.blue(`Setting Elgato light data for ${host}:`), data);
                const response = await fetch(`http://${host}:9123/elgato/lights`, {
                    method: 'PUT',
                    body: data,
                    headers: { 'Content-type': 'application/json' },
                });
                await response.text();
            } catch (error) {
                console.error(chalk.red('Error setting Elgato light data:'), error.message);
                return null;
            }
        }

        async playDingSound() {
            // First try to play a custom sound file if it exists
            const fs = require('fs');
            const customSound = './sounds/ding.wav';
            
            if (fs.existsSync(customSound)) {
                const command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SoundPlayer]::new('${customSound}').PlaySync()"`;
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        console.error(chalk.red('Error playing sound:'), error.message);
                    }
                });
                console.log(chalk.magenta('🔔 *custom ding*'));
                return;
            }
        }

        async turnOnLights() {
            this.keyLights.forEach(async light => {
                await this.setElgatoLightData(light, {
                    on: 1
                });
            });
        }

        async turnOffLights() {
            this.keyLights.forEach(async light => {
                await this.setElgatoLightData(light, {
                    on: 0,
                });
            });
        }

        async blinkLight(times = 1, duration = 1000) {
            if (this.isBlinking) {
                return;
            }

            this.isBlinking = true;
            console.log(chalk.blue(`💡 Blinking ${this.keyLights.length} light(s) ${times} time(s)`));

            try {

                // Store original states of all lights
                const originalStates = {};
                for (const light of this.keyLights) {
                    originalStates[light] = (await this.getElgatoLightData(light))?.lights[0];
                }
                
                for (let i = 0; i < times; i++) {
                    // Play ding sound
                    await this.playDingSound();


                    // Turn all lights to bright whiteS
                    this.keyLights.forEach(async light => {
                        await this.setElgatoLightData(light, {
                        on: 1,
                        brightness: 100,
                        temperature: 6500
                        });
                    });
                    
                    await this.sleep(duration / 2);
                    
                    // Turn off all lights
                    this.keyLights.forEach(async light => {
                        await this.setElgatoLightData(light, {
                        on: 0,
                        });
                    });

                    if (i < times - 1) {
                        await this.sleep(duration / 2);
                    }
                }
                
                // Restore original states after a brief pause
                await this.sleep(500);

                this.keyLights.forEach(async light => {
                    await this.setElgatoLightData(light, originalStates[light]);
                });

            } catch (error) {
                console.error(chalk.red('Error controlling lights:'), error.message);
            } finally {
                this.isBlinking = false;
            }
        }

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        clearScheduledNotifications() {
            this.scheduledNotifications.forEach(task => {
                if (task.destroy) {
                    task.destroy();
                }
            });

            this.scheduledNotifications = [];
            this.scheduledNotificationLogs = [];
        }

        scheduleLog(message) {
            this.scheduledNotificationLogs.push(message);
        }

        outputScheduledNotificationLogs() {
            console.log(chalk.yellow('================================================================'));
            this.scheduledNotificationLogs.forEach(message => {
                console.log(chalk.blue(message));
            });
        }

        scheduleNotifications(meeting) {
            this.clearScheduledNotifications();

            meeting.videoEntryPoint = meeting.conferenceData?.entryPoints?.find(entryPoint => 
                entryPoint.entryPointType === 'video'
            );

            if (!meeting.videoEntryPoint && meeting.description) {

                // Remove HTML tags from description before searching for Zoom links
                const cleanDescription = meeting.description.replace(/<[^>]*>/g, '');
                
                // Try to find Zoom meeting link in description using regex
                const zoomRegex = /https:\/\/[^\s]*zoom\.us\/j\/[\w\s]*/gi;
                const zoomMatch = cleanDescription.match(zoomRegex);
                
                if (zoomMatch && zoomMatch.length > 0) {
                    meeting.videoEntryPoint = {
                        entryPointType: 'video',
                        uri: zoomMatch[0]
                    };
                    console.log(chalk.green(`🔗 Found Zoom link in description: ${zoomMatch[0]}`));
                }
            }

            if (!meeting.videoEntryPoint && meeting.location) {
                meeting.videoEntryPoint = {
                    entryPointType: 'video',
                    uri: meeting.location
                };
                console.log(chalk.green(`🔗 Found Video link in location: ${meeting.location}`));
            }

            const meetingTime = moment(meeting.start.dateTime);
            const now = moment();
            

            this.scheduleLog(chalk.green(`📅 Next meeting: ${meeting.summary}`));
            this.scheduleLog(chalk.green(`⏰ Start time: ${meetingTime.format('MMMM Do YYYY, h:mm:ss a')}`));

            // Schedule 5 minutes before
            const fiveMinutesBefore = meetingTime.clone().subtract(5, 'minutes');
            if (fiveMinutesBefore.isAfter(now)) {
                const cronTime = fiveMinutesBefore.format('s m H D M d');
                const task1 = cron.schedule(cronTime, () => {
                    console.log(chalk.yellow('🔔 5 minutes until meeting!'));
                    this.blinkLight(1, 2000);
                }, { scheduled: false });
                
                task1.start();
                this.scheduledNotifications.push(task1);
                this.scheduleLog(chalk.blue(`⏱ Scheduled 1 blink at ${fiveMinutesBefore.format('h:mm:ss a')}`));
            }

            // Schedule 1 minute before
            const oneMinuteBefore = meetingTime.clone().subtract(1, 'minutes');
            if (oneMinuteBefore.isAfter(now)) {
                const cronTime = oneMinuteBefore.format('s m H D M d');
                const task2 = cron.schedule(cronTime, () => {
                    console.log(chalk.yellow('🔔 1 minute until meeting!'));
                    this.blinkLight(2, 1500);
                }, { scheduled: false });
                
                task2.start();
                this.scheduledNotifications.push(task2);
                this.scheduleLog(chalk.blue(`⏱ Scheduled 2 blinks at ${oneMinuteBefore.format('h:mm:ss a')}`));
            }

            // Schedule at meeting time
            const cronTime = meetingTime.format('s m H D M d');
            const task3 = cron.schedule(cronTime, async () => {
                console.log(chalk.red('🔔 Meeting starting now!'));
                await this.blinkLight(5, 1000);
                this.openMeetingVideo(meeting);
            }, { scheduled: false });
            
            task3.start();
            this.scheduledNotifications.push(task3);
            this.scheduleLog(chalk.blue(`⏱ Scheduled 5 blinks at ${meetingTime.format('h:mm:ss a')}`));
            if (meeting.videoEntryPoint) {
                this.scheduleLog(chalk.blue(`⏱ Scheduled open meeting video: ${meeting.videoEntryPoint.uri} at ${meetingTime.format('h:mm:ss a')}`));
            }
            else {
                this.scheduleLog(chalk.red(`⏱ No video entry point found for meeting: ${meeting.summary}`));
                this.scheduleLog(chalk.red(JSON.stringify(meeting, null, 2)));
                this.playDingSound();
            }
        }

        openMeetingVideo(meeting) {
            if (meeting.videoEntryPoint) {
                console.log(chalk.blue(`🔗 Opening meeting video: ${meeting.videoEntryPoint.uri}`));
                open.default(meeting.videoEntryPoint.uri);
            }
        }

        async checkForNextMeeting() {
            try {
                const nextMeeting = await this.getNextMeeting();

                if (this.nextMeeting && nextMeeting && this.nextMeeting.id === nextMeeting.id && this.nextMeeting.start.dateTime === nextMeeting.start.dateTime) {
                    console.log(chalk.gray('📅 No new meetings found'));
                    this.outputScheduledNotificationLogs();
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
            } catch (error) {
                console.error(chalk.red('Error checking for meetings:'), error.message);
            }
        }

        start() {
            console.log(chalk.green('🚀 Meeting Notifier started!'));
            console.log(chalk.blue('📱 Checking for meetings every 1 minute...'));
            
            // Check immediately
            this.checkForNextMeeting();
            
            // Check every 5 minutes for new meetings
            cron.schedule('*/1 * * * *', () => {
                console.log(chalk.gray('🔄 Checking for meeting updates...'));
                this.checkForNextMeeting();
            });

            // Keep the process running
            process.on('SIGINT', () => {
                console.log(chalk.yellow('\n👋 Shutting down Meeting Notifier...'));
                this.clearScheduledNotifications();
                process.exit(0);
            });
        }
    }

    // Start the application
    const notifier = new MeetingNotifier();
    notifier.start(); 
})();
