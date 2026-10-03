const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');

// Founders are the top share (5%) of leaders within each primary drive, by
// leadership (assertiveness) and sociability: social and wealth bots found
// clans too, and every founder is a leader of its kind.
const traits = (assertiveness, sociability, ambition = 0.6) => ({ ambition, assertiveness, resilience: 0.6, sociability, commitment: 0.6 });
const personas = [];
for (let i = 0; i < 100; i += 1) {
    const step = i / 100;
    personas.push({ primaryDrive: 'progression', traits: traits(0.55 + step * 0.4, 0.5, 0.9) });
    personas.push({ primaryDrive: 'social', traits: traits(0.4 + step * 0.3, 0.7 + step * 0.25, 0.5) });
    personas.push({ primaryDrive: 'wealth', traits: traits(0.3 + step * 0.3, 0.3 + step * 0.2, 0.8) });
}
const table = Policy.founderThresholds(personas, 0.05);
assert.deepStrictEqual(Object.keys(table).sort(), ['progression', 'social', 'wealth']);

const candidate = (drive, t) => ({ characterId: 1, classId: 4, level: 25, clanId: 0, partyHistory: { 2: { runs: 1 } },
    persona: { primaryDrive: drive, traits: t } });
const eligible = (c) => Policy.founderEligibility(c, { quorumCandidates: [1, 2, 3, 4, 5], founderThresholds: table });

// The strongest leader among traders founds, although it is far below the old
// fixed gates (assertiveness 0.70, ambition 0.80 ...).
const topTrader = candidate('wealth', personas.filter((p) => p.primaryDrive === 'wealth').at(-1).traits);
assert.strictEqual(eligible(topTrader).ok, true, eligible(topTrader).reasons.join(','));
assert.strictEqual(eligible(candidate('social', personas.filter((p) => p.primaryDrive === 'social').at(-1).traits)).ok, true);
// Ambition alone does not make a founder: an ambitious bot without leadership is refused.
assert.strictEqual(eligible(candidate('progression', traits(0.56, 0.5, 0.99))).ok, false);
assert.strictEqual(eligible(candidate('wealth', personas[2 + 3 * 50].traits)).ok, false);
// Without a table nobody founds.
assert.strictEqual(Policy.founderEligibility(topTrader, { quorumCandidates: [1, 2, 3, 4, 5] }).ok, false);
console.log('Clan founder threshold checks passed');
