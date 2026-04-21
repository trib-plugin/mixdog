import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
let cachedToken = null;
/**
 * Load GitHub OAuth token from standard locations.
 * Priority: GITHUB_TOKEN env → hosts.json → apps.json
 */
export function loadGitHubToken() {
    // 1. Environment variable
    if (process.env.GITHUB_TOKEN)
        return process.env.GITHUB_TOKEN;
    // 2. GitHub Copilot config files
    const configDir = process.env.XDG_CONFIG_HOME
        || (process.platform === 'win32'
            ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
            : join(homedir(), '.config'));
    const filePaths = [
        join(configDir, 'github-copilot', 'hosts.json'),
        join(configDir, 'github-copilot', 'apps.json'),
    ];
    for (const filePath of filePaths) {
        try {
            const data = JSON.parse(readFileSync(filePath, 'utf-8'));
            for (const [key, value] of Object.entries(data)) {
                if (key.includes('github.com') && typeof value === 'object' && value !== null) {
                    const oauthToken = value.oauth_token;
                    if (typeof oauthToken === 'string')
                        return oauthToken;
                }
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * Exchange GitHub OAuth token for Copilot bearer token.
 * Caches the token until it expires.
 */
export async function getCopilotBearerToken() {
    // Return cached if not expired (with 60s buffer)
    if (cachedToken && cachedToken.expiresAt > Date.now() / 1000 + 60) {
        return cachedToken.token;
    }
    const githubToken = loadGitHubToken();
    if (!githubToken)
        return null;
    const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
            'Authorization': `Token ${githubToken}`,
            'User-Agent': 'mixdog-agent/1.0',
        },
    });
    if (!response.ok)
        return null;
    const data = await response.json();
    cachedToken = { token: data.token, expiresAt: data.expires_at };
    return data.token;
}
