const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const BotGear = invoke('GameServer/Bot/AI/BotGear');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const Item = invoke('GameServer/Item/Item');

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
