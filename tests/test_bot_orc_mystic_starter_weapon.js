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

console.log('Orc Mystic starter weapon checks passed');
process.exit(0);
