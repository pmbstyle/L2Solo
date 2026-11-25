const assert = require('assert');

require('../src/Global');
// This file reads the developer telemetry counter of party buff casts.
options.default.BotPopulation.developerDiagnostics = true;

const DataCache = invoke('GameServer/DataCache');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const PopulationMetrics = invoke('GameServer/Bot/Population/PopulationMetrics');

DataCache.init();

// F23: an ordinary cold party hunt casts the party buffs with the same
// function as the raid preparation, when the earliest buff is about to expire.
const timestamp = 1_750_000_000_000;
const BUFF_MS = 1_200_000;
const member = (characterId, classId, role, level = 40, knows = () => true) => {
    const base = {
        characterId, name: `Hunt${characterId}`, level, activity: 'hunting',
        vitals: { hp: 2000, maxHp: 2000, mp: 1500, maxMp: 1500 },
        stats: { classId }, inventory: {}, party: { role }
    };
    const snapshot = ColdCombatProfile.legacySnapshot(base, ColdCombatProfile.skillRecordsFromTree(classId, level)
        .filter((record) => knows(Number(record.selfId))), timestamp);
    return { ...base, stats: { classId, coldCombat: { ...snapshot, effects: [] } } };
};
const spot = {
    id: 'party_buff_field', name: 'Party buff field', avgLevel: 1, density: 1, npcSelfIds: [],
    rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 }, mob: { hp: 100000, damage: 1 }
};
const hunt = (members, at, stats = {}) => BackgroundPartyResolver.resolve({
    party: { partyId: 'cold_hunt_buffs', cohesion: 1, risk: 0, roleCoverage: {}, stats },
    members, spot, elapsedMs: 12000, timestamp: at, rng: () => 0.1
});
const stateOf = (result, index, members) => ({
    ...members[index],
    vitals: result.memberResults[index].result.patch.vitals,
    stats: result.memberResults[index].result.patch.stats
});
const effects = (result, index) => result.memberResults[index].result.patch.stats.coldCombat.effects || [];

const members = [member(1, 52, 'buffer'), member(2, 0, 'dps'), member(3, 0, 'dps')];
const first = hunt(members, timestamp);
assert(first.debug.partyBuffCasts > 0, 'an ordinary party hunt must cast the party buffs when none are active');
assert(effects(first, 1).some((effect) => effect.key.startsWith('chant_of')), 'a fighter must carry the Warcryer chant after the hunt');
assert(first.memberResults[0].result.patch.vitals.mp < members[0].vitals.mp, 'the cast spends the provider MP');
assert.strictEqual(members[1].stats.coldCombat.effects.length, 0, 'the caller input is not mutated');

const soon = hunt(members.map((_, index) => stateOf(first, index, members)), timestamp + 60000);
assert.strictEqual(soon.debug.partyBuffCasts || 0, 0, 'fresh buffs are not recast');

const late = hunt(members.map((_, index) => stateOf(first, index, members)), timestamp + BUFF_MS - 60000);
assert(late.debug.partyBuffCasts > 0, 'buffs about to expire are cast again');

// A party where no member has a cold party buff casts nothing and returns
// its members as they are.
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const fighters = [member(4, 0, 'dps'), member(5, 0, 'dps'), member(6, 0, 'tank')];
const plain = BackgroundResolver.castHuntPartyBuffs(fighters, timestamp);
assert.strictEqual(plain.buffCasts, 0);
assert.strictEqual(plain.members, fighters, 'a party without a buffer keeps its members');
assert(BackgroundResolver.castHuntPartyBuffs(members, timestamp).buffCasts > 0, 'a party with a buffer still casts');

// A member holding a stronger buff of a C4 stack type keeps it: the weaker
// Chant of Eagle 2 (a level-60 Warcryer) does not replace Guidance 3, nor Death
// Whisper 2 (a level-50 Prophet) Eye of Paagrio.
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const holding = (state, selfId, level) => {
    const semantic = C4SkillRules.resolve({ selfId, level });
    const effect = { key: semantic.effect, id: selfId, level, name: semantic.effect, type: 'buff', durationMs: BUFF_MS,
        expiresAt: timestamp + BUFF_MS, stackFamily: semantic.stackFamily, stackOrder: semantic.stackOrder, stats: semantic.stats };
    return { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat, effects: [effect] } } };
};
const guided = [member(7, 52, 'buffer', 60, (id) => id === 1309), holding(member(8, 0, 'dps', 60), 1240, 3), member(9, 0, 'dps', 60)];
const chanted = hunt(guided, timestamp);
assert(chanted.debug.partyBuffCasts > 0, 'the Warcryer casts Chant of Eagle');
assert(effects(chanted, 2).some((effect) => effect.key === 'chant_of_eagle'), 'a member without Guidance gets Chant of Eagle');
assert.deepStrictEqual(effects(chanted, 1).filter((effect) => ['guidance', 'chant_of_eagle'].includes(effect.key)).map((effect) => effect.key),
    ['guidance'], 'Guidance 3 stays: a weaker Chant of Eagle does not replace it');
const eyed = [member(10, 17, 'buffer', 50, (id) => id === 1242), holding(member(11, 0, 'dps', 50), 1364, 1), member(12, 0, 'dps', 50)];
const prophesied = hunt(eyed, timestamp);
assert(effects(prophesied, 2).some((effect) => effect.key === 'death_whisper' && effect.level === 2),
    'a member without Eye of Paagrio gets Death Whisper 2');
assert.deepStrictEqual(effects(prophesied, 1).filter((effect) => ['eye_of_paagrio', 'death_whisper'].includes(effect.key))
    .map((effect) => effect.key), ['eye_of_paagrio'], 'Eye of Paagrio stays: Death Whisper 2 is neither cast on him nor replaces it');

const originalCounters = PopulationMetrics.counters;
const originalSummary = PopulationMetrics.lastSummaryCounters;
PopulationMetrics.counters = Object.fromEntries(Object.keys(PopulationMetrics.counters).map((key) => [key, 0]));
PopulationMetrics.lastSummaryCounters = { ...PopulationMetrics.counters };
PopulationMetrics.recordCombat(first.debug);
PopulationMetrics.recordCombat(late.debug);
assert.strictEqual(PopulationMetrics.snapshot().delta.partyBuffCasts, first.debug.partyBuffCasts + late.debug.partyBuffCasts,
    'population telemetry must count party buff casts of ordinary hunts');
// The cold worker records each member's debug, not the outer aggregate:
// the owner (index 0) carries the casts once, the others none.
const memberDebug = (result, index) => result.memberResults[index].result.debug;
assert.strictEqual(memberDebug(first, 0).partyBuffCasts, first.debug.partyBuffCasts);
assert.strictEqual(memberDebug(first, 1).partyBuffCasts, undefined, 'only the telemetry owner carries the casts');
PopulationMetrics.snapshot(); // a snapshot starts the next delta
first.memberResults.forEach((_, index) => PopulationMetrics.recordCombat(memberDebug(first, index)));
assert.strictEqual(PopulationMetrics.snapshot().delta.partyBuffCasts, first.debug.partyBuffCasts,
    'the worker path counts the party buff casts once per party resolve');
PopulationMetrics.counters = originalCounters;
PopulationMetrics.lastSummaryCounters = originalSummary;

console.log('cold party hunt buffs ok');
