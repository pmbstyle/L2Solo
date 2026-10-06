// Warehouse surplus uses the common market disposition before moving assets.
// The market choice is fixed at its public boundary; all item transfers,
// balances, ownership queries and persisted inventories use real SQLite.
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Enchant = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');

const originals = { saleDecision: Market.saleDecision, warehouseRequests: Enchant.warehouseRequests,
    enchantSafe: Enchant.enchantSafe, execute: Database.execute, applyNpcLiquidation: Life.applyNpcLiquidation,
    applyWarehouseGearCleanup: Life.applyWarehouseGearCleanup, fetchWarehouseItems: Database.fetchWarehouseItems,
    transferWarehouseToInventory: Database.transferWarehouseToInventory };
let choices = [];
const decisions = [];
Market.saleDecision = (state, options) => {
    decisions.push({ state, options });
    return {
        listings: choices.filter(item => item.action === 'list'),
        npc: choices.filter(item => item.action === 'npc'),
        answers: choices.filter(item => item.action === 'ad').map(item => ({ item, count: item.count, line: { town: 'Dion' } }))
    };
};
const nameOf = selfId => DataCache.items.find(item => item.selfId === selfId)?.template.name || `Item ${selfId}`;
async function stock(id, selfId, amount, enchant = 0, petData = null) {
    const result = await Database.execute(['INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant,petData) VALUES(?,?,?,?,?,?)',
        [id, selfId, nameOf(selfId), amount, enchant, petData]]);
    return Number(result.insertId);
}
async function seed(id, items = [], stats = {}) {
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
    for (const item of items) await Database.setItem(id, { name: nameOf(item.selfId), slot: 0, ...item });
    return Life.upsertState({ characterId: id, accountName: 'quests', name: `Warehouse${id}`,
        classId: 0, level: 40, phase: 'cold', activity: 'hunting', adena: 100000, currentRegion: 'Giran',
        loc: { locX: 83396, locY: 147904, locZ: -3400 },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats, timing: {},
        vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 } }, 'warehouse_fixture');
}
async function totals(id, selfId) {
    const bag = await Database.fetchItems(id), warehouse = await Database.fetchWarehouseItems(id);
    const [saved] = await Database.execute(['SELECT adena,inventorySummary FROM bot_life_state WHERE characterId=?', [id]]);
    const physical = bag.filter(item => item.selfId === selfId).reduce((sum, item) => sum + item.amount, 0);
    const stored = warehouse.filter(item => item.selfId === selfId).reduce((sum, item) => sum + item.amount, 0);
    assert.equal(saved.adena, 100000, 'withdrawal cannot create or spend money');
    assert.equal(bag.find(item => item.selfId === 57).amount, 100000);
    assert.equal(Number(JSON.parse(saved.inventorySummary)[selfId]?.amount || 0), physical, 'saved bag matches physical rows');
    return { physical, stored, total: physical + stored, bag, warehouse };
}

