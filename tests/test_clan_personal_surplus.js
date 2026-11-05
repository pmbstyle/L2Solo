'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Supplies = invoke('GameServer/Clan/ClanSupplyPolicy');
const Policy = invoke('GameServer/Clan/ClanWarehousePolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const nativeDecision = require('./helpers/workerEconomyDecision');
const id = 730210, mate = 730211, clanId = 730212;
async function run() {
    const world = await createWorld([{ id, classId: 35, race: 2, level: 33 }, { id: mate, level: 33 }], 'clan-personal-surplus');
    try {
        await Life.init();
        const material = { selfId: 1864, name: 'Stem', amount: 20, kind: 'Other.Material', stackable: true };
        const state = { characterId: id, level: 33, phase: 'cold', activity: 'hunting', clanId,
            adena: 10000, inventory: { 1864: material }, stats: { classId: 35, clanId },
            loc: { locX: 83400, locY: 148600, locZ: -3400 }, vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, timing: {} };
        const candidates = s => Disposition.saleCandidates(s, { unlimited: true, keptAmounts: {} });
        const craft = { goalKey: 'craft-active', type: 'equipment', status: 'executing', policy: { strategy: 'craft' },
            plan: { craft: { materials: [{ selfId: 1864, required: 10 }] } } };
        Supplies.publish({ id: clanId, level: 0, state: { productionGoal: craft } });
        assert.equal(candidates(state).find(row => row.selfId === 1864).count, 20, 'no warehouse means ordinary personal stock');
        assert.deepEqual(Supplies.reservedAmounts(state), {});
        Supplies.publish({ id: clanId, level: 1, state: {} });
        assert.equal(candidates(state).find(row => row.selfId === 1864).count, 20, 'membership alone never reserves all resources');
        assert.deepEqual(Policy.depositCandidates(state, [{ ...material, id: 1 }], [], { demand: {} }), []);
        Supplies.publish({ id: clanId, level: 1, state: { productionGoal: craft } }, [{ selfId: 1864, amount: 3 }]);
        assert.equal(candidates(state).find(row => row.selfId === 1864).count, 13, 'only the seven missing craft inputs are reserved');
        const ownCraft = { ...state, stats: { ...state.stats, equipmentPlan: { strategy: 'craft', status: 'active',
            materials: [{ selfId: 1864, amount: 10 }] } } };
        assert.equal(candidates(ownCraft).find(row => row.selfId === 1864).count, 3,
            'own inputs and clan inputs cannot spend the same units twice');
        assert.equal(Policy.depositCandidates(ownCraft, [{ ...material, id: 3 }], [], { demand: { 1864: 7 } })[0].amount, 7,
            'clan delivery leaves all ten personal inputs with the owner');
        const moved = Policy.depositCandidates(state, [{ ...material, id: 1, amount: 12 }, { ...material, id: 2, amount: 8 }],
            [{ selfId: 1864, amount: 3 }], { demand: { 1864: 10 } });
        assert.equal(moved.reduce((sum, row) => sum + row.amount, 0), 7, 'split physical rows cannot exceed the shared deficit');
        Supplies.publish({ id: clanId, level: 1, state: { productionGoal: { ...craft, status: 'completed' } } });
        assert.equal(candidates(state).find(row => row.selfId === 1864).count, 20, 'terminal goals release their earmarks');
        const trident = DataCache.items.find(row => row.selfId === 291);
        await Life.upsertState({ ...state, clanId: 0, stats: { ...state.stats, clanId: 0 } });
        const stored = await Database.setWarehouseItem(id, { selfId: 291, name: trident.template.name, amount: 1 });
        await Warehouse.init();
        assert.equal(Warehouse.inventory(state)[291].amount, 1);
        const sourceRow = [id, Warehouse.version(state), [[291, 1, 0]]];
        const probe = await nativeDecision({ ...state, clanId: 0, stats: { ...state.stats, clanId: 0 } }, { nativeRoutes: true,
            tables: [{ name: 'personal_warehouse', from: null, to: 1, full: true, rows: [[id, sourceRow]], removed: [] }] });
        assert.equal(probe.forbiddenLoaded.length, 0, 'the real worker reads the warehouse table without a database dependency');
        assert.equal(probe.warehouseAssets[291].amount, 1, 'the native worker sees personal stored assets');
        const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState({ ...state, currentRegion: 'Giran' }, {
            routeRows: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.map(town => town === 'Giran' ? [true, 0, 0] : [true, 1, 30000]),
            spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure() });
        assert(economy.projection.moneyPaths.some(path => path.kind === 'liquidate' && path.items.includes(291)),
            'saved personal stock participates in native funding paths: ' + JSON.stringify({ paths: economy.projection.moneyPaths,
                sale: candidates(Warehouse.saleState(state)), route: economy.trip.details('Giran'),
                seller: invoke('GameServer/Bot/Population/ColdOccupationSources').hasNpcSellerInTown('Giran') }));
        assert.equal(economy.projection.moneyPaths.find(path => path.kind === 'liquidate').town, 'Giran',
            'a cash-poor bot uses the reachable NPC rather than an unaffordable market trip');
        const decision = Listing.evaluate(Warehouse.saleState(state), { economy, slots: 0 });
        assert(!decision.warehouse.some(row => row.selfId === 291), 'a clan adventurer cannot send sale stock back into storage');

        await Database.execute(["INSERT INTO accounts(username,password) VALUES('bot_pop_surplus','test')", []]);
        await Database.execute(["UPDATE characters SET username='bot_pop_surplus' WHERE id IN (?,?)", [id, mate]]);
        await Database.execute(["INSERT INTO bot_life_state(characterId,accountName,level,statsJson) VALUES(?,'bot_pop_surplus',33,'{}')", [mate]]);
        const created = await Database.createAutonomousClan({ name: 'SurplusClan', leaderId: id, memberIds: [id, mate],
            founderQuorum: 2, maxBotClans: 40, maxBotMemberShare: 1, stateJson: { level: 2 } });
        assert.equal(created.ok, true, created.code);
        const actualClan = created.clanId;
        await Database.execute(['UPDATE clans SET level=2 WHERE id=?', [actualClan]]);
        const goal = { goalKey: 'owned-trident', type: 'equipment', status: 'executing', required: 1, progress: 0,
            target: { itemId: 291, memberId: mate }, policy: { strategy: 'market' } };
        await Database.execute(['UPDATE clan_simulation_clans SET stateJson=? WHERE clanId=?',
            [JSON.stringify({ mode: 'autonomous', warehouseRevision: 0, goal }), actualClan]]);
        await Database.execute([`INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,enchant,createdAt,updatedAt)
            VALUES(?,57,'Adena','Other',1000000,0,1,1)`, [actualClan]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000 });
        const physical = await Database.setItem(id, { selfId: 291, name: trident.template.name, amount: 1 });
        let life = await Life.upsertState({ ...state, clanId: actualClan,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats: { classId: 35, clanId: actualClan } }, 'surplus-fixture');
        const request = { clanId: actualClan, characterId: id, item: { id: physical.insertId, selfId: 291, kind: trident.template.kind, stackable: false },
            amount: 1, resolveKey: 'owned-trident-once', goalKey: goal.goalKey, rewardUnitPrice: 204500 };
        const paid = await Database.transferInventoryToClanWarehouse(request);
        assert.equal(paid.ok, true, paid.code);
        assert.equal(paid.reward, 204500);
        const [wallet] = await Database.execute(['SELECT adena,inventorySummary FROM bot_life_state WHERE characterId=?', [id]]);
        assert.equal(wallet.adena, 214500);
        assert.equal(JSON.parse(wallet.inventorySummary)[57].amount, 214500);
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 57).amount, 214500);
        const repeated = await Database.transferInventoryToClanWarehouse(request);
        assert.equal(repeated.ok, false, 'replaying a delivery cannot pay twice');
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 57).amount, 214500);
        const missing = await Database.setItem(id, { selfId: 291, name: trident.template.name, amount: 1 });
        await Database.execute(['DELETE FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [actualClan]]);
        const unpaid = await Database.transferInventoryToClanWarehouse({ ...request, item: { ...request.item, id: missing.insertId }, resolveKey: 'unfunded' });
        assert.equal(unpaid.ok, false);
        assert((await Database.fetchItems(id)).some(row => row.id === missing.insertId), 'without reward funds the owner keeps the item');
        const jamadhr = await Database.setItem(id, { selfId: 259, name: 'Jamadhr', amount: 1 });
        const hotGoal = { ...goal, goalKey: 'owned-jamadhr', target: { memberId: mate, itemId: 259 } };
        Supplies.publish({ id: actualClan, level: 2, state: { mode: 'autonomous', goal: hotGoal } }, []);
        assert.deepEqual(Supplies.reservedAmounts({ clanId: actualClan }), {}, 'an unfunded reward does not freeze personal sale stock');
        Supplies.publish({ id: actualClan, level: 2, state: { mode: 'autonomous', goal: hotGoal } }, [{ selfId: 57, amount: 322000 }]);
        assert.equal(Supplies.reservedAmounts({ clanId: actualClan })[259], 1, 'a funded owned-item goal is earmarked for delivery');
        await Database.execute(['UPDATE clan_simulation_clans SET stateJson=? WHERE clanId=?',
            [JSON.stringify({ mode: 'autonomous', goal: hotGoal }), actualClan]]);
        await Database.execute([`INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,enchant,createdAt,updatedAt)
            VALUES(?,57,'Adena','Other',322000,0,1,1)`, [actualClan]]);
        await Database.execute(["UPDATE bot_life_state SET phase='hot' WHERE characterId=?", [id]]);
        const hotRequest = { ...request, item: { id: jamadhr.insertId, selfId: 259, kind: 'Weapon.DualFist', stackable: false },
            goalKey: hotGoal.goalKey, rewardUnitPrice: 322000, expectedPhase: 'hot', validateLive: () => true, resolveKey: 'hot-owned-item' };
        await Database.execute([`CREATE TEMP TRIGGER fail_owned_reward BEFORE DELETE ON items
            WHEN OLD.characterId=${id} AND OLD.selfId=57 BEGIN SELECT RAISE(ABORT,'reward rollback'); END`, []]);
        await assert.rejects(Database.transferInventoryToClanWarehouse(hotRequest), /reward rollback/);
        assert((await Database.fetchItems(id)).some(row => row.id === jamadhr.insertId), 'a failed payout rolls back the delivery');
        assert.equal((await Database.fetchClanWarehouseItems(actualClan)).find(row => row.selfId === 57).amount, 322000);
        await Database.execute(['DROP TRIGGER fail_owned_reward', []]);
        const hotPaid = await Database.transferInventoryToClanWarehouse(hotRequest);
        assert.equal(hotPaid.ok, true, hotPaid.code);
        assert.equal(hotPaid.state.adena, 536500);
        assert(!(await Database.fetchClanWarehouseItems(actualClan)).some(row => row.selfId === 57), 'an exact reward consumes the treasury row');
        assert(!(await Database.fetchItems(id)).some(row => row.id === jamadhr.insertId));
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 57).amount, 536500);
        await Database.execute(['UPDATE clans SET level=0 WHERE id=?', [actualClan]]);
        const noWarehouse = await Database.transferInventoryToClanWarehouse({ ...request, rewardUnitPrice: 0, resolveKey: 'no-warehouse' });
        assert.equal(noWarehouse.code, 'warehouse_level_unavailable');
        console.log('Clan personal surplus and native warehouse funding checks passed');
    } finally { await world.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
