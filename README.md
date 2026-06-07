# Meeting Notifier

A Node.js terminal application that connects to your Google Calendar and controls Elgato lights to notify you of upcoming meetings.

Cross-platform: works on **macOS**, **Windows**, and **Linux**.

## Features

- 🗓️ Connects to Google Calendar API
- 💡 Controls Elgato Key Light/Light Strip
- ⏰ Smart notification timing:
  - 1 blink at 5 minutes before meeting
  - 2 blinks at 1 minute before meeting
  - 5 blinks when meeting starts
- 🔄 Automatically checks for meeting updates every 5 minutes
- 🎨 Beautiful colored terminal output
- 🔔 Plays ding sound notification with light blinking
- 📱 Optional phone push via Home Assistant when away from the Mac (Android companion app, DnD-bypassing)

## Prerequisites

1. **Google Calendar API Setup**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable the Google Calendar API
   - Create credentials (OAuth 2.0 Client ID)
   - Add `http://localhost:3000/oauth2callback` as authorized redirect URI

2. **Elgato Light**:
   - Ensure your Elgato light is connected to the same network
   - Find your light's IP address (check your router or use network scanner)
   - You'll need to configure the IP addresses manually

## Installation

1. Clone this repository or create the files in a new directory
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the environment file and configure:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your configuration:
   ```
   GOOGLE_CLIENT_ID=your_google_client_id_here
   GOOGLE_CLIENT_SECRET=your_google_client_secret_here
   GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
   ELGATO_KEY_LIGHTS=192.168.1.100,192.168.1.101
   CALENDAR_ID=primary
   TIMEZONE=America/New_York
   ```

## Setup Authentication

Before running the main application, you need to authenticate with Google:

```bash
node setup-auth.js
```

Follow the prompts to:
1. Visit the provided Google OAuth URL
2. Grant permissions to access your calendar
3. Copy the authorization code back to the terminal

This will create a `credentials.json` file with your authentication tokens.

## Usage

You can run Meeting Notifier in two ways:

### CLI / terminal mode

```bash
npm start
```

Or with auto-restart for development:

```bash
npm run dev
```

### macOS menu bar mode

A small Electron-based menu bar (top of the screen) app that wraps the same logic.

Run it directly during development:

```bash
npm run tray
```

Or build a real `.app` bundle you can drag to `/Applications`:

```bash
# 1. .app only (faster, used for local install)
npm run dist:mac-dir
open "dist/mac-arm64/Meeting Notifier.app"

# 2. signed .dmg installer
npm run dist:mac
open dist/*.dmg
```

The menu bar app:

- Shows a calendar icon in the menu bar with a small status label (`5m`, `now`, `In meeting`, …)
- Click the icon to see the next meeting, open or copy its link, refresh the calendar, do a test blink, flash the screen, test phone push, view the events log, toggle "Push to phone when away", or toggle "Launch at login"
- Hides the dock icon — it lives only in the menu bar
- Works on Apple Silicon and Intel Macs

#### Screen flash

In addition to the Elgato lights, the menu bar app flashes the **whole screen** white at each
notification moment (1 flash at 5 min, 2 at 1 min, 5 at start). It uses a borderless,
click-through, always-on-top overlay on every connected display, and shows even over
fullscreen apps (e.g. a fullscreen Zoom window). Use **Test screen flash** in the menu to preview it.

Screen flashing is only available in the menu bar app (it needs a GUI) — the plain `npm start`
terminal mode only controls the Elgato lights.

#### Config locations

When run via `npm run tray` (development), `.env` and `credentials.json` live in the project folder.

When run from the bundled `.app`, the app reads them from a fixed location:

```
~/Library/Application Support/meeting-notifier/
  ├── .env
  ├── credentials.json
  ├── calendars.json      (optional per-calendar overrides)
  ├── settings.json       (runtime UI settings, e.g. push toggle)
  └── events-log.json     (written by the app)
```

There's an "Open config folder" item in the menu bar dropdown (and the console window's first-run dialog) to reveal it. To set it up, copy your project `.env` and `credentials.json` into that folder. If credentials are missing, the app will start the one-time Google sign-in automatically on launch.

The application will:
- 🚀 Start and connect to both Google Calendar and Elgato lights
- 📅 Check for your next meeting
- ⏱️ Schedule notifications based on meeting time
- 🔄 Automatically refresh every 5 minutes for new meetings
- 💡 Blink your lights at the appropriate times
- 🔔 Play ding sound with each notification

## Configuration Options

### Environment Variables

- `GOOGLE_CLIENT_ID`: Your Google OAuth client ID
- `GOOGLE_CLIENT_SECRET`: Your Google OAuth client secret
- `GOOGLE_REDIRECT_URI`: OAuth redirect URI (keep as `http://localhost:3000/oauth2callback`)
- `ELGATO_KEY_LIGHTS`: Comma-separated list of Elgato light IP addresses
- `CALENDAR_ID`: Google Calendar ID to monitor (default: 'primary')
- `TIMEZONE`: Your timezone (default: 'America/New_York')
- `HA_URL`: Externally reachable Home Assistant URL (e.g. Nabu Casa `https://xxxx.ui.nabu.casa`)
- `HA_TOKEN`: Long-lived access token from HA Profile → Security → Long-Lived Access Tokens
- `HA_NOTIFY_TARGET`: Notify service for your phone (e.g. `mobile_app_pixel_8` — find in HA Developer Tools → Services or Settings → Devices → your phone)
- `PUSH_AWAY_THRESHOLD_SECONDS`: Mac idle seconds before phone push is allowed (default: `300`)

