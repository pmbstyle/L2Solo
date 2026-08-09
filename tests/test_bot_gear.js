const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const BotGear = invoke('GameServer/Bot/AI/BotGear');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Item = invoke('GameServer/Item/Item');

assert.strictEqual(BotGear.ensureCharacterGear, undefined,
    'level-based gear plans must guide acquisition, not create free equipment on spawn');

function bySlot(plan, slot) {
    return plan.items.find((item) => Number(item.slot) === Number(slot));
}

function itemTemplate(selfId) {
    return DataCache.items.find((item) => Number(item.selfId) === Number(selfId));
}

const lowMage = BotGear.planFor({ classId: 10, level: 2 });
assert.strictEqual(lowMage.rank, 'none');
assert.strictEqual(lowMage.role, 'mage');
assert.ok(bySlot(lowMage, 10), 'low mage should wear an explicit tunic');
assert.ok(bySlot(lowMage, 11), 'low mage should wear explicit stockings');
assert.ok(!bySlot(lowMage, 15), 'low mage should not use full-body no-grade robes');
assert.ok(!bySlot(lowMage, 8), 'low mage should not auto-equip a shield');

const lowFighter = BotGear.planFor({ classId: 0, level: 2 });
assert.strictEqual(itemTemplate(bySlot(lowFighter, 10).selfId).template.kind, 'Armor.Leather');
assert.strictEqual(itemTemplate(bySlot(lowFighter, 11).selfId).template.kind, 'Armor.Leather');

const noviceDagger = BotGear.planFor({ classId: 7, level: 16 });
const weapon = itemTemplate(bySlot(noviceDagger, 7).selfId);
assert.ok(Number(weapon.stats.pAtk || 0) < 1000, 'no-grade bot gear should ignore anomalous weapon stats');

function wearable(id, data) {
    return new Item(id, {
        selfId: data.selfId || id,
        name: data.name || `item_${id}`,
        kind: data.kind,
        price: data.price ?? 100,
        rank: data.rank || 'none',
        pAtk: data.pAtk || 0,
        mAtk: data.mAtk || 0,
        pDef: data.pDef || 0,
        mDef: data.mDef || 0,
        maxMp: data.maxMp || 0,
        equipped: data.equipped || false,
        slot: data.slot
    });
}

function upgradeSession({ classId, level, items, paperdoll }) {
    const backpack = {
        fetchItems: () => items,
        fetchEquippedWeapon: () => items.find((item) => item.isWeapon() && item.fetchEquipped()),
        fetchPaperdollId: (slot) => paperdoll[slot]?.id,
        fetchItemRaw: (id) => items.find((item) => item.fetchId() === id)
    };

    return {
        accountId: 'bot_upgrade_test',
        actor: {
            backpack,
            fetchLevel: () => level,
            fetchClassId: () => classId
        }
    };
}

const fighterOldSword = wearable(1001, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, mAtk: 4, equipped: true });
const fighterNewSword = wearable(1002, { kind: 'Weapon.Sword', slot: 7, pAtk: 12, mAtk: 5 });
let upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 0,
    level: 10,
    items: [fighterOldSword, fighterNewSword],
    paperdoll: { 7: { id: 1001 } }
}));
assert.strictEqual(upgrades.length, 1, 'fighter should find one better weapon upgrade');
assert.strictEqual(upgrades[0].item.fetchId(), 1002);

const mageOldBlunt = wearable(1101, { kind: 'Weapon.Blunt', slot: 7, pAtk: 5, mAtk: 8, equipped: true });
const mageBow = wearable(1102, { kind: 'Weapon.Bow', slot: 7, pAtk: 80, mAtk: 1 });
const mageBlunt = wearable(1103, { kind: 'Weapon.Blunt', slot: 7, pAtk: 7, mAtk: 12 });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 10,
    level: 10,
    items: [mageOldBlunt, mageBow, mageBlunt],
    paperdoll: { 7: { id: 1101 } }
}));
assert.strictEqual(upgrades.length, 1, 'mage should only upgrade to a suitable caster weapon');
assert.strictEqual(upgrades[0].item.fetchId(), 1103);

const demonFangsTemplate = itemTemplate(321);
assert.strictEqual(demonFangsTemplate.template.name, 'Demon Fangs', 'the regression fixture must use the real C4 caster weapon');
const healerOldBlunt = wearable(1120, { kind: 'Weapon.Blunt', slot: 7, pAtk: 10, mAtk: 8, equipped: true });
const demonFangs = wearable(1121, {
    selfId: demonFangsTemplate.selfId,
    name: demonFangsTemplate.template.name,
    kind: demonFangsTemplate.template.kind,
    price: demonFangsTemplate.template.price,
    rank: demonFangsTemplate.etc.rank,
    slot: demonFangsTemplate.etc.slot,
    pAtk: demonFangsTemplate.stats.pAtk,
    mAtk: demonFangsTemplate.stats.mAtk
});
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'healer', 29), true,
    'Weapon.Etc must be a compatible family for caster support classes');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 17), true,
    'Prophet must retain caster weapon compatibility');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 21), false,
    'Sword Singer must not inherit caster weapon compatibility from the shared buffer role');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 34), false,
    'Bladedancer must not inherit caster weapon compatibility from the shared buffer role');
