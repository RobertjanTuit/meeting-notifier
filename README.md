# Meeting Notifier

A Node.js terminal application that connects to your Google Calendar and controls Elgato lights to notify you of upcoming meetings.

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

Start the meeting notifier:

```bash
npm start
```

Or for development with auto-restart:

```bash
npm run dev
```

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
- The app will try to play system sounds automatically
- For custom sounds, place a `ding.wav` file in the `sounds/` directory
- If no sound plays, the app will fall back to console beep

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