### Phone push via Home Assistant

When you're away from the Mac (screen locked or idle for the threshold above), the menu bar app can mirror meeting alerts to your Android phone through the [Home Assistant companion app](https://companion.home-assistant.io/).

**Setup:**

1. Add `HA_URL`, `HA_TOKEN`, and `HA_NOTIFY_TARGET` to `.env` (use your **externally reachable** HA URL — Nabu Casa or a reverse proxy — not `homeassistant.local`).
2. Create a long-lived token in Home Assistant: Profile → Security → Long-Lived Access Tokens.
3. Find your notify target: Developer Tools → Services → `notify.mobile_app_…`, or Settings → Devices → your phone → look for the notify entity name.
4. In the tray menu, ensure **Push to phone when away** is checked (default on; persisted in `settings.json`).
5. On Android, open the HA companion app → Notifications → find the **Meeting Reminders** channel and enable **Override Do Not Disturb** (one-time, per-channel). Urgent alerts use TTS + `alarm_stream_max` by default (or `alarm_stream` if `PUSH_URGENT_MODE=alarm_stream`).

**Dismiss from your phone (optional):** Urgent phone notifications include a **Dismiss** button. Tapping it silences the Mac's blinking overdue alert even when you're away. One-time HA setup:

1. Create helper **Toggle** → entity `input_boolean.meeting_notifier_dismiss` (or copy `ha/meeting-notifier-dismiss.yaml` into your HA `packages/` folder).
2. Create automation: trigger **Event** `mobile_app_notification_action` with `action: MN_DISMISS` → action **Turn on** that helper. See `ha/meeting-notifier-dismiss.yaml` for the full YAML.
3. Optional in `.env`: `HA_DISMISS_ENTITY=input_boolean.meeting_notifier_dismiss` (this is the default).

The Mac polls that helper every 3 seconds while an overdue alert is active.

**Urgency:**

| Alert | HA delivery |
|-------|-------------|
| 5 min / 1 min reminder | `Meeting Reminders` channel, high importance |
| Meeting start + overdue nag | TTS + `alarm_stream_max` (default), with Dismiss / Open buttons |

**Per-calendar:** In `calendars.json`, set `"push": false` on a calendar to skip phone push while keeping desktop alerts. See `calendars.example.json`.

**Test:**

```bash
npm run test-push              # gentle + urgent test pushes
npm run test-push -- --gentle-only
npm run test-push -- --urgent-only
```

Or use **Test phone push** items in the menu bar dropdown (bypasses away detection).

### Notification Timing

You can modify the notification timing in `index.js`:
- Change the minutes before meeting (currently 5 and 1 minute)
- Adjust the number of blinks (currently 1, 2, and 5)
- Modify blink duration and intensity

### Custom Sound

To use a custom notification sound:
1. Create a `sounds/` directory in your project
2. Place your sound file as `ding.wav` in the sounds directory
3. The app will automatically use your custom sound

## Troubleshooting

### Google Calendar Issues
- Ensure your Google Cloud project has Calendar API enabled
- Check that your OAuth credentials are correct
- Verify the redirect URI matches exactly
- Make sure you granted calendar read permissions

### Elgato Light Issues
- Verify the lights are on the same network as your computer
- Check the IP addresses are correct in your .env file
- Try pinging each light: `ping [LIGHT_IP]`
- Ensure the lights are powered on and connected to WiFi

### Sound Issues
- A `sounds/ding.wav` file is included and played on each notification
- macOS uses `afplay` (built in)
- Windows uses PowerShell's `System.Media.SoundPlayer`
- Linux uses `paplay` (PulseAudio) or falls back to `aplay` (ALSA) — install one if neither is available

### Zoom Detection
The app turns on your Elgato lights automatically while a Zoom meeting is active:
- macOS: detects the `CptHost` process (only running during an active meeting)
- Windows: looks for a window titled like `*zoom meeting*`
- Linux: best-effort match on a `zoom` process via `pgrep -f`

### General Issues
- Check that all environment variables are set correctly
- Ensure Node.js version is compatible (recommended: Node 16+)
- Verify all dependencies are installed: `npm install`

## How It Works

1. **Initialization**: Connects to Google Calendar API and Elgato light
2. **Meeting Detection**: Fetches the next meeting from your calendar
3. **Scheduling**: Uses cron jobs to schedule notifications at specific times
4. **Light Control**: Controls Elgato light brightness and blinking patterns
5. **Monitoring**: Continuously monitors for meeting changes every 5 minutes

## License

MIT License - feel free to modify and use as needed!

## Contributing

Feel free to submit issues and enhancement requests! 