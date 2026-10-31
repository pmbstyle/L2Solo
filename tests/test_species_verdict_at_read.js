'use strict';
// A spawn group's verdict (speciesPulls) is computed when asked from the profiles and the species:
// profile arrays of different strength get their own answers, with no store
// shared between arrays.
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Hunting = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');

const mob = Data.npcs.find(npc => npc.template?.kind === 'Monster' && Hunting.canHunt(npc) && Number(npc.template.level) === 40);
assert(mob, 'the datapack must contain a level 40 monster');
const fighter = (pAtk, maxHp, pDef) => ({ classId: 0, role: 'dps', level: 40, pAtk, mAtk: 10, maxMp: 100,
    atkSpd: 300, castSpd: 333, weaponMask: 4, maxHp, pDef, equipment: { weaponKind: 'Weapon.Sword' }, skills: [] });
const options = { soloSafety: true };
const strong = Matchup.speciesPulls([fighter(900, 3000, 600)], { selfId: mob.selfId }, options);
const weak = Matchup.speciesPulls([fighter(15, 150, 40)], { selfId: mob.selfId }, options);
assert.equal(strong.canHunt, true, 'a strong fighter can hunt the species');
assert.equal(weak.canHunt, false, 'a weak fighter cannot');
// Equal numbers in another array: the same answer, computed again for that
// array (a store shared by equal numbers would hand back the first object).
const again = Matchup.speciesPulls([fighter(15, 150, 40)], { selfId: mob.selfId }, options);
assert.deepEqual(again, weak);
assert.notStrictEqual(again, weak, 'another array gets its own verdict');
console.log('PASS spawn group verdict at read');