async function run() {
    const ids = [710071, 710072, 710073, 710074, 710075, 710076, 710077, 710078, 710079];
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 40 })), 'group-f-warehouse');
    try {
        await Life.init();
        const seller = await seed(ids[0], [{ selfId: 1864, amount: 10 }]);
        await stock(ids[0], 1864, 20);
        choices = [{ action: 'list', selfId: 1864, count: 30, price: 123 }];
        const released = await Warehouse.releaseCold(seller, { now: 1791200000000, marketDemandSelfIds: [] });
        assert.equal(released.released, true, 'a warehouse listing is actionable without any open buy ad');
        assert.deepEqual(released.items.map(item => [item.selfId, item.amount, item.reason]), [[1864, 20, 'market']]);
        assert.equal(decisions.at(-1).state.inventory[1864].amount, 30, 'E sees the full bag and warehouse stock once');
        assert.equal(released.state.stats.marketSellRetryAfter, null);
        assert.deepEqual(await totals(ids[0], 1864).then(({ physical, stored, total }) => ({ physical, stored, total })),
            { physical: 30, stored: 0, total: 30 });

        const patient = await seed(ids[1]);
        await stock(ids[1], 1867, 12);
        choices = [];
        assert.equal((await Warehouse.releaseCold(patient)).released, false, 'E keep leaves the item in its warehouse');
        assert.equal((await totals(ids[1], 1867)).stored, 12);
        choices = [{ action: 'npc', selfId: 1867, count: 12 }];
        const npcRelease = await Warehouse.releaseCold(patient);
        assert.equal(npcRelease.items[0].amount, 12, 'E NPC choice uses ordinary withdrawal before the sale visit');
        assert.equal((await totals(ids[1], 1867)).physical, 12, 'no direct NPC payout or asset deletion during release');

        choices = [{ action: 'ad', selfId: 1864, count: 5 }];
        assert.deepEqual(Warehouse.marketRequests(released.state, [{ id: 90000, selfId: 1864, amount: 20 }]), [],
            'the bag already covers this ad: warehouse units must not be released twice');

        const crafter = await seed(ids[2], [], { equipmentPlan: { status: 'active', strategy: 'craft',
            materials: [{ selfId: 1870, amount: 18, owned: 0, missing: 18 }] } });
        await stock(ids[2], 1870, 10);
        await stock(ids[2], 1870, 15);
        await stock(ids[2], 955, 5);
        choices = [{ action: 'list', selfId: 1870, count: 25 }, { action: 'list', selfId: 955, count: 5 }];
        Enchant.warehouseRequests = () => [{ selfId: 955, amount: 2, reason: 'enchant' }];
        Enchant.enchantSafe = async state => ({ state, enchanted: false });
        const craftRelease = await Warehouse.releaseCold(crafter);
        const byReason = craftRelease.items.reduce((summary, item) => {
            const key = `${item.selfId}:${item.reason}`;
            summary[key] = (summary[key] || 0) + item.amount;
            return summary;
        }, {});
        assert.deepEqual(byReason, { '1870:craft': 18, '1870:market': 7, '955:enchant': 2, '955:market': 3 },
            'split rows share one craft reservation; safe-enchant stock is reserved before the market');
        assert.equal((await totals(ids[2], 1870)).total, 25);
        assert.equal((await totals(ids[2], 955)).total, 5);
        Enchant.warehouseRequests = originals.warehouseRequests;
        Enchant.enchantSafe = originals.enchantSafe;

        const gear = await seed(ids[3], [{ selfId: 94, amount: 1 }, { selfId: 94, amount: 1 }, { selfId: 94, amount: 1 }]);
        const rows = [];
        for (const enchant of [0, 1, 2, 3]) rows.push(await stock(ids[3], 94, 1, enchant, enchant === 1 ? '{"tag":"copy-one"}' : null));
        Life.applyNpcLiquidation = async () => { throw Error('unexpected cap-based NPC payout'); };
        Life.applyWarehouseGearCleanup = async () => { throw Error('unexpected historical NPC payout'); };
        const capped = await Warehouse.depositCold(gear);
        assert.equal(capped.count, 0);
        assert.equal(capped.state.inventory[94].amount, 3, 'warehouse cap leaves all excess bag copies intact');
        assert.equal((await totals(ids[3], 94)).total, 7);
        choices = [];
        assert.equal((await Warehouse.cleanupHistoricalOwner(ids[3], 1)).units, 0, 'historical surplus follows E keep');
        choices = [{ action: 'list', selfId: 94, count: 7 }];
        const historical = await Warehouse.cleanupHistoricalOwner(ids[3], 1);
        assert.equal(historical.units, 1, 'historical release keeps its unit budget');
        assert.equal(historical.payout, 0);
        assert.equal(historical.rowsRemoved, 0);
        const kept = await totals(ids[3], 94);
        assert.equal(kept.total, 7);
        assert.deepEqual(kept.warehouse.map(item => item.id), [rows[0], rows[2], rows[3]], 'best enchanted copies stay stored');
        assert(kept.bag.some(item => item.selfId === 94 && item.enchant === 1 && item.petData === '{"tag":"copy-one"}'),
            'selected physical copy retains its enchant and provenance');
        const beforeFence = kept.total;
        const owned = { ...historical.state, simulation: { ownerId: 'cold_worker', revision: 1 } };
        assert.equal((await Warehouse.releaseCold(owned)).released, false);
        assert.equal((await Warehouse.releaseCold({ ...historical.state, partyId: 23 })).released, false);
        await Database.execute(['UPDATE bot_life_state SET simulationOwner=? WHERE characterId=?', ['cold_worker', ids[3]]]);
        assert.equal((await Warehouse.cleanupHistoricalOwner(ids[3])).ok, false, 'historical cleanup queries current ownership');
        assert.equal((await totals(ids[3], 94)).total, beforeFence);

        const sql = [];
        Database.execute = (statement, operation) => {
            if (operation === 'warehouse:cleanup-candidates') sql.push(statement);
            return originals.execute(statement, operation);
        };
        const candidates = await Warehouse.releaseCandidates(2, []);
        assert(candidates.length <= 2, 'no-ad discovery still has a bounded batch');
        assert(sql[0][0].includes('INDEXED BY warehouse_items_characterId'));
        assert(sql[0][0].includes('LIMIT 2'));
        assert(sql[0][0].includes('warehouse.characterId > ?'));
        assert(!sql[0][0].includes('warehouse.selfId IN'), 'listing stock can be discovered without WTB demand');
        Database.execute = originals.execute;
        await world.reopen(ids[0]);
        assert.equal((await totals(ids[0], 1864)).total, 30, 'withdrawal and money survive reopen');

        const handoff = await seed(ids[4]);
        await stock(ids[4], 1864, 20);
        choices = [{ action: 'list', selfId: 1864, count: 20 }];
        Database.transferWarehouseToInventory = async (id, item, options) => {
            const claim = await Owner.claim(Life.cachedState(id), { allowLifecycle: true });
            assert.equal(claim.ok, true, 'ownership changes after the last service check');
            return originals.transferWarehouseToInventory(id, item, options);
        };
        const rejected = await Warehouse.releaseCold(handoff);
        Database.transferWarehouseToInventory = originals.transferWarehouseToInventory;
        assert.equal(rejected.released, false, 'a claimed owner cannot withdraw after the service check');
        const claimedTotals = await totals(ids[4], 1864);
        assert.equal(claimedTotals.physical, 0);
        assert.equal(claimedTotals.stored, 20);
        assert.equal(rejected.state.simulation.ownerId, Owner.OWNER_ID);

        const oldPlan = await seed(ids[5]);
        await stock(ids[5], 1870, 10);
        await stock(ids[5], 1870, 15);
        const newPlan = { status: 'active', strategy: 'craft', materials: [{ selfId: 1870, amount: 18, owned: 0, missing: 18 }] };
        choices = [{ action: 'list', selfId: 1870, count: 25 }];
        Database.fetchWarehouseItems = async id => {
            const rows = await originals.fetchWarehouseItems(id);
            await Life.upsertState({ ...Life.cachedState(id), stats: { equipmentPlan: newPlan, note: 'newer reservation' } }, 'new_plan_during_warehouse_read');
            return rows;
        };
        const replanned = await Warehouse.releaseCold(oldPlan);
        Database.fetchWarehouseItems = originals.fetchWarehouseItems;
        assert.equal(decisions.at(-1).state.stats.equipmentPlan.strategy, 'craft', 'E sees the plan committed during its warehouse read');
        const plannedUnits = replanned.items.reduce((out, item) => ({ ...out, [item.reason]: (out[item.reason] || 0) + item.amount }), {});
        assert.deepEqual(plannedUnits, { craft: 18, market: 7 }, 'fresh craft units are not counted as market surplus');
        assert.equal(replanned.state.stats.equipmentPlan.strategy, 'craft');
        assert.equal(replanned.state.stats.note, 'newer reservation');
        const [savedPlan] = await Database.execute(['SELECT statsJson,simulationRevision FROM bot_life_state WHERE characterId=?', [ids[5]]]);
        assert.equal(JSON.parse(savedPlan.statsJson).note, 'newer reservation');
        assert(savedPlan.simulationRevision >= 3, 'successive physical rows adopt each committed revision');
        assert.equal((await totals(ids[5], 1870)).physical, 25);

        const lastCheck = await seed(ids[6]);
        await stock(ids[6], 1870, 25);
        Database.transferWarehouseToInventory = async (id, item, options) => {
            await Life.upsertState({ ...Life.cachedState(id), stats: { equipmentPlan: newPlan, note: 'last check reservation' } }, 'new_plan_before_physical_transfer');
            return originals.transferWarehouseToInventory(id, item, options);
        };
        const changed = await Warehouse.releaseCold(lastCheck);
        Database.transferWarehouseToInventory = originals.transferWarehouseToInventory;
        assert.equal(changed.released, false, 'a reservation committed after planning fences the native withdrawal');
        assert.equal((await totals(ids[6], 1870)).stored, 25);
        assert.equal(changed.state.stats.note, 'last check reservation');

        const afterCommit = await seed(ids[7]);
        await stock(ids[7], 1864, 10);
        await stock(ids[7], 1864, 10);
        choices = [{ action: 'list', selfId: 1864, count: 20 }];
        Database.transferWarehouseToInventory = async (id, item, options) => {
            const result = await originals.transferWarehouseToInventory(id, item, options);
            const committed = Life.acceptLifecycleRow(result.coldLifeRow);
            assert.equal((await Owner.claim(committed, { allowLifecycle: true })).ok, true,
                'a newer owner is cached before the old transaction result is delivered');
            return result;
        };
        const partial = await Warehouse.releaseCold(afterCommit);
        Database.transferWarehouseToInventory = originals.transferWarehouseToInventory;
        assert.equal(partial.aborted, true);
        assert.equal(partial.state.simulation.ownerId, Owner.OWNER_ID, 'a returned legacy row cannot replace the newer owner');
        assert.equal(partial.items.reduce((amount, item) => amount + item.amount, 0), 10, 'only the first committed row is reported');
        const partialTotals = await totals(ids[7], 1864);
        assert.equal(partialTotals.physical, 10);
        assert.equal(partialTotals.stored, 10);
        const [partialSaved] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [ids[7]]]);
        assert.equal(JSON.parse(partialSaved.statsJson).lastWarehouseWithdrawal.items[0][1], 10,
            'a partial transfer has its physical projection and release metadata already committed');

        await seed(ids[8]);
        for (const enchant of [0, 1, 2]) await stock(ids[8], 94, 1, enchant);
        choices = [{ action: 'list', selfId: 94, count: 3 }];
        Database.transferWarehouseToInventory = async (id, item, options) => {
            assert.equal((await Owner.claim(Life.cachedState(id), { allowLifecycle: true })).ok, true);
            return originals.transferWarehouseToInventory(id, item, options);
        };
        const historicalHandoff = await Warehouse.cleanupHistoricalOwner(ids[8], 1);
        Database.transferWarehouseToInventory = originals.transferWarehouseToInventory;
        assert.equal(historicalHandoff.ok, false, 'historical cleanup reports the ownership fence instead of E keep');
        assert.equal(historicalHandoff.reason, 'economy_state_changed');
        assert.equal(historicalHandoff.units, 0);
        assert.equal((await totals(ids[8], 94)).stored, 3);
        console.log('Group F warehouse: common E choice, no-ad listings, reservations, money/items, identity, fences and bounded discovery passed');
    } finally {
        Object.assign(Market, { saleDecision: originals.saleDecision });
        Object.assign(Enchant, { warehouseRequests: originals.warehouseRequests, enchantSafe: originals.enchantSafe });
        Object.assign(Life, { applyNpcLiquidation: originals.applyNpcLiquidation, applyWarehouseGearCleanup: originals.applyWarehouseGearCleanup });
        Database.execute = originals.execute;
        Database.fetchWarehouseItems = originals.fetchWarehouseItems;
        Database.transferWarehouseToInventory = originals.transferWarehouseToInventory;
        await world.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
