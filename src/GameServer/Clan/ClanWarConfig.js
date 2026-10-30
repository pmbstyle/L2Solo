'use strict';
const defaults = { enabled: true, hostilityThreshold: 25, minHarmEpisodes: 3,
    reviewMs: 60000, intelTtlMs: 15 * 60000, operationMs: 15 * 60000, operationCooldownMs: 10 * 60000,
    quietWithdrawMs: 3600000, redeclareCooldownMs: 6 * 3600000, lossWindowMs: 3600000, counterattackCooldownMs: 2 * 60000,
    minMembers: 3, maxMembers: 9, maxActiveOperations: 4 };
const config = { ...defaults };
function reload() {
    const source = global.options?.default?.ClanWars || {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const value = source[key];
        config[key] = typeof fallback === 'boolean' ? value === undefined ? fallback : value !== false && value !== 'false'
            : Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
    }
    config.hostilityThreshold = Math.max(20, Math.min(90, config.hostilityThreshold));
    config.minMembers = Math.max(3, Math.min(9, Math.floor(config.minMembers)));
    config.maxMembers = Math.max(config.minMembers, Math.min(9, Math.floor(config.maxMembers)));
    return config;
}
Object.defineProperty(config, 'reload', { value: reload });
reload();
module.exports = config;
