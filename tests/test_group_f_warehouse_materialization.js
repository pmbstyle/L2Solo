// Exercise the real legacy resolve/materialization and native warehouse transaction.
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

const STEM = 1864;
const originals = { sync: Database.syncInventorySummary, sale: Market.saleDecision };
// Fix only the public choice; reservation/candidate calculation stays real.
Market.saleDecision = state => ({ listings: ItemDisposition.saleCandidates(state, { unlimited: true }), npc: [], answers: [] });

async function seed(characterId) {
    for (const [selfId, name, amount] of [[57, 'Adena', 100000], [STEM, 'Stem', 10]]) {
        await Database.setItem(characterId, { selfId, name, amount, slot: 0 });
    }
    await Database.execute(['INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,?,?,?,0)',
        [characterId, STEM, 'Stem', 20]]);
    return Life.upsertState({ characterId, accountName: 'quests', name: `Materialization${characterId}`,
        classId: 0, level: 40, exp: Number(DataCache.experience[39]), sp: 0,
        phase: 'cold', activity: 'hunting', adena: 100000, currentRegion: 'Giran',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)),
        stats: { classId: 0, generatedCold: true, classProgressionLevel: 40, classProgressionClassId: 0 }, timing: {},
        loc: { locX: 83396, locY: 147904, locZ: -3400 },
        vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 } }, 'warehouse_materialization_fixture');
}

const outcome = () => ({ materialize: { exp: 1000, sp: 10, items: [{ selfId: STEM, name: 'Stem', amount: 20 }] },
    patch: { activity: 'hunting' }, debug: { fights: 1, wins: 1 }, events: [] });

async function counts(characterId) {
    const bag = await Database.fetchItems(characterId);
    const warehouse = await Database.fetchWarehouseItems(characterId);
    const [life] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [characterId]]);
    return { bag: bag.filter(item => item.selfId === STEM).reduce((n,item) => n + item.amount, 0),
        warehouse: warehouse.filter(item => item.selfId === STEM).reduce((n,item) => n + item.amount, 0),
        saved: Number(JSON.parse(life.inventorySummary)[STEM]?.amount || 0),
        wallet: bag.find(item => item.selfId === 57).amount, life };
}

async function duringMaterialization(characterId, hydrate) {
    const state = await seed(characterId);
    let reached;
    let resume;
    const waiting = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    let resolving;
    Database.syncInventorySummary = async (id, inventory, reason) => {
        if (id === characterId && reason === 'resolve') { reached(); await gate; }
        return originals.sync(id, inventory, reason);
    };
    try {
        // Real applyResolve saved its lifecycle row and then reached the actual
        // physical sync. The delay models the queue between those existing writes.
        resolving = Life.applyResolve(state, outcome());
        await waiting;
        const before = await counts(characterId);
        assert.deepEqual([before.saved, before.bag, before.warehouse], [30, 10, 20]);
        assert.equal(before.life.simulationOwner, 'legacy_main');
        assert.equal(before.life.phase, 'cold');
        assert.equal(before.life.activity, 'hunting');
        const selected = hydrate
            ? (await Life.statesByIds([characterId], { ownerId: 'legacy_main', unassigned: true }))[0]
            : Life.cachedState(characterId);
        assert.equal(selected.inventory[STEM].amount, hydrate ? 30 : 10);
        assert.equal(selected.simulation.revision, before.life.simulationRevision,
            'the old cache can share the newer SQL row revision');
        // This fixture is already at Giran's service. Both attempts enter
        // the town-only path so materialization/native bag fences, not the
        // cheap out-of-town guard, must reject the first withdrawal.
        const blocked = await Warehouse.releaseCold(selected, { inTown: true });
        const afterAttempt = await counts(characterId);
        assert.equal(blocked.released, false, 'warehouse waits for pending loot materialization');
        assert.deepEqual([afterAttempt.saved, afterAttempt.bag, afterAttempt.warehouse], [30, 10, 20]);
        assert.equal(afterAttempt.life.simulationRevision, before.life.simulationRevision);
        assert.equal(JSON.parse(afterAttempt.life.statsJson).lastWarehouseWithdrawal, undefined);
        resume();
        const resolved = await resolving;
        assert(resolved, 'the original legacy resolve completes');
        assert.equal(resolved.level, 40);
        assert.equal(resolved.exp, state.exp + 1000);
        assert.equal(resolved.sp, 10);
        Database.syncInventorySummary = originals.sync;
        const materialized = await counts(characterId);
        assert.deepEqual([materialized.saved, materialized.bag, materialized.warehouse], [30, 30, 20]);
        const released = await Warehouse.releaseCold(Life.cachedState(characterId), { inTown: true });
        assert.equal(released.released, true, 'the bounded withdrawal can retry after materialization');
        assert.deepEqual(released.items.map(item => [item.selfId, item.amount, item.reason]), [[STEM, 20, 'market']]);
        const complete = await counts(characterId);
        assert.deepEqual([complete.saved, complete.bag, complete.warehouse], [50, 50, 0]);
        assert.equal(complete.wallet, 100000);
        assert.equal(complete.life.adena, 100000);
        assert.equal(complete.life.exp, state.exp + 1000);
        assert.equal(complete.life.sp, 10);
        console.log(`PASS native withdrawal during legacy loot materialization (${hydrate ? 'fresh SQL hydration' : 'old cache, same revision'})`);
    } finally {
        resume();
        if (resolving) await resolving;
        Database.syncInventorySummary = originals.sync;
    }
}

async function staleCallerAfterMaterialization(characterId) {
    const oldState = await seed(characterId);
    const resolved = await Life.applyResolve(oldState, outcome());
    const before = await counts(characterId);
    assert.deepEqual([before.saved, before.bag, before.warehouse], [30, 30, 20]);
    assert.equal(oldState.simulation.revision, resolved.simulation.revision,
        'legacy materialization does not advance simulation ownership revision');
    const [row] = await Database.fetchWarehouseItems(characterId);
    await assert.rejects(Database.transferWarehouseToInventory(characterId, {
        id: row.id, selfId: STEM, name: 'Stem', amount: 20, stackable: true
    }, { coldState: oldState, withdrawal: { items: [{ selfId: STEM, amount: 20, reason: 'market' }], at: Date.now() } }),
    /economy_state_changed/, 'a stale caller summary cannot plan against a newer physical bag at the same revision');
    const after = await counts(characterId);
    assert.deepEqual([after.saved, after.bag, after.warehouse], [30, 30, 20]);
    assert.equal(after.life.simulationRevision, before.life.simulationRevision);
    assert.equal(after.wallet, 100000);
    console.log('PASS native withdrawal rejects an old caller after real materialization at the same revision');
}

(async () => {
    const ids = [760001, 760002, 760003];
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 40 })), 'group-f-warehouse-materialization');
    try {
        await Life.init();
        await duringMaterialization(ids[0], true);
        await duringMaterialization(ids[1], false);
        await staleCallerAfterMaterialization(ids[2]);
        console.log('Group F warehouse materialization: native fences, actual legacy loot, XP/SP and quantity conservation passed');
    } finally {
        Database.syncInventorySummary = originals.sync;
        Market.saleDecision = originals.sale;
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
