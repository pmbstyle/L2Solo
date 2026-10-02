const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');

// Founders are the top share (5%) of founder character within each primary
// drive, so social and wealth bots found clans too, not only the ambitious
// progression type the old fixed trait thresholds admitted.
const traits = (ambition, assertiveness, resilience, sociability, commitment) => ({ ambition, assertiveness, resilience, sociability, commitment });
const personas = [];
for (let i = 0; i < 100; i += 1) {
    const step = i / 100;
    personas.push({ primaryDrive: 'progression', traits: traits(0.7 + step * 0.25, 0.5 + step * 0.4, 0.6, 0.5, 0.5) });
    personas.push({ primaryDrive: 'social', traits: traits(0.5, 0.4 + step * 0.3, 0.6, 0.7 + step * 0.25, 0.7 + step * 0.2) });
    personas.push({ primaryDrive: 'wealth', traits: traits(0.6 + step * 0.3, 0.3 + step * 0.3, 0.7, 0.3 + step * 0.2, 0.45) });
}
const table = Policy.founderThresholds(personas, 0.05);
assert.deepStrictEqual(Object.keys(table).sort(), ['progression', 'social', 'wealth']);

const candidate = (drive, t) => ({ characterId: 1, classId: 4, level: 25, clanId: 0, partyHistory: { 2: { runs: 1 } },
    persona: { primaryDrive: drive, traits: t } });
const eligible = (c) => Policy.founderEligibility(c, { quorumCandidates: [1, 2, 3, 4, 5], founderThresholds: table });

// The strongest wealth bot founds, although it is far below the old thresholds
// (ambition 0.80, assertiveness 0.70, sociability 0.55).
const topTrader = candidate('wealth', personas.filter((p) => p.primaryDrive === 'wealth').at(-1).traits);
assert.strictEqual(eligible(topTrader).ok, true, eligible(topTrader).reasons.join(','));
const topSocial = candidate('social', personas.filter((p) => p.primaryDrive === 'social').at(-1).traits);
assert.strictEqual(eligible(topSocial).ok, true);
// An ordinary bot of any drive does not.
assert.strictEqual(eligible(candidate('wealth', personas[2 + 3 * 50].traits)).ok, false);
assert.strictEqual(eligible(candidate('progression', personas[3 * 50].traits)).ok, false);
// Without a table nobody founds.
assert.strictEqual(Policy.founderEligibility(topTrader, { quorumCandidates: [1, 2, 3, 4, 5] }).ok, false);
console.log('Clan founder threshold checks passed');
