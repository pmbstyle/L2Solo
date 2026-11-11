const assert = require('assert');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fixtureFs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fixtureFs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache');
Data.init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

// npcWeaponBridgePlan exists so a bot without a usable weapon does not spend
// "thousands of fights" unarmed. It used to take the kit weapon as is (the
// cheapest at the highest NPC grade, a D weapon at 20+) whether the bot could
// pay for it or not, and gave no bridge when an armour piece was affordable.
// It now uses the dual-sword bridge rule: the cheapest affordable at the
// bridge grade, else the cheapest affordable, else the cheapest to save for;
// and the weapon comes before armour.
const WEAPON_SLOTS = new Set([7, 14]);
const byId = (selfId) => Data.items.find((item) => Number(item.selfId) === Number(selfId));
const rank = (selfId) => String(byId(selfId)?.etc?.rank || '');
// Level-30 archer still carrying the dagger of its former class.
const archer = (adena, level = 30) => ({
    characterId: 9400001, level, adena, stats: { classId: 37, role: 'archer' },
    inventory: {
        223: { selfId: 223, amount: 1, equipped: true, equippedSlots: [7], slot: 7 },
        57: { selfId: 57, amount: adena }
    }
});
const spendable = (state) => state.adena - Gear.operationalAdenaReserve(state);
const armed = (state, selfId) => ({ ...state, inventory: Gear.equipInventoryUpgrades(state, { ...state.inventory,
    [selfId]: { selfId, amount: 1, equipped: false, slot: byId(selfId).etc.slot } }) });

const rich = archer(20000000);
assert.strictEqual(Gear.combatReadiness(rich).hasWeapon, false, 'fixture: a dagger is not an archer weapon');
const richBridge = Gear.npcWeaponBridgePlan(rich);
assert.strictEqual(richBridge?.weaponBridge, true);
assert.strictEqual(rank(richBridge.target.selfId), 'd', 'a bot that can pay keeps the D-grade kit weapon');
assert.strictEqual(richBridge.target.selfId, Gear.staticNpcUpgradePlan(rich).target.selfId,
    'a funded bridge is the kit weapon, as before');
const dPrice = Number(richBridge.market.price);

// Too poor for any D-grade piece: the kit saves for its first slot, the D weapon.
const poor = archer(20000);
const poorKit = Gear.staticNpcUpgradePlan(poor);
assert(WEAPON_SLOTS.has(Number(poorKit?.target?.slot)) && Number(poorKit.market.price) > poor.adena,
    'fixture: the kit saves for the unfunded D weapon');
const poorBridge = Gear.npcWeaponBridgePlan(poor);
assert.strictEqual(poorBridge?.weaponBridge, true);
assert.strictEqual(Number(poorBridge.market.reserve), 0, 'emergency arming uses the whole wallet');
assert(Number(poorBridge.market.price) <= poor.adena,
    'a bot that cannot pay for the D weapon must bridge with a weapon it can buy now');
assert.notStrictEqual(rank(poorBridge.target.selfId), 'd');
assert.strictEqual(Gear.combatReadiness(armed(poor, poorBridge.target.selfId)).hasWeapon, true,
    'the bridge must be a usable weapon');
assert.strictEqual(Gear.npcWeaponBridgePlan(armed(poor, poorBridge.target.selfId)), null,
    'once armed, the bot leaves the bridge for the ordinary kit plan');

// No money: save for the cheapest usable weapon, not for the D weapon.
const broke = Gear.npcWeaponBridgePlan(archer(0));
assert.strictEqual(broke?.weaponBridge, true);
assert(Number(broke.market.price) <= Number(poorBridge.market.price) && Number(broke.market.price) < dPrice,
    'with no money the bridge saves for the cheapest usable weapon');

// An affordable armour piece does not come before the weapon any more.
const armour = archer(50000);
const armourKit = Gear.staticNpcUpgradePlan(armour);
assert(!WEAPON_SLOTS.has(Number(armourKit?.target?.slot)) && Number(armourKit.market.price) <= spendable(armour),
    'fixture: the kit would buy an affordable armour piece first');
const armourBridge = Gear.npcWeaponBridgePlan(armour);
assert(armourBridge?.weaponBridge && WEAPON_SLOTS.has(Number(armourBridge.target.slot)),
    'a bot without a usable weapon buys a weapon before armour');
