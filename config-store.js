/**
 * Unified configuration read/write for Orbit Settings.
 */
const fs = require('fs');
const path = require('path');

const RULE_FILES = {
    google: 'google-rules.json',
    clickup: 'clickup-rules.json',
    email: 'email-rules.json',
    datadog: 'datadog-rules.json',
    alerts: 'alert-rules.json',
};

const DEFAULT_GOOGLE_RULES = {
    pollIntervalSeconds: 60,
    pushEnabled: false,
    pushWebhookUrl: '',
};

const DEFAULT_RULES = {
    clickup: {
        enabled: false,
        environment: 'staging',
        workspaceId: '333',
        myUserId: null,
        pollIntervalSeconds: 30,
        watchChannelIds: [],
        watchPeople: [],
        webhookUrl: '',
        webhookId: null,
        webhookSecret: '',
        rules: {
            dmFromPeople: true,
            mentionMe: true,
            mentionMyGroups: true,
            taskCommentMention: true,
            taskAssignedToMe: true,
            taskTagMatch: [],
        },
    },
    email: {
        enabled: false,
        pollIntervalSeconds: 120,
        claudeEnabled: true,
        minConfidence: 0.8,
        skipCategories: ['promotions', 'social', 'updates'],
        defaultClaudeModel: 'claude-haiku-4-5',
        accounts: {
            personal: {
                enabled: true, email: '', credentialsFile: 'credentials-personal.json',
                claudeApiKey: '', claudeModel: 'claude-haiku-4-5', color: 'red', label: 'Personal',
            },
            work: {
                enabled: true, email: '', credentialsFile: 'credentials-work.json',
                claudeApiKey: '', claudeModel: 'claude-haiku-4-5', color: 'yellow', label: 'Work',
            },
        },
        allowlistDomains: [],
        blocklistDomains: [],
        quietHours: { start: '22:00', end: '07:00' },
    },
    datadog: {
        enabled: false,
        monitorNamePatterns: [],
        monitorTagPatterns: [],
        severity: { warning: 'gentle', alert: 'urgent' },
    },
    alerts: {
        quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        sources: {
            meetings: { lights: true, sound: true, flash: true, push: true },
            clickup: { lights: true, sound: true, flash: false, push: true },
            email: { lights: true, sound: false, flash: false, push: true },
            datadog: { lights: true, sound: true, flash: true, push: false },
        },
    },
};

function unquoteEnvValue(raw) {
    const v = (raw ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
}

function quoteEnvValue(value) {
    const s = value == null ? '' : String(value);
    if (/[\s#"'=]/.test(s) || s === '') return JSON.stringify(s);
    return s;
}

function readEnvObject(envPath) {
    const result = {};
    if (!fs.existsSync(envPath)) return result;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) result[m[1]] = unquoteEnvValue(m[2]);
    }
    return result;
}

function writeEnvUpdates(envPath, updates) {
    const dir = path.dirname(envPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    const written = new Set();
    lines = lines.map((line) => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
            written.add(m[1]);
            return `${m[1]}=${quoteEnvValue(updates[m[1]])}`;
        }
        return line;
    });
    for (const [key, value] of Object.entries(updates)) {
        if (!written.has(key)) lines.push(`${key}=${quoteEnvValue(value)}`);
    }
    if (fs.existsSync(envPath)) {
        try { fs.copyFileSync(envPath, `${envPath}.bak`); } catch { /* noop */ }
    }
    fs.writeFileSync(envPath, lines.join('\n').replace(/\n?$/, '\n'));
}

function readJsonFile(filePath, defaults) {
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) }; }
    catch { return { ...defaults }; }
}

function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readCalendars(configDir) {
    try { return JSON.parse(fs.readFileSync(path.join(configDir, 'calendars.json'), 'utf8')); }
    catch {
        return { _defaults: { notify: true, autoOpen: true, warnNoLink: true, push: true } };
    }
}

function googleAccountStatus(configDir) {
    return {
        primary: { connected: fs.existsSync(path.join(configDir, 'credentials.json')), file: 'credentials.json' },
        personal: { connected: fs.existsSync(path.join(configDir, 'credentials-personal.json')), file: 'credentials-personal.json' },
        work: { connected: fs.existsSync(path.join(configDir, 'credentials-work.json')), file: 'credentials-work.json' },
    };
}

