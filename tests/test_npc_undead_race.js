'use strict';
// An NPC is undead by its datapack race (T121): the rows carry race 'undead'
// and no flag, so before this no mob was undead, hot or cold, and the
// undead-only skills (Might of Heaven 1028) never applied.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const NpcTraits = invoke('GameServer/Npc/NpcTraits');
const Npc = invoke('GameServer/Npc/Npc');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');

const undead = Data.npcs.filter(npc => npc.traits?.race === 'undead');
assert(undead.length > 200, `the datapack has undead mobs (${undead.length})`);
assert.equal(NpcTraits.isUndead({ race: 'undead' }), true);
assert.equal(NpcTraits.isUndead({ race: 'beast' }), false);
const zombie = undead[0], beast = Data.npcs.find(npc => npc.traits?.race === 'beast');
assert.equal(new Npc(1, { ...utils.crushOb(zombie), locX: 0, locY: 0, locZ: 0 }).fetchUndead(), true, 'a live undead mob');
assert.equal(new Npc(2, { ...utils.crushOb(beast), locX: 0, locY: 0, locZ: 0 }).fetchUndead(), false, 'a live beast');
assert.equal(Profile.npcCombatStats(zombie).undead, true, 'a cold undead mob');
assert.equal(Profile.npcCombatStats(beast).undead, false, 'a cold beast');
console.log('PASS npc undead race');
