'use strict';
// A two-handed blunt is C4's BIGBLUNT (T119): the datapack names it
// 'Weapon.Blunt' in the two-handed slot, and the two-handed weapon mastery
// (293, Orc Raider / Destroyer) asks for GreatSword or BigBlunt. One owner,
// WeaponMask.weaponType, types it for the cold profile, the hot passives and
// the weaponsAllowed mask.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const WeaponMask = invoke('GameServer/Skills/WeaponMask');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const timestamp = 1791335800000;

assert.equal(WeaponMask.weaponType('Weapon.Blunt', 14), 'Weapon.BigBlunt', 'a two-handed blunt');
assert.equal(WeaponMask.weaponType('Weapon.Blunt', 7), 'Weapon.Blunt', 'a one-handed blunt');
assert.equal(WeaponMask.weaponType('Weapon.GreatSword', 14), 'Weapon.GreatSword');
const hammer = Index.find(Data.items, 187); // Atuba Hammer: D, Weapon.Blunt, slot 14
assert.equal(hammer.template.kind, 'Weapon.Blunt');
assert.equal(Number(hammer.etc.slot), 14);
const worn = item => ({ fetchSlot: () => Number(item.etc.slot), fetchKind: () => item.template.kind });
const actor = item => ({ backpack: { fetchEquippedWeapon: () => worn(item), fetchTotalWeaponKind: () => item.template.kind,
    fetchEquippedArmors: () => [] } });
assert.equal(WeaponMask.weaponMaskFor(actor(hammer)), WeaponMask.MASK_BY_KIND['Weapon.BigBlunt'], 'the hot mask types it');

// A level-40 Destroyer: the hammer earns the same mastery P.Atk as its great sword.
const destroyer = weaponId => {
    const state = HuntCycle.referenceState(46, 40);
    state.characterId = weaponId === null ? 953950 : 953951;
    for (const [key, row] of Object.entries(state.inventory)) if ([7, 8, 14].includes(Number(row.slot))) delete state.inventory[key];
    if (weaponId) state.inventory[weaponId] = { selfId: weaponId, amount: 1, equipped: true, equippedCount: 1,
        equippedSlots: [14], slot: 14, enchant: 0 };
    return Profile.profileFor(state, timestamp);
};
const withHammer = destroyer(187), withSword = destroyer(70); // 70: Claymore, D great sword
assert.equal(withHammer.equipment.weaponKind, 'Weapon.BigBlunt', 'the cold profile types it');
assert(withHammer.skills.some(skill => Number(skill.selfId) === 293), 'the Destroyer knows the two-handed mastery');
assert(Profile.statAdd(withHammer, 'pAtkAdd', timestamp) > 0, 'the hammer gets mastery P.Atk');
assert.equal(Profile.statAdd(withHammer, 'pAtkAdd', timestamp), Profile.statAdd(withSword, 'pAtkAdd', timestamp),
    'a two-handed blunt and a great sword earn the same two-handed mastery');
for (const id of [953950, 953951]) Profile.forgetBuild(id);
console.log('PASS two-handed blunt mastery');
