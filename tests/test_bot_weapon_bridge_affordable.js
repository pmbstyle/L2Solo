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
const archer = (adena) => ({
    characterId: 9400001, level: 30, adena, stats: { classId: 37, role: 'archer' },
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
assert(Number(poorBridge.market.price) <= spendable(poor),
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
assert(Number(armourBridge.market.price) <= spendable(armour), 'the weapon it buys first is affordable');

// The bridge keeps no level reserve: the level term (250 per level) is a
// consumables cushion for a bot that earns, and an unarmed bot earns nothing
// (live test 2026-10-03: 104 bots at 30+ saving for a 1,766 weapon with ~1,000
// adena and no income). With 2,300 adena the cheapest usable weapon is funded.
const nearlyBroke = archer(2300);
assert(Gear.operationalAdenaReserve(nearlyBroke) > nearlyBroke.adena, 'fixture: the ordinary reserve (7,500 at level 30) exceeds the wallet');
const cheapBridge = Gear.npcWeaponBridgePlan(nearlyBroke);
assert.strictEqual(cheapBridge?.weaponBridge, true);
// ARCH-NOTE: FX-E3 #12 gives a missing usable weapon the whole wallet; no minimum reserve.
assert.strictEqual(Number(cheapBridge.market.reserve), 0, 'the survival bridge may spend the whole wallet');
assert(Number(cheapBridge.market.price) + Number(cheapBridge.market.reserve) <= nearlyBroke.adena,
    'a bot with a little more than the cheapest usable weapon costs buys it now');
assert.strictEqual(Gear.combatReadiness(armed(nearlyBroke, cheapBridge.target.selfId)).hasWeapon, true);

console.log('Affordable weapon bridge checks passed');
