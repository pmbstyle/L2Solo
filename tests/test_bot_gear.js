const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const BotGear = invoke('GameServer/Bot/AI/BotGear');

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

console.log('Bot gear checks passed');
