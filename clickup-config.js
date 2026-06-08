/** Resolve ClickUp API base URL and workspace defaults for staging vs production. */

const ENVIRONMENTS = {
    staging: {
        baseUrl: 'https://api.clickup-stg.com',
        defaultWorkspaceId: '333',
        label: 'staging',
    },
    production: {
        baseUrl: 'https://api.clickup.com',
        defaultWorkspaceId: null,
        label: 'production',
    },
};

function resolveClickUpConfig(env = {}) {
    const envName = (env.CLICKUP_ENV || env.environment || 'staging').toLowerCase();
    const preset = ENVIRONMENTS[envName] || ENVIRONMENTS.staging;
    const baseUrl = (env.CLICKUP_API_BASE_URL || preset.baseUrl).replace(/\/+$/, '');
    const workspaceId = String(env.CLICKUP_WORKSPACE_ID || env.workspaceId || preset.defaultWorkspaceId || '').trim();
    return {
        environment: preset.label,
        baseUrl,
        workspaceId,
        token: env.CLICKUP_API_TOKEN || env.apiToken || '',
    };
}

module.exports = { ENVIRONMENTS, resolveClickUpConfig };
