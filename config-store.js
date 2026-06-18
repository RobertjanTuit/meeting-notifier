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
    tunnel: 'tunnel-rules.json',
};

const DEFAULT_TUNNEL_RULES = {
    enabled: false,
    hostname: '',
    localPort: 3921,
    autoUpdateWebhookUrls: true,
};

const DEFAULT_GOOGLE_ACCOUNTS = {
    primary: {
        label: 'Primary',
        enabled: true,
        credentialsFile: 'credentials.json',
        email: '',
    },
    personal: {
        label: 'Personal',
        enabled: true,
        credentialsFile: 'credentials-personal.json',
        email: '',
    },
    work: {
        label: 'Work',
        enabled: true,
        credentialsFile: 'credentials-work.json',
        email: '',
    },
};

const DEFAULT_GOOGLE_RULES = {
    pollIntervalSeconds: 60,
    pushEnabled: false,
    pushWebhookUrl: '',
    accounts: DEFAULT_GOOGLE_ACCOUNTS,
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
        watchTaskIds: [],
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
        desktopNotifications: false,
        floatingAlertBanner: true,
        sounds: {
            default: '',
            meetings: '',
            clickup: '',
            email: '',
            datadog: '',
        },
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

/** Env keys merged from alternate .env files or process.env when missing in the active config. */
const PROCESS_ENV_FALLBACK_KEYS = [
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
    'ELGATO_KEY_LIGHTS', 'CALENDAR_ID', 'TIMEZONE',
    'HA_URL', 'HA_TOKEN', 'HA_NOTIFY_TARGET', 'PUSH_AWAY_THRESHOLD_SECONDS',
    'PUSH_URGENT_MODE', 'HA_DISMISS_ENTITY', 'HA_PUSH_ENTITY',
    'CLICKUP_ENV', 'CLICKUP_API_TOKEN', 'CLICKUP_WORKSPACE_ID', 'CLICKUP_API_BASE_URL',
    'DD_API_KEY', 'DD_APP_KEY', 'DD_SITE',
    'CLOUDFLARE_TUNNEL_TOKEN', 'ALERT_SOUND',
];

function mergeMissingEnvKeys(destEnvPath, ...sourceEnvPaths) {
    if (!fs.existsSync(destEnvPath)) return 0;
    const dest = readEnvObject(destEnvPath);
    const updates = {};
    for (const srcPath of sourceEnvPaths) {
        if (!srcPath || !fs.existsSync(srcPath)) continue;
        const src = readEnvObject(srcPath);
        for (const [key, value] of Object.entries(src)) {
            if (String(value || '').trim() && !String(dest[key] || '').trim()) {
                updates[key] = value;
                dest[key] = value;
            }
        }
    }
    if (Object.keys(updates).length) {
        writeEnvUpdates(destEnvPath, updates);
        console.log(`📂 Merged ${Object.keys(updates).length} env key(s) into ${path.basename(destEnvPath)}`);
    }
    return Object.keys(updates).length;
}

function applyProcessEnvFallbacks(fromFile) {
    const merged = { ...fromFile };
    for (const key of PROCESS_ENV_FALLBACK_KEYS) {
        if (!String(merged[key] || '').trim() && process.env[key]) {
            merged[key] = process.env[key];
        }
    }
    return merged;
}

function setEnvIfNonempty(updates, key, value) {
    if (value != null && String(value).trim() !== '') updates[key] = value;
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
    const rules = readJsonFile(path.join(configDir, RULE_FILES.google), DEFAULT_GOOGLE_RULES);
    const accounts = { ...DEFAULT_GOOGLE_ACCOUNTS, ...(rules.accounts || {}) };
    const result = {};
    for (const [id, acct] of Object.entries(accounts)) {
        const credentialsFile = acct.credentialsFile || `credentials-${id}.json`;
        result[id] = {
            ...acct,
            id,
            credentialsFile,
            connected: fs.existsSync(path.join(configDir, credentialsFile)),
            file: credentialsFile,
        };
    }
    return result;
}

function createConfigStore(configDir, { extraEnvSources = [] } = {}) {
    const envPath = path.join(configDir, '.env');

    function syncEnvFromSources() {
        if (extraEnvSources.length) mergeMissingEnvKeys(envPath, ...extraEnvSources);
        reloadIntoProcess();
    }

    syncEnvFromSources();
    const env = () => applyProcessEnvFallbacks(readEnvObject(envPath));
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
                    pushEntity: e.HA_PUSH_ENTITY || 'input_boolean.orbit_phone_push',
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
            case 'tunnel': {
                const rules = readJsonFile(rulesPath('tunnel'), DEFAULT_TUNNEL_RULES);
                return {
                    token: e.CLOUDFLARE_TUNNEL_TOKEN || '',
                    hostname: rules.hostname || '',
                    localPort: rules.localPort ?? 3921,
                    autoUpdateWebhookUrls: rules.autoUpdateWebhookUrls !== false,
                    rules,
                };
            }
            case 'general':
                return {
                    timezone: e.TIMEZONE || 'America/Los_Angeles',
                    alertSound: e.ALERT_SOUND || '',
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
            tunnel: getSection('tunnel'),
            general: getSection('general'),
        };
    }

    function saveSection(section, patch) {
        const envUpdates = {};
        const restart = {
            calendar: false, lights: false, sound: false, clickup: false, email: false, datadog: false, tunnel: false,
        };
        switch (section) {
            case 'lights':
                envUpdates.ELGATO_KEY_LIGHTS = (patch.hosts || []).map((h) => h.trim()).filter(Boolean).join(',');
                restart.lights = true;
                break;
            case 'google':
                if (patch.clientId != null) envUpdates.GOOGLE_CLIENT_ID = patch.clientId;
                setEnvIfNonempty(envUpdates, 'GOOGLE_CLIENT_SECRET', patch.clientSecret);
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
                if (patch.accounts != null) {
                    const cur = readJsonFile(rulesPath('google'), DEFAULT_GOOGLE_RULES);
                    const merged = { ...DEFAULT_GOOGLE_ACCOUNTS, ...cur.accounts };
                    for (const [id, acct] of Object.entries(patch.accounts)) {
                        const file = acct.credentialsFile || merged[id]?.credentialsFile;
                        if (file && /[/\\]/.test(file)) {
                            throw new Error('Credentials file must be a simple filename in the config folder');
                        }
                        merged[id] = { ...(merged[id] || {}), ...acct };
                    }
                    writeJsonFile(rulesPath('google'), { ...cur, accounts: merged });
                }
                restart.calendar = true;
                break;
            case 'homeassistant':
                if (patch.url != null) envUpdates.HA_URL = patch.url;
                setEnvIfNonempty(envUpdates, 'HA_TOKEN', patch.token);
                if (patch.notifyTarget != null) envUpdates.HA_NOTIFY_TARGET = patch.notifyTarget;
                if (patch.awayThresholdSeconds != null) envUpdates.PUSH_AWAY_THRESHOLD_SECONDS = String(patch.awayThresholdSeconds);
                if (patch.urgentMode != null) envUpdates.PUSH_URGENT_MODE = patch.urgentMode;
                if (patch.dismissEntity != null) envUpdates.HA_DISMISS_ENTITY = patch.dismissEntity;
                if (patch.pushEntity != null) envUpdates.HA_PUSH_ENTITY = patch.pushEntity;
                break;
            case 'clickup':
                if (patch.env != null) envUpdates.CLICKUP_ENV = patch.env;
                setEnvIfNonempty(envUpdates, 'CLICKUP_API_TOKEN', patch.apiToken);
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
                setEnvIfNonempty(envUpdates, 'DD_API_KEY', patch.apiKey);
                setEnvIfNonempty(envUpdates, 'DD_APP_KEY', patch.appKey);
                if (patch.site != null) envUpdates.DD_SITE = patch.site;
                if (patch.rules != null) writeJsonFile(rulesPath('datadog'), { ...getSection('datadog').rules, ...patch.rules });
                restart.datadog = true;
                break;
            case 'alerts':
                writeJsonFile(rulesPath('alerts'), patch);
                break;
            case 'tunnel':
                setEnvIfNonempty(envUpdates, 'CLOUDFLARE_TUNNEL_TOKEN', patch.token);
                if (patch.rules != null) {
                    writeJsonFile(rulesPath('tunnel'), {
                        ...readJsonFile(rulesPath('tunnel'), DEFAULT_TUNNEL_RULES),
                        ...patch.rules,
                    });
                }
                if (patch.hostname != null || patch.localPort != null || patch.autoUpdateWebhookUrls != null) {
                    const cur = readJsonFile(rulesPath('tunnel'), DEFAULT_TUNNEL_RULES);
                    writeJsonFile(rulesPath('tunnel'), {
                        ...cur,
                        ...(patch.hostname != null ? { hostname: patch.hostname } : {}),
                        ...(patch.localPort != null ? { localPort: Number(patch.localPort) || 3921 } : {}),
                        ...(patch.autoUpdateWebhookUrls != null
                            ? { autoUpdateWebhookUrls: patch.autoUpdateWebhookUrls }
                            : {}),
                    });
                }
                restart.tunnel = true;
                break;
            case 'general':
                if (patch.timezone != null) envUpdates.TIMEZONE = patch.timezone;
                if (patch.alertSound != null) {
                    envUpdates.ALERT_SOUND = patch.alertSound;
                    restart.sound = true;
                }
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

    return {
        configDir,
        envPath,
        getAll,
        getSection,
        saveSection,
        reloadIntoProcess,
        syncEnvFromSources,
        getClaudeConfig,
        mergeMissingEnvKeys,
    };
}

module.exports = {
    createConfigStore,
    mergeMissingEnvKeys,
    DEFAULT_RULES,
    DEFAULT_GOOGLE_RULES,
    DEFAULT_GOOGLE_ACCOUNTS,
    DEFAULT_TUNNEL_RULES,
    RULE_FILES,
};
