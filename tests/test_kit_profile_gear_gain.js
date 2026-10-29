'use strict';
// A gear gain is computed from the bot's kit profile: a better weapon gives a
// positive gain, and valuing it leaves the bot's own profile as it was.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const timestamp = 1791335800000;
const template = id => Index.find(Data.items, id);
const worn = id => ({ selfId: id, amount: 1, slot: Number(template(id).etc.slot), equipped: true, equippedCount: 1,
    equippedSlots: [Number(template(id).etc.slot)], enchant: 0 });
const state = { characterId: 951001, level: 69, stats: { classId: 57 }, inventory: { 159: worn(159) } };
state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(57, 69), timestamp);

const own = structuredClone(Profile.profileFor(state, timestamp));
const better = template(2503);
const gain = Providers.gearGain(state, better, timestamp, 1);
assert(gain.attack > 0, 'a better weapon gives a positive attack gain');
const { before, after } = Profile.candidateProfiles(state, timestamp);
const slot = Number(better.etc.slot);
assert(after({ free: wornSlot => wornSlot === slot, wear: { selfId: better.selfId, slot } }).pAtk > before.pAtk,
    'the candidate numbers carry the better weapon');
assert.deepEqual(Profile.profileFor(state, timestamp), own, 'valuing a candidate leaves the bot profile unchanged');
// A handoff changes serialization, not the worn kit or learned ranks.
const far = structuredClone(state);
far.stats.hennas = [null, null, null];
far.stats.coldCombat.equipment = { mDef: 182 };
far.inventory[856] = { selfId: 856, amount: 2, equipped: true, equippedSlots: [1, 2], slot: 1 };
const near = structuredClone(far);
near.craftLevel = 0;
near.stats.hennas = [];
near.stats.coldCombat.skillSource = 'hot';
near.stats.coldCombat.skills.reverse();
near.stats.coldCombat.equipment.mDef += 16;
near.inventory[856].enchant = 0;
near.inventory[856].instances = [1, 2].map(slot => ({ id: 100 + slot, amount: 1, equipped: true, slot, enchant: 0 }));
const Sections = require('../src/GameServer/Bot/Economy/DecisionSections');
assert.deepEqual(Profile.kitHash(Profile.combatView(far)), Profile.kitHash(Profile.combatView(near)),
    'database/hot skill provenance, empty tattoos and physical item instances do not change the kit');
assert.equal(Sections.kit(far), Sections.kit(near), 'activation is not a build event');
const fields = profile => ['pAtk', 'mAtk', 'pDef', 'mDef', 'maxHp', 'maxMp'].map(key => profile[key]);
Profile.forgetBuild(state.characterId);
const farNumbers = fields(Profile.profileFor(far, timestamp));
Profile.forgetBuild(state.characterId);
assert.deepEqual(fields(Profile.profileFor(near, timestamp)), farNumbers, 'equal kit facts describe equal combat numbers');
for (const change of [
    row => { row.inventory[856].instances[1].enchant = 1; },
    row => { row.stats.coldCombat.skills[0].level += 1; },
    row => { row.stats.hennas = [1, null, null]; },
    row => { row.inventory[159].selfId = 2503; }
]) {
    const changed = structuredClone(near); change(changed);
    assert.notEqual(Sections.kit(changed), Sections.kit(near), 'a real gear, rank or symbol change still raises build');
}
const legacy = structuredClone(near); legacy.inventory = {};
const changedLegacy = structuredClone(legacy); changedLegacy.stats.coldCombat.equipment.mDef += 10;
assert.notEqual(Sections.kit(legacy), Sections.kit(changedLegacy), 'a kit without worn rows still depends on captured equipment');
Profile.forgetBuild(state.characterId);
console.log('PASS gear gain and cold/hot kit continuity');