function createConfigStore(configDir) {
    const envPath = path.join(configDir, '.env');
    const env = () => readEnvObject(envPath);
    const rulesPath = (name) => path.join(configDir, RULE_FILES[name]);

    function getSection(section) {
        const e = env();
        switch (section) {
            case 'lights':
                return {
                    enabled: Boolean(e.ELGATO_KEY_LIGHTS?.trim()),
                    hosts: (e.ELGATO_KEY_LIGHTS || '').split(',').map((h) => h.trim()).filter(Boolean),
                };
            case 'google': {
                const googleRules = readJsonFile(rulesPath('google'), DEFAULT_GOOGLE_RULES);
                return {
                    clientId: e.GOOGLE_CLIENT_ID || '',
                    clientSecret: e.GOOGLE_CLIENT_SECRET || '',
                    redirectUri: e.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
                    calendarIds: (e.CALENDAR_ID || 'primary').split(',').map((s) => s.trim()).filter(Boolean),
                    calendars: readCalendars(configDir),
                    accounts: googleAccountStatus(configDir),
                    pollIntervalSeconds: googleRules.pollIntervalSeconds ?? 60,
                    pushEnabled: Boolean(googleRules.pushEnabled),
                    pushWebhookUrl: googleRules.pushWebhookUrl || '',
                    googleRules,
                };
            }
            case 'homeassistant':
                return {
                    url: e.HA_URL || '',
                    token: e.HA_TOKEN || '',
                    notifyTarget: e.HA_NOTIFY_TARGET || '',
                    awayThresholdSeconds: e.PUSH_AWAY_THRESHOLD_SECONDS || '300',
                    urgentMode: e.PUSH_URGENT_MODE || 'tts',
                    dismissEntity: e.HA_DISMISS_ENTITY || 'input_boolean.orbit_dismiss',
                };
            case 'clickup': {
                const rules = readJsonFile(rulesPath('clickup'), DEFAULT_RULES.clickup);
                return {
                    env: e.CLICKUP_ENV || rules.environment || 'staging',
                    apiToken: e.CLICKUP_API_TOKEN || '',
                    workspaceId: e.CLICKUP_WORKSPACE_ID || rules.workspaceId || '333',
                    apiBaseUrl: e.CLICKUP_API_BASE_URL || '',
                    rules,
                };
            }
            case 'email': {
                const rules = readJsonFile(rulesPath('email'), DEFAULT_RULES.email);
                return { rules };
            }
            case 'datadog': {
                const rules = readJsonFile(rulesPath('datadog'), DEFAULT_RULES.datadog);
                return { apiKey: e.DD_API_KEY || '', appKey: e.DD_APP_KEY || '', site: e.DD_SITE || 'datadoghq.com', rules };
            }
            case 'alerts':
                return readJsonFile(rulesPath('alerts'), DEFAULT_RULES.alerts);
            case 'general':
                return {
                    timezone: e.TIMEZONE || 'America/Los_Angeles',
                    audioOutput: e.AUDIO_OUTPUT_DEVICE || 'BlackHole 2ch',
                    audioInput: e.AUDIO_INPUT_DEVICE || 'Elgato Wave Link Chat Mix',
                    waveLinkProcess: e.WAVE_LINK_PROCESS || 'WaveLinkMacOS',
                    waveLinkAppPath: e.WAVE_LINK_APP_PATH || '/Applications/Elgato Wave Link.app',
                    waveLinkBundleId: e.WAVE_LINK_BUNDLE_ID || 'com.elgato.WaveLink3',
                };
            default:
                throw new Error(`Unknown settings section: ${section}`);
        }
    }

    function getAll() {
        return {
            configDir,
            lights: getSection('lights'),
            google: getSection('google'),
            homeassistant: getSection('homeassistant'),
            clickup: getSection('clickup'),
            email: getSection('email'),
            datadog: getSection('datadog'),
            alerts: getSection('alerts'),
            general: getSection('general'),
        };
    }

    function saveSection(section, patch) {
        const envUpdates = {};
        const restart = { calendar: false, lights: false, clickup: false, email: false, datadog: false };
        switch (section) {
            case 'lights':
                envUpdates.ELGATO_KEY_LIGHTS = (patch.hosts || []).map((h) => h.trim()).filter(Boolean).join(',');
                restart.lights = true;
                break;
            case 'google':
                if (patch.clientId != null) envUpdates.GOOGLE_CLIENT_ID = patch.clientId;
                if (patch.clientSecret != null) envUpdates.GOOGLE_CLIENT_SECRET = patch.clientSecret;
                if (patch.redirectUri != null) envUpdates.GOOGLE_REDIRECT_URI = patch.redirectUri;
                if (patch.calendarIds != null) envUpdates.CALENDAR_ID = patch.calendarIds.join(',');
                if (patch.calendars != null) writeJsonFile(path.join(configDir, 'calendars.json'), patch.calendars);
                if (patch.googleRules != null) {
                    writeJsonFile(rulesPath('google'), { ...getSection('google').googleRules, ...patch.googleRules });
                }
                if (patch.pollIntervalSeconds != null || patch.pushEnabled != null || patch.pushWebhookUrl != null) {
                    const cur = getSection('google').googleRules;
                    writeJsonFile(rulesPath('google'), {
                        ...cur,
                        ...(patch.pollIntervalSeconds != null ? { pollIntervalSeconds: patch.pollIntervalSeconds } : {}),
                        ...(patch.pushEnabled != null ? { pushEnabled: patch.pushEnabled } : {}),
                        ...(patch.pushWebhookUrl != null ? { pushWebhookUrl: patch.pushWebhookUrl } : {}),
                    });
                }
                restart.calendar = true;
                break;
            case 'homeassistant':
                if (patch.url != null) envUpdates.HA_URL = patch.url;
                if (patch.token != null) envUpdates.HA_TOKEN = patch.token;
                if (patch.notifyTarget != null) envUpdates.HA_NOTIFY_TARGET = patch.notifyTarget;
                if (patch.awayThresholdSeconds != null) envUpdates.PUSH_AWAY_THRESHOLD_SECONDS = String(patch.awayThresholdSeconds);
                if (patch.urgentMode != null) envUpdates.PUSH_URGENT_MODE = patch.urgentMode;
                if (patch.dismissEntity != null) envUpdates.HA_DISMISS_ENTITY = patch.dismissEntity;
                break;
            case 'clickup':
                if (patch.env != null) envUpdates.CLICKUP_ENV = patch.env;
                if (patch.apiToken != null) envUpdates.CLICKUP_API_TOKEN = patch.apiToken;
                if (patch.workspaceId != null) envUpdates.CLICKUP_WORKSPACE_ID = String(patch.workspaceId);
                if (patch.apiBaseUrl != null) envUpdates.CLICKUP_API_BASE_URL = patch.apiBaseUrl;
                if (patch.rules != null) writeJsonFile(rulesPath('clickup'), { ...getSection('clickup').rules, ...patch.rules });
                restart.clickup = true;
                break;
            case 'email': {
                const cur = getSection('email').rules;
                const next = patch.rules ? { ...cur, ...patch.rules } : { ...cur };
                if (patch.accounts) {
                    next.accounts = { ...cur.accounts };
                    for (const [id, acct] of Object.entries(patch.accounts)) {
                        next.accounts[id] = { ...(cur.accounts?.[id] || {}), ...acct };
                    }
                }
                if (patch.rules || patch.accounts) writeJsonFile(rulesPath('email'), next);
                restart.email = true;
                break;
            }
            case 'datadog':
                if (patch.apiKey != null) envUpdates.DD_API_KEY = patch.apiKey;
                if (patch.appKey != null) envUpdates.DD_APP_KEY = patch.appKey;
                if (patch.site != null) envUpdates.DD_SITE = patch.site;
                if (patch.rules != null) writeJsonFile(rulesPath('datadog'), { ...getSection('datadog').rules, ...patch.rules });
                restart.datadog = true;
                break;
            case 'alerts':
                writeJsonFile(rulesPath('alerts'), patch);
                break;
            case 'general':
                if (patch.timezone != null) envUpdates.TIMEZONE = patch.timezone;
                if (patch.audioOutput != null) envUpdates.AUDIO_OUTPUT_DEVICE = patch.audioOutput;
                if (patch.audioInput != null) envUpdates.AUDIO_INPUT_DEVICE = patch.audioInput;
                if (patch.waveLinkProcess != null) envUpdates.WAVE_LINK_PROCESS = patch.waveLinkProcess;
                if (patch.waveLinkAppPath != null) envUpdates.WAVE_LINK_APP_PATH = patch.waveLinkAppPath;
                if (patch.waveLinkBundleId != null) envUpdates.WAVE_LINK_BUNDLE_ID = patch.waveLinkBundleId;
                restart.calendar = true;
                break;
            default:
                throw new Error(`Unknown settings section: ${section}`);
        }
        if (Object.keys(envUpdates).length) writeEnvUpdates(envPath, envUpdates);
        return { restart };
    }

    function reloadIntoProcess() {
        const dotenv = require('dotenv');
        if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: true });
    }

    function getClaudeConfig(accountId) {
        const { rules } = getSection('email');
        const acct = rules.accounts?.[accountId] || {};
        return {
            apiKey: acct.claudeApiKey || '',
            model: acct.claudeModel || rules.defaultClaudeModel || 'claude-haiku-4-5',
        };
    }

    return { configDir, envPath, getAll, getSection, saveSection, reloadIntoProcess, getClaudeConfig };
}

module.exports = { createConfigStore, DEFAULT_RULES, DEFAULT_GOOGLE_RULES, RULE_FILES };
