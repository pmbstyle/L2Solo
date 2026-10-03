const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Hunting = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
Data.init();

const monsters = Data.npcs.filter((npc) => npc.template?.kind === 'Monster' && Hunting.canHunt(npc));
const low = monsters.find((npc) => Number(npc.template.level) === 10);
const high = monsters.find((npc) => Number(npc.template.level) === 40);
assert(low && high, 'the datapack must contain level 10 and level 40 monsters');

const spot = { id: 'memo_test', npcEntries: [
    { selfId: low.selfId, count: 3 }, { selfId: high.selfId, count: 1 }, { selfId: low.selfId, count: 2 }
] };
const fighter = (pAtk, maxHp, pDef) => ({ classId: 0, role: 'dps', level: 20, pAtk, mAtk: 10, maxMp: 100,
    atkSpd: 300, castSpd: 333, weaponMask: 4, maxHp, pDef, equipment: { weaponKind: 'Weapon.Sword' }, skills: [] });
const strong = [fighter(900, 3000, 600)];
const weak = [fighter(15, 150, 40)];
const optionSets = [{ soloSafety: true }, { soloSafety: false }, { soloSafety: true, maxTargetLevel: 20 }, {}];

// A profile array reused across spots and options gives the same verdicts as
// a fresh array evaluated from scratch every time.
for (const profiles of [strong, weak]) {
    for (let pass = 0; pass < 2; pass++) {
        for (const options of optionSets) {
            const fresh = profiles.map((profile) => ({ ...profile }));
            assert.deepStrictEqual(Matchup.spotMatchup(spot, profiles, options), Matchup.spotMatchup(spot, fresh, options),
                `reused profiles must match a fresh evaluation (${JSON.stringify(options)})`);
        }
    }
}
// The repeated search reuses the verdicts: no species is judged again.
{
    const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const npcCombatStats = Cold.npcCombatStats;
    let judged = 0;
    Cold.npcCombatStats = (...args) => { judged += 1; return npcCombatStats(...args); };
    try {
        Matchup.spotMatchup(spot, strong, { soloSafety: true });
        Matchup.spotMatchup(spot, strong.map((profile) => ({ ...profile })), { soloSafety: true });
    } finally {
        Cold.npcCombatStats = npcCombatStats;
    }
    assert.strictEqual(judged, 0, 'a known profile must not judge a species again');
}
const strongSafe = Matchup.spotMatchup(spot, strong, { soloSafety: true });
const weakSafe = Matchup.spotMatchup(spot, weak, { soloSafety: true });
assert.notDeepStrictEqual(strongSafe, weakSafe, 'different profile arrays keep separate verdicts');
assert.notDeepStrictEqual(Matchup.spotMatchup(spot, strong, { soloSafety: true, maxTargetLevel: 20 }), strongSafe,
    'the recovery level cap is part of the verdict');

// Spot tags are cached per spot object; callers get their own array.
const field = { id: '1_1', name: 'Test Field', npcNames: ['Test Mob'], minLevel: 10, maxLevel: 14 };
const tags = Routes.tagsForSpot(field);
assert.deepStrictEqual(Routes.tagsForSpot(field), tags);
tags.push('mutated');
assert(!Routes.tagsForSpot(field).includes('mutated'), 'a caller cannot change cached tags');
assert(Routes.tagsForSpot({ ...field, minLevel: 30, maxLevel: 40 }).includes('starter') === false);
assert(Routes.tagsForSpot(field).includes('starter'));

assert.deepStrictEqual(Routes.tagsForSpot('1_1'), ['starter', 'normal_hp'], 'a bare spot id still yields tags as before');

console.log('spot matchup and tag cache tests passed');
