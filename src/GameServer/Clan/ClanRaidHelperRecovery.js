'use strict';
const Expedition = require('./ClanRaidExpedition');
const RESTART_MS = 90000;

// Stepped by the encounter's existing resolve, never by a new timer/job. A
// helper can restart and recover while the main party continues fighting.
function recover(party, members, timestamp, elapsedMs) {
    const results = new Map();
    const resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    for (const state of members) {
        if (!Expedition.helper(party, state)) continue;
        let recovery = state.stats?.raidHelperRecovery;
        if (!(state.vitals.hp > 0)) {
            recovery ||= { restartAt: timestamp + RESTART_MS };
            const result = timestamp < recovery.restartAt ? { patch: {}, events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: recovery.restartAt }
                : resolver.resolveDeathRecovery(state, timestamp);
            result.patch.stats = { ...(result.patch.stats || state.stats), raidHelperRecovery: recovery };
            if (result.patch.vitals) result.patch.stats.coldCombat = { ...result.patch.stats.coldCombat, effects: [] };
            results.set(state.characterId, result);
        } else if (recovery) {
            const result = resolver.resolveRest(state, elapsedMs, timestamp, { party: true, requireMana: true });
            if (result.patch.activity !== 'resting') {
                const preparedState = { ...state, ...result.patch, stats: { ...result.patch.stats, raidHelperRecovery: null } };
                const preparation = resolver.prepareRaidParty([preparedState], timestamp);
                const prepared = preparation.memberResults[0].result;
                prepared.patch.stats.raidHelperRecovery = preparation.ready ? null : recovery;
                results.set(state.characterId, prepared);
            } else {
                result.patch.stats.raidHelperRecovery = recovery;
                results.set(state.characterId, result);
            }
        }
    }
    return results;
}
module.exports = { recover, RESTART_MS };
