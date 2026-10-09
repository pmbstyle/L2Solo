const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
Data.init();

const state = { characterId: 987654, level: 1, adena: 100000,
    stats: { classId: 0 }, inventory: {} };
const originalInventory = {};
const legacy = [];
for (let id = 990; id <= 1000; id++) {
    const matches = Data.items.filter(row => row.selfId === id);
    assert.equal(matches.length, 1, `quest ${id} has one canonical row`);
    const item = matches[0];
    assert.equal(item.template.kind, 'Other.Quest');
    assert.equal(item.template.price, 0);
    assert.equal(item.template.class1, 4);
    assert.equal(item.template.class2, 3);
    assert.equal(item.etc.slot, undefined);
    assert.equal(item.stats, undefined);
    const stale = { ...item, template: { ...item.template, kind: 'Armor.Wear', price: 37 },
        etc: { slot: 9, rank: 'none' }, stats: { pDef: 9 } };
    legacy.push(stale);
    for (const candidate of [item, stale]) {
        assert.equal(Planner.isRealCatalogItem(candidate), false);
        assert.equal(Planner.suitable(candidate, state, 'dps', 'none'), false);
        assert.equal(Planner.considerable(candidate, state), false);
        assert.equal(Planner.isSlotUpgrade(candidate, [], 'dps', 0), false);
    }
    const row = { selfId: id, amount: 2, count: 2, kind: 'Armor.Wear', rank: 'none',
        basePrice: 37, name: item.template.name, slot: 9 };
    assert.equal(Disposition.isQuestItem(row), true);
    assert.equal(Disposition.isNpcOnlyItem(row), false);
    assert.equal(Disposition.isWarehouseCandidate(row), false);
    assert.deepEqual(Listing.classify(state, row), { action: 'ignore', reason: 'quest_item' });
    originalInventory[id] = row;
}
state.inventory = structuredClone(originalInventory);
const saleOptions = { unlimited: true, keptAmounts: {}, preparedReservations: {} };
assert.deepEqual(Disposition.saleCandidates(state, saleOptions), []);
assert.deepEqual(Disposition.npcLiquidationCandidates(state, saleOptions), []);
assert.deepEqual(Listing.evaluate(state, saleOptions).listings, []);
assert.deepEqual(state.inventory, originalInventory, 'exclusion preserves real inventory');
const gloves = Data.items.find(row => row.template.kind === 'Armor.Wear' && row.etc.slot === 9
    && row.etc.rank === 'none' && row.template.name !== '0');
const weapon = Data.items.find(row => row.template.kind === 'Weapon.Sword' && row.etc.slot === 7
    && row.etc.rank === 'none' && row.template.name !== '0');
for (const item of [gloves, weapon]) {
    assert(item, 'ordinary equipment fixture exists');
    assert.equal(Planner.suitable(item, state, 'dps', 'none'), true);
    assert.equal(Disposition.isQuestItem({ selfId: item.selfId, kind: item.template.kind }), false);
}
assert.equal(Planner.isSlotUpgrade(gloves, legacy, 'dps', 0), true,
    'stale quest gear cannot satisfy an owned equipment slot');
for (const rows of Providers.gearCandidates(state).values()) {
    assert(rows.every(row => !Disposition.isQuestItem(row)), 'wish targets exclude canonical quest items');
}
const genuineQuest = Data.items.find(row => row.template.kind === 'Other.Quest' && row.selfId < 990);
assert(genuineQuest);
assert.equal(Planner.isRealCatalogItem(genuineQuest), false);
assert.equal(Disposition.isQuestItem({ selfId: genuineQuest.selfId, kind: 'Armor.Wear' }), true);
assert.equal(Listing.classify(state, { selfId: genuineQuest.selfId, kind: 'Armor.Wear', count: 1 }).reason, 'quest_item');
// Catalog replacement rebuilds the existing index rather than caching an old kind.
const catalog = Data.items;
try {
    Data.items = catalog.map(row => row.selfId === gloves.selfId
        ? { ...row, template: { ...row.template, kind: 'Other.Quest' } } : row);
    assert.equal(Planner.suitable(gloves, state, 'dps', 'none'), false);
    assert.equal(Disposition.isQuestItem({ selfId: gloves.selfId, kind: 'Armor.Wear' }), true);
} finally { Data.items = catalog; }
assert.equal(Planner.suitable(gloves, state, 'dps', 'none'), true);
console.log('Canonical quest equipment and trade exclusions passed');
