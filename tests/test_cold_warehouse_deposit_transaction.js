'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-warehouse-deposit');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const STEM = 1864;
let serial = 0;
async function seed(parts = [20]) {
    const account = `bot_deposit_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = (await Database.createCharacter(account, {
        name: `Deposit${serial}`, race: 0, classId: 0, maxHp: 187, maxMp: 74,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83396, locY: 147904, locZ: -3400
    })).insertId;
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000 });
    const items = [];
    for (const amount of parts) items.push({
        id: (await Database.setItem(id, { selfId: STEM, name: 'Stem', amount })).insertId,
        selfId: STEM, name: 'Stem', amount, stackable: true
    });
    const state = await Life.upsertState({ characterId: id, accountName: account, name: `Deposit${serial}`,
        phase: 'cold', activity: 'hunting', level: 40, adena: 100000, currentRegion: 'Giran',
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
        vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 0, generatedCold: true, fixtureNote: 'keep' }
    }, 'deposit_fixture');
    return { id, state, items };
}
async function facts(id) {
    const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    const bag = (await Database.fetchItems(id)).filter(item => item.selfId === STEM).reduce((n, item) => n + item.amount, 0);
    const stored = (await Database.fetchWarehouseItems(id)).filter(item => item.selfId === STEM).reduce((n, item) => n + item.amount, 0);
    return { bag, stored, saved: Number(JSON.parse(row.inventorySummary)[STEM]?.amount || 0), row };
}
async function run() {
    const candidates = Disposition.warehouseCandidates;
    const transfer = Database.transferInventoryToWarehouse;
    try {
        invoke('GameServer/DataCache').init();
        Database.init(); assert(Database.isReady()); await Life.init();
        const first = await seed();
        const moved = await transfer(first.id, first.items[0], { coldState: first.state, craftDepositTarget: 300 });
        // On the unfixed code the cache and saved summary still have 20.
        // The next real worker commit can therefore restore that physical bag.
        if (process.argv.includes('--reproduce')) {
            const looted = { ...first.state.inventory, [STEM]: { ...first.state.inventory[STEM], amount: 21 } };
            const [commit] = await Owner.commitBatch([{ revision: first.state.simulation.revision,
                nextState: { ...first.state, inventory: looted },
                proposal: InventorySummary.bagChange(first.state.inventory, looted)
            }]);
            assert(commit.ok);
            const actual = await facts(first.id);
            console.log(`E222 reproduction: initial=20 loot=1 bag=${actual.bag} warehouse=${actual.stored} total=${actual.bag + actual.stored}`);
            assert.equal(actual.bag + actual.stored, 21, 'a cold commit must not recreate deposited items');
            return;
        }
        assert(moved.coldLifeRow, 'deposit must return its atomically committed inventory projection');
        assert.equal(moved.coldLifeRow.simulationRevision, first.state.simulation.revision + 1);
        const after = await facts(first.id);
        assert.equal(after.saved, 0); assert.equal(after.bag, 0); assert.equal(after.stored, 20);
        assert.equal(JSON.parse(after.row.statsJson).fixtureNote, 'keep');
        assert.equal(JSON.parse(after.row.statsJson).craftWarehouseDepositTarget, 300,
            'the project marker commits together with the physical deposit');
        const stale = { ...first.state.inventory, [STEM]: { selfId: STEM, name: 'Stem', amount: 21 } };
        const [behind] = await Owner.commitBatch([{ revision: first.state.simulation.revision,
            nextState: { ...first.state, inventory: stale },
            proposal: InventorySummary.bagChange(first.state.inventory, stale) }]);
        assert.equal(behind.reason, 'stale_revision', 'a step from before the deposit is refused');
        const fresh = Life.acceptInventoryProjection(moved.coldLifeRow);
        assert(fresh); assert.equal(Number(fresh.inventory[STEM]?.amount || 0), 0);
        const loot = { ...fresh.inventory, [STEM]: { selfId: STEM, name: 'Stem', amount: 1 } };
        const [commit] = await Owner.commitBatch([{ revision: fresh.simulation.revision,
            nextState: { ...fresh, inventory: loot },
            proposal: InventorySummary.bagChange(fresh.inventory, loot)
        }]);
        assert(commit.ok);
        assert.equal((await facts(first.id)).bag, 1, 'fresh cold commit adds only the new loot');

        const rollback = await seed();
        await Database.execute([`CREATE TRIGGER deposit_projection_fault BEFORE UPDATE OF inventorySummary ON bot_life_state
            WHEN NEW.characterId=${rollback.id} BEGIN SELECT RAISE(ABORT,'deposit_projection_fault'); END`]);
        await assert.rejects(transfer(rollback.id, rollback.items[0], { coldState: rollback.state, craftDepositTarget: 300 }), /deposit_projection_fault/);
        let unchanged = await facts(rollback.id);
        assert.deepEqual([unchanged.bag, unchanged.stored, unchanged.saved], [20, 0, 20]);
        assert.equal(JSON.parse(unchanged.row.statsJson).craftWarehouseDepositTarget, undefined,
            'a rolled-back deposit cannot leave a phantom return visit');
        await Database.execute(['DROP TRIGGER deposit_projection_fault']);
        // A main write moved the row after the caller read its copy.
        await Database.updateGeneratedBotName(rollback.id, `Moved${rollback.id}`, 3);
        await assert.rejects(transfer(rollback.id, rollback.items[0], { coldState: rollback.state }), /economy_state_changed/);
        unchanged = await facts(rollback.id);
        assert.deepEqual([unchanged.bag, unchanged.stored, unchanged.saved], [20, 0, 20]);

        Disposition.warehouseCandidates = state => Object.values(state.inventory).filter(item => item.selfId === STEM && item.amount > 0);
        const multiple = await seed([3, 4]);
        const result = await Warehouse.depositCold({ ...multiple.state,
            stats: { ...multiple.state.stats, unsavedVisitNote: 'keep-current-visit' } });
        assert.equal(result.count, 7);
        assert.equal(Number(result.state.inventory[STEM]?.amount || 0), 0);
        assert.equal(result.state.simulation.revision, multiple.state.simulation.revision + 2);
        assert.equal(result.state.stats.unsavedVisitNote, 'keep-current-visit', 'projection must preserve caller metadata absent from the cache');
        assert.deepEqual([(await facts(multiple.id)).bag, (await facts(multiple.id)).stored, (await facts(multiple.id)).saved], [0, 7, 0]);

        // Real adventurer selection, physical transfer and marker: the paused
        // kit stores only its own reserved share, leaving unrelated stock free.
        const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        const retained = await seed([20]);
        const retainedPlan = { status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: 1,
            target: { selfId: 76, slot: 7 }, materials: [{ selfId: STEM, amount: 7 }], heldInputs: { [STEM]: 7 } };
        const retainedState = await Life.upsertState({ ...retained.state, stats: { ...retained.state.stats,
            equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 129, slot: 7 },
                inputPreparation: retainedPlan } } }, 'fixture_retained_craft');
        Index.useRowSource(() => undefined, () => true);
        Disposition.warehouseCandidates = candidates;
        try {
            assert.equal(Disposition.warehouseCandidates(retainedState).find(item => item.selfId === STEM)?.amount, 7);
            const saved = await Warehouse.depositCold(retainedState);
            assert.equal(saved.count, 7);
            const actual = await facts(retained.id);
            assert.deepEqual([actual.bag, actual.stored, actual.saved], [13, 7, 13]);
            assert.equal(JSON.parse(actual.row.statsJson).craftWarehouseDepositTarget, 76);
        } finally {
            Index.useRowSource();
            Disposition.warehouseCandidates = state => Object.values(state.inventory).filter(item => item.selfId === STEM && item.amount > 0);
        }

        const handoff = await seed([3, 4]);
        let calls = 0;
        Database.transferInventoryToWarehouse = async (...args) => {
            const result = await transfer(...args);
            if (++calls === 1) {
                const current = Life.acceptInventoryProjection(result.coldLifeRow);
                assert(await Life.upsertState({ ...current, stats: { ...current.stats, note: 'newer row' } }, 'newer_row_after_first_deposit'));
            }
            return result;
        };
        const partial = await Warehouse.depositCold(handoff.state);
        assert(partial.aborted); assert.equal(calls, 1);
        assert.equal(partial.count, 3);
        assert.equal(partial.state.stats.note, 'newer row', 'a returned older row cannot replace the newer one');
        const partialFacts = await facts(handoff.id);
        assert.deepEqual([partialFacts.bag, partialFacts.stored, partialFacts.saved], [4, 3, 4]);

        // Exercise the outer board-success continuation with a real native
        // deposit and hot handoff. Earlier visit steps are unrelated adapters.
        const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketListingService');
        const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
        const Safe = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
        const Buyer = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
        const Static = invoke('GameServer/Bot/Economy/StaticBuyerService');
        const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
        const replacements = [];
        const replace = (object, key, value) => { replacements.push([object, key, object[key]]); object[key] = value; };
        try {
            replace(Safe, 'enchantSafe', state => Promise.resolve({ state }));
            replace(Life, 'learnCraftableRecipes', state => Promise.resolve(state));
            replace(Disposition, 'saleCandidates', state => [state.inventory[STEM]]);
            replace(Market, 'saleDecision', () => ({ listings: [{ selfId: STEM, count: 7 }], npc: [], answers: [], warehouse: [] }));
            replace(Market, 'listOnBoard', state => Promise.resolve({ state, listed: 1 }));
            replace(Buyer, 'sellToBestBuyer', state => Promise.resolve({ state, sold: false }));
            replace(Static, 'sell', state => Promise.resolve({ state, sold: false }));
            replace(Life, 'applyNpcLiquidation', state => Promise.resolve(state));
            replace(Goals, 'finishMarketVisit', () => { throw Error('market must not continue a handed-off visit'); });
            const hotCase = await seed([3, 4]);
            let hotState;
            Database.transferInventoryToWarehouse = async (...args) => {
                const result = await transfer(...args);
                const projected = Life.acceptInventoryProjection(result.coldLifeRow);
                hotState = await Life.upsertState({ ...projected, phase: 'hot' }, 'deposit_hot_handoff');
                return result;
            };
            const marketStopped = await ColdMarket.open({ ...hotCase.state, activity: 'shopping' });
            assert(marketStopped.aborted); assert.equal(marketStopped.listed, false);
            assert.equal(marketStopped.state, hotState);
            assert.equal(marketStopped.state.phase, 'hot');
            const hotFacts = await facts(hotCase.id);
            assert.deepEqual([hotFacts.bag, hotFacts.stored, hotFacts.saved], [4, 3, 4]);
        } finally {
            for (const [object, key, previous] of replacements.reverse()) object[key] = previous;
        }

        await Database.close(); Database.init(); assert(Database.isReady());
        const reopened = await facts(multiple.id);
        assert.deepEqual([reopened.bag, reopened.stored, reopened.saved], [0, 7, 0]);
        console.log('PASS E222 no resurrection, atomic rollback, stale revision refusal, multiple rows, partial newer row and reopen');
    } finally {
        Disposition.warehouseCandidates = candidates; Database.transferInventoryToWarehouse = transfer;
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