assert.strictEqual(BotWeaponCompatibility.isSuitableWeapon('Weapon.Blunt', 'Mystic Staff', 45, 32, 'buffer', 21), false,
    'Sword Singer must reject caster staves stored under the shared blunt family');
assert.strictEqual(BotWeaponCompatibility.isCasterWeapon('Weapon.Sword', 'Broadsword', 11, 9), false,
    'close starter stats must not turn an ordinary physical sword into caster gear');
assert.strictEqual(BotWeaponCompatibility.isSuitableWeapon('Weapon.Sword', 'Broadsword', 11, 9, 'buffer', 21), true,
    'a newly promoted Sword Singer must retain a starter melee weapon until a real upgrade exists');
assert.strictEqual(BotRoles.hasMeleeWeapon({ backpack: { fetchEquippedWeapon: () => demonFangs } }), false,
    'Demon Fangs must not make a healer eligible for melee assist');
const singerPlan = BotGear.planFor({ classId: 21, level: 33 });
const singerWeapon = itemTemplate(bySlot(singerPlan, 7)?.selfId || bySlot(singerPlan, 14)?.selfId);
assert(singerWeapon && !BotWeaponCompatibility.isCasterWeapon(
    singerWeapon.template.kind,
    singerWeapon.template.name,
    singerWeapon.stats.pAtk,
    singerWeapon.stats.mAtk
), 'Sword Singer generated gear must retain a real melee weapon');
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 29,
    level: 33,
    items: [healerOldBlunt, demonFangs],
    paperdoll: { 7: { id: 1120 } }
}));
assert.strictEqual(upgrades.length, 1, 'a healer must replace an obsolete no-grade weapon with traded Demon Fangs');
assert.strictEqual(upgrades[0].item.fetchSelfId(), 321);

const singerSword = wearable(1122, { kind: 'Weapon.Sword', slot: 7, pAtk: 50, mAtk: 10, equipped: true });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 21,
    level: 33,
    items: [singerSword, demonFangs],
    paperdoll: { 7: { id: 1122 } }
}));
assert.strictEqual(upgrades.length, 0, 'a Sword Singer must keep its melee weapon instead of equipping traded caster gear');

const movingTradeSession = upgradeSession({
    classId: 29,
    level: 33,
    items: [healerOldBlunt, demonFangs],
    paperdoll: { 7: { id: 1120 } }
});
movingTradeSession.actor.fetchName = () => 'TradeHealer';
movingTradeSession.actor.state = {
    fetchHits: () => null,
    fetchCasts: () => null,
    fetchTowards: () => ({ locX: 1, locY: 1, locZ: 0 })
};
movingTradeSession.actor.backpack.equipGear = (_session, item) => {
    healerOldBlunt.setEquipped(false);
    item.setEquipped(true);
};
const movingTradeUpgrades = BotEquipmentUpgrade.applyBestUpgrades(movingTradeSession, { force: true });
assert.strictEqual(movingTradeUpgrades.length, 1, 'safe equipment upgrades must not starve while the companion is following');
assert.strictEqual(demonFangs.fetchEquipped(), true);

const mageTunic = wearable(1110, { kind: 'Armor.Fabric', slot: 10, pDef: 21, maxMp: 38, equipped: true });
const mageStockings = wearable(1111, { kind: 'Armor.Fabric', slot: 11, pDef: 13, maxMp: 23, equipped: true });
const cottonRobe = wearable(1112, { kind: 'Armor.Fabric', slot: 15, pDef: 35, maxMp: 61, price: 3550 });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 10,
    level: 11,
    items: [mageTunic, mageStockings, cottonRobe],
    paperdoll: { 10: { id: 1110 }, 11: { id: 1111 } }
}));
assert.strictEqual(upgrades.length, 0, 'mage should not upgrade into no-grade full-body robes');

const lowOldSword = wearable(1201, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, equipped: true });
const tooHighGradeSword = wearable(1202, { kind: 'Weapon.Sword', slot: 7, pAtk: 80, rank: 'd' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 0,
    level: 10,
    items: [lowOldSword, tooHighGradeSword],
    paperdoll: { 7: { id: 1201 } }
}));
assert.strictEqual(upgrades.length, 0, 'low-level bot should not auto-equip gear above its grade band');

console.log('Bot gear checks passed');
