const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const chalk = require('chalk');
const express = require('express');
require('dotenv').config();

// Check if credentials.json already exists
if (fs.existsSync('./credentials.json')) {
    console.log(chalk.red('❌ credentials.json already exists!'));
    console.log(chalk.yellow('If you want to recreate your credentials, please remove credentials.json and run this script again.'));
    process.exit(0);
}

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const app = express();
app.use(express.static('public'));
app.use(express.json());
app.get('/auth', async (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
    res.redirect(authUrl);
});
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
  
    try {
      const { tokens } = await oauth2Client.getToken(code);
      fs.writeFileSync('./credentials.json', JSON.stringify(tokens, null, 2));
      res.send('Authentication successful! You can now close this window.');
    } catch (error) {
      res.send('Authentication failed. Please try again.<br/><pre>' + JSON.stringify(error, null, 2) + '</pre>');
    } 
});
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

async function setupAuthentication() {

    console.log(chalk.blue('🔐 Setting up Google Calendar authentication...\n'));
    console.log(chalk.yellow('1. Please visit this URL in your browser:'));
    console.log(chalk.cyan('http://localhost:3000/auth'));
    console.log(chalk.yellow('\n2. After authentication, you will be redirected to a URL.'));
    console.log(chalk.yellow('3. Copy the authorization code from the URL and paste it here.\n'));

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log('waiting for response on http://localhost:3000/oauth2callback');

    while (!fs.existsSync('./credentials.json')) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    }
    console.log(chalk.green('✅ Authentication completed! Credentials saved.'));
    rl.close();
    process.exit(0);
}

setupAuthentication(); 