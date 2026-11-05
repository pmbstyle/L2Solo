const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');

// An Orc Mystic is created with the retail Training Gloves (Weapon.DualFist). The
// caster profile knows swords, blunts and rods only, so the bot counted as unarmed
// and waited for a 1,766-adena rod it could not pay for: 25 of 165 stood at level 6
// for 18 hours (live, 2026-10-03). The gloves count as usable until the rod; the
// caster weapons stay what the kit buys.
const GLOVES = 2368;
const mystic = (adena, extra = {}) => ({
    characterId: 9600049, level: 6, adena, stats: { classId: 49, role: 'buffer' },
    inventory: {
        [GLOVES]: { selfId: GLOVES, amount: 1, equipped: true, equippedSlots: [14], slot: 14 },
        57: { selfId: 57, amount: adena }
    },
    ...extra
});

const poor = mystic(400);
assert.strictEqual(Gear.combatReadiness(poor).hasWeapon, true, 'the starter gloves are a usable weapon');
assert.strictEqual(Gear.npcWeaponBridgePlan(poor), null, 'no weapon bridge for a bot that can fight');
assert(!Compatibility.preferredWeaponKindsFor('buffer', 49).includes('Weapon.DualFist'), 'fists are never preferred');

// With money the kit still buys the caster weapon.
const funded = mystic(20000);
const kit = Gear.staticNpcUpgradePlan(funded);
assert(kit && [7, 14].includes(Number(kit.target.slot)), 'the kit\'s first purchase is the caster weapon');
assert(['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'].includes(Data.items.find((item) => Number(item.selfId) === Number(kit.target.selfId))?.template?.kind),
    'the kit weapon is a caster weapon, not fists');

// The second profession keeps its own profile: a Shaman with gloves still bridges.
const shaman = { ...mystic(400), level: 22, stats: { classId: 50, role: 'buffer' } };
assert.strictEqual(Gear.combatReadiness(shaman).hasWeapon, false, 'an Orc Shaman needs its blunt');

// The staff the Orc Mystic bought is a weapon the Shaman fights with until the kit
// replaces it: judged unarmed, the shaman left each party it formed for a weapon
// bridge (diagnostics run 2026-11-05: 36 of 132 shamans).
const WILLOW_STAFF = 8;
const staffShaman = (classId, level) => ({ characterId: 9600050, level, adena: 600000, stats: { classId, role: 'buffer' },
    inventory: {
        [WILLOW_STAFF]: { selfId: WILLOW_STAFF, amount: 1, equipped: true, equippedSlots: [14], slot: 14 },
        57: { selfId: 57, amount: 600000 }
    } });
for (const [classId, level] of [[50, 25], [51, 42]]) {
    const holder = staffShaman(classId, level);
    assert.strictEqual(Gear.combatReadiness(holder).hasWeapon, true, `class ${classId} with a Willow Staff is armed`);
    assert.strictEqual(Gear.equipmentBridgeReason(holder), null, `class ${classId} with a Willow Staff needs no weapon bridge`);
    const replacement = Data.items.find((item) => Number(item.selfId) === Number(Gear.staticNpcUpgradePlan(holder)?.target?.selfId));
    assert(replacement?.template?.kind === 'Weapon.Blunt' && Number(replacement.etc.slot) === 7,
        `class ${classId}: the kit still replaces the staff with its one-handed blunt`);
}

// Only the mystic's blunts are kept: Stun Attack and Hammer Crush take a blunt,
// not a sword or a book, so a shaman holding the mystic's Sword of Magic or
// Voodoo Doll is unarmed and still bridges to its kit blunt.
for (const [selfId, name] of [[83, 'Sword of Magic'], [100, 'Voodoo Doll']]) {
    const holder = { ...staffShaman(50, 25), inventory: {
        [selfId]: { selfId, amount: 1, equipped: true, equippedSlots: [7], slot: 7 },
        57: { selfId: 57, amount: 600000 }
    } };
    assert.strictEqual(Gear.combatReadiness(holder).hasWeapon, false, `a Shaman with a ${name} is unarmed`);
    assert.strictEqual(Gear.equipmentBridgeReason(holder), 'weapon_bridge', `a Shaman with a ${name} bridges to its blunt`);
}

console.log('Orc Mystic starter weapon checks passed');
process.exit(0);
