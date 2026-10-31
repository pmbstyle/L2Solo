'use strict';
// Kits by class (user 10-29, T106 audit): a Human Warrior fights with a
// two-handed sword or a polearm, not the Knight's sword and shield; Warcryer
// and Overlord keep the Orc Shaman's melee kit (blunt, heavy armour, shield)
// and its soulshots, as they fight in melee.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

const bot = (classId, level) => HuntCycle.referenceState(classId, level, { gear: invoke('GameServer/Bot/AI/BotGear'), profile: Profile });
const kit = (classId, level) => Profile.profileFor(bot(classId, level), 0).equipment;

for (const level of [24, 34]) {
    const warrior = kit(1, level);
    assert(['Weapon.GreatSword', 'Weapon.Pole'].includes(warrior.weaponKind), `Warrior L${level} two-handed: ${warrior.weaponKind}`);
    assert(!(Number(warrior.shieldPDef) > 0), `Warrior L${level} has no shield`);
}
assert.equal(kit(4, 30).weaponKind === 'Weapon.GreatSword', false, 'a Knight keeps its one-handed kit');
for (const classId of [51, 52]) {
    const chanter = kit(classId, 52);
    assert.equal(chanter.weaponKind, 'Weapon.Blunt', `class ${classId} melees with a blunt`);
    assert(!chanter.armorKinds.includes('Armor.Fabric'), `class ${classId} wears no robe: ${chanter.armorKinds}`);
    assert(Number(chanter.shieldPDef) > 0, `class ${classId} holds a shield`);
    const plan = ShotStock.planForState(bot(classId, 52));
    assert.equal(plan?.kind, 'soulshot', `class ${classId} uses soulshots`);
}
console.log('PASS Warrior and orc chanter kits');
