const assert = require('assert');

const fs = require('node:fs');
const nodePath = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('bot_background_rest_scheduling', nodePath.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);
invoke('GameServer/DataCache').init();

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

try {
const timestamp = 1_000_000;
const restUntil = timestamp + 24 * 60 * 60 * 1000;
const exhausted = {
    characterId: 81,
    name: 'TiredSolo',
    level: 20,
    levelBand: '18-22',
    activity: 'resting',
    vitals: { hp: 10, maxHp: 800, mp: 0, maxMp: 420 },
    stats: { classId: 11, role: 'mage', restUntil },
    party: { role: 'dps' }
};

const solo = BackgroundResolver.resolveSolo({ state: exhausted, spot: null, elapsedMs: 0, timestamp });
assert.strictEqual(solo.patch.activity, 'resting');
assert.strictEqual(solo.nextResolveAt, restUntil, 'a resting solo bot must sleep until its persisted recovery deadline');

const party = { partyId: 'rest-scheduling', cohesion: 0.7, risk: 0.2, stats: { restUntil } };
const spot = { id: 'test_spot', name: 'Test Spot', center: {}, rewards: { exp: 1, sp: 1, adenaMin: 1, adenaMax: 1 } };
const restedParty = BackgroundPartyResolver.resolve({
    party,
    members: [exhausted, {
        ...exhausted,
        characterId: 82,
        name: 'ReadyMember',
        vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 },
        stats: { classId: 1, role: 'dps' }
    }],
    spot,
    elapsedMs: 0,
    timestamp
});
assert.strictEqual(restedParty.nextResolveAt, restUntil, 'a resting party must share one recovery deadline');
assert(restedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'ready members must remain seated with their recovering party');
assert.strictEqual(restedParty.partyPatch.stats.restUntil, restUntil, 'the common party deadline must be persisted');

const fullRaidMembers = [91, 92].map((characterId) => ({
    ...exhausted,
    characterId,
    activity: 'resting',
    vitals: { hp: 100000, maxHp: 100000, mp: 100000, maxMp: 100000 },
    stats: { classId: 11, role: 'mage', restUntil: timestamp + 8000 }
}));
const recoveredRaid = BackgroundPartyResolver.resolve({
    party: {
        partyId: 'raid-rest-recovery',
        cohesion: 0.7,
        risk: 0.2,
        stats: {
            restUntil: timestamp + 8000,
            objective: { sourceKind: 'raid', raidBossTemplateId: 999 }
        }
    },
    members: fullRaidMembers,
    spot: { ...spot, raidBoss: true, raidBossTemplateId: 999 },
    elapsedMs: 3000,
    timestamp
});
assert(recoveredRaid.memberResults.every(({ result }) => result.patch.activity === 'grouped'),
    'a fully recovered raid party must resume preparation before its estimated deadline');
assert.strictEqual(recoveredRaid.partyPatch.stats.restUntil, null,
    'a fully recovered raid party must clear the shared recovery deadline');

// This positive combat case needs a real level-20 encounter. The old spot
// has neither an NPC nor an average level: its fallback reward of 1 is
// penalized against NPC level 0 and both level-20 party shares round to 0.
// Select the first authored ordinary monster at the unchanged member level,
// without filtering its strength or modifying its rewards/vitals/skills.
const combatNpc = invoke('GameServer/DataCache').npcs
    .filter(npc => npc.template.kind === 'Monster' && npc.template.level === exhausted.level
        && Number(npc.rewards?.exp) > 0)
    .sort((left, right) => left.selfId - right.selfId)[0];
assert(combatNpc, 'the native catalogue contains an ordinary monster at the existing party level');
const combatSpot = { ...spot, avgLevel: combatNpc.template.level,
    npcSelfIds: [combatNpc.selfId], npcEntries: [{ selfId: combatNpc.selfId, count: 1 }] };
let observedCombat;
const nativeFight = BackgroundResolver.resolvePartyFight;
BackgroundResolver.resolvePartyFight = function () {
    const result = nativeFight.apply(this, arguments);
    observedCombat = { input: arguments[0], result };
    return result;
};
let combatRestParty, combatMembers;
try {
combatRestParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 }, stats: {} },
    members: combatMembers = [
        { ...exhausted, characterId: 83, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 1, maxMp: 420 }, stats: { classId: 5, role: 'tank' }, party: { role: 'tank' } },
        { ...exhausted, characterId: 84, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 }, stats: { classId: 1, role: 'dps' }, party: { role: 'dps' } }
    ],
    spot: combatSpot,
    elapsedMs: 10_000,
    timestamp,
    rng: () => 0
});
} finally { BackgroundResolver.resolvePartyFight = nativeFight; }
// A party rests between fights, never in one, as hot: a tank out of MP in a live
// fight fights on, and the mob stays pending, not a kill and not a loss.
assert(observedCombat.result.timedOut && !observedCombat.result.won,
    'the original bounded encounter times out before the monster is defeated');
assert(observedCombat.result.debug.remainingHp > 0, 'the timed-out target is still alive');
assert.strictEqual(observedCombat.input.timestamp, timestamp, 'the encounter retains the original time');
assert.strictEqual(observedCombat.input.spot, combatSpot, 'the authored ordinary target is used unchanged');
assert.strictEqual(observedCombat.result.debug.mobSelfId, combatNpc.selfId);
assert.strictEqual(combatRestParty.debug.spotId, combatSpot.id);
assert.strictEqual(combatRestParty.debug.attemptedFights, 1, 'the original elapsed window attempts one encounter');
assert.strictEqual(combatRestParty.debug.wins, 0, 'a cut fight mints no kill');
assert.strictEqual(combatRestParty.debug.losses, 0, 'a cut fight is no loss');
assert(combatRestParty.memberResults.every(({ result }) => result.patch.activity === 'grouped'), 'nobody sits down in a live fight');
assert(combatRestParty.partyPatch.stats.pveEncounter?.hp > 0, 'the fight stays pending');
assert(!combatRestParty.partyPatch.stats.restUntil, 'no rest deadline while the mob lives');
assert(combatRestParty.memberResults.every(({ result }) => Number(result.materialize.exp || 0) === 0
    && Number(result.materialize.sp || 0) === 0), 'an unfinished encounter mints no EXP or SP');
// The kill ends the fight: the whole party sits together, before any next pull.
const killedParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 },
        stats: { pveEncounter: { ...combatRestParty.partyPatch.stats.pveEncounter, hp: 1 } } },
    members: combatMembers,
    spot: combatSpot,
    elapsedMs: 10_000,
    timestamp: timestamp + 10_000,
    rng: () => 0
});
assert.strictEqual(killedParty.debug.wins, 1, 'the pending mob falls, and the party takes no next one');
assert(killedParty.partyPatch.stats.restUntil > timestamp + 10_000, 'the rest deadline comes with the fight\'s end');
assert.strictEqual(killedParty.nextResolveAt, killedParty.partyPatch.stats.restUntil);
assert(killedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'a party rest seats every living member together');
assert.strictEqual(killedParty.partyPatch.stats.pveEncounter, null);
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 1 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), false,
    'an empty-MP physical DPS must not stop the whole party');
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 5 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), true,
    'an empty-MP tank must still trigger party recovery because Hate is part of its primary job');

console.log('Bot background rest scheduling checks passed');

} finally {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