assert.strictEqual(Number(armourBridge.market.reserve), 0, 'the weapon before armour uses the same emergency budget');
assert(Number(armourBridge.market.price) <= armour.adena, 'the weapon it buys first does not overspend the wallet');

// The bridge keeps no level reserve: the level term (250 per level) is a
// consumables cushion for a bot that earns, and an unarmed bot earns nothing
// (live test 2026-10-03: 104 bots at 30+ saving for a 1,766 weapon with ~1,000
// adena and no income). With 1,500 adena the cheapest usable weapon is funded.
// T43 table: no shot reserve at 30 (shots do not pay there); at 51 the ordinary reserve holds a shot hour.
const nearlyBroke = archer(1500, 51);
assert(Gear.operationalAdenaReserve(nearlyBroke) > nearlyBroke.adena, 'fixture: the ordinary reserve (2,503 at level 51) exceeds the wallet');
const cheapBridge = Gear.npcWeaponBridgePlan(nearlyBroke);
assert.strictEqual(cheapBridge?.weaponBridge, true);
// ARCH-NOTE: FX-E3 #12 gives a missing usable weapon the whole wallet; no minimum reserve.
assert.strictEqual(Number(cheapBridge.market.reserve), 0, 'the survival bridge may spend the whole wallet');
assert(Number(cheapBridge.market.price) + Number(cheapBridge.market.reserve) <= nearlyBroke.adena,
    'a bot with a little more than the cheapest usable weapon costs buys it now');
assert.strictEqual(Gear.combatReadiness(armed(nearlyBroke, cheapBridge.target.selfId)).hasWeapon, true);

// A party member leaves for its bridge only when it can buy it now: a C4
// player without a proper weapon still parties and earns there. Before, any
// bridge plan (also one saved for) released the member at once, and the party
// dissolved and re-formed every half minute (2026-11-05 diagnostics run).
const warrior = (adena) => ({
    characterId: 9400002, level: 20, adena, stats: { classId: 1 },
    inventory: {
        2: { selfId: 2, amount: 1, equipped: true, equippedSlots: [7], slot: 7 },
        57: { selfId: 57, amount: adena }
    }
});
const poorWarrior = warrior(5000);
assert.strictEqual(Gear.combatReadiness(poorWarrior).hasWeapon, false, 'fixture: a one-handed sword is not a Warrior weapon');
const savedBridge = Gear.npcWeaponBridgePlan(poorWarrior);
assert(savedBridge?.weaponBridge && Number(savedBridge.market.price) > poorWarrior.adena,
    'an unfunded Warrior still plans to save for its bridge');
assert.strictEqual(Gear.equipmentBridgeReason(poorWarrior), null, 'a bridge it cannot pay for keeps the Warrior in its party');
const paidWarrior = warrior(Number(savedBridge.market.price));
assert.strictEqual(Gear.npcWeaponBridgePlan(paidWarrior)?.target?.selfId, savedBridge.target.selfId);
assert.strictEqual(Gear.equipmentBridgeReason(paidWarrior), 'weapon_bridge', 'a Warrior that can buy its bridge leaves to buy it');

// An unfunded weapon bridge does not hide a funded armour one: a Gladiator
// with neither a dual sword nor a Warrior weapon, in light armour, cannot pay
// for the two blades yet but can buy its heavy body armour now.
const gladiator = { characterId: 9400003, level: 30, adena: 150000, stats: { classId: 2, role: 'dps' },
    inventory: {
        2: { selfId: 2, amount: 1, equipped: true, equippedSlots: [7], slot: 7 },
        391: { selfId: 391, amount: 1, equipped: true, equippedSlots: [10], slot: 10 }, // Puma Skin Shirt
        57: { selfId: 57, amount: 150000 }
    } };
const dualBridge = Gear.npcWeaponBridgePlan(gladiator);
assert(dualBridge?.combine && Number(dualBridge.bridgeCost) > gladiator.adena, 'fixture: an unfunded dual-sword bridge');
assert.strictEqual(Gear.equipmentBridgeReason(gladiator), 'class_armor_bridge',
    'a member that can buy its class armour leaves to buy it while saving for the weapon');

console.log('Affordable weapon bridge checks passed');
