'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-crystal-supply');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Supply = require('../src/GameServer/Bot/Economy/ClanCrystalSupply');
const Native = require('./helpers/nativeMarketFixture');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const town = { locX: 83396, locY: 147904, locZ: -3400 };
const q = (sql, values = []) => DB.execute([sql, values]);
async function seed(id, targetId) {
    await Native.character(DB, id, `ClanCrystal${id}`, `bot_clan_crystal_${id}`, town);
    await q('UPDATE characters SET level=55,classId=17,clanId=701 WHERE id=?', [id]);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 30000000 });
    for (const item of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 17, level: 40 }).items) {
        if (item.selfId !== targetId && !(targetId === 608 && item.slot === 9)) await DB.setItem(id, { ...item, amount: 1, equipped: true,
            name: Data.items.find(row => row.selfId === item.selfId).template.name });
    }
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveVariantsByProductId(targetId)[0];
    const exchange = invoke('GameServer/Bot/Economy/BotLuxuryExchange').recipes().get(targetId);
    const plan = { status: 'active', strategy: exchange ? 'luxury_exchange' : 'craft',
        target: { selfId: targetId, slot: exchange ? 9 : 15 },
        ...(exchange ? { exchange, materials: exchange.materials } : { recipeId: recipe.recipeId, materials: recipe.materials }),
        clanGoal: { clanId: 701, beneficiaryId: id, goalKey: `clan-equipment:701:${id}:${targetId}:${exchange ? 9 : 15}` } };
    let state = { characterId: id, accountName: `bot_clan_crystal_${id}`, name: `ClanCrystal${id}`, clanId: 701,
        level: 55, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', loc: town, adena: 30000000,
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)), vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        stats: { classId: 17, clanId: 701, equipmentPlan: plan,
            clanMaterialDemand: Object.fromEntries(plan.materials.map(row => [row.selfId, row.amount])) } };
    state.stats.coldCombat = invoke('GameServer/Bot/Population/ColdCombatProfile').legacySnapshot(state, []);
    for (const [selfId, amount] of [[invoke('GameServer/Inventory/ShotStock').planForState(state).selfId, 3000], [1061, 20], [736, 10]])
        await DB.setItem(id, { selfId, name: Data.items.find(row => row.selfId === selfId).template.name, amount });
    state.inventory = Life.inventorySummaryFromItems(await DB.fetchItems(id));
    await q(`INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES(701,'autonomous',?,1,1)
        ON CONFLICT(clanId) DO UPDATE SET stateJson=excluded.stateJson`, [JSON.stringify({ mode: 'autonomous',
        goal: { type: 'equipment', status: 'executing', goalKey: plan.clanGoal.goalKey, target: {
            memberId: id, itemId: targetId, slot: plan.target.slot } } })]);
    return Life.upsertState(state, 'clan_crystal_fixture');
}
function context(state, options = {}) {
    return Economy.forState(state, { board: options.board || new BoardIndex(), spots: [], caller: 'meeting_prepare',
        npcOffersFor: invoke('GameServer/Bot/Population/ColdOccupationSources').npcOffersFor,
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshop: null, knownRecipes: [], ...options });
}
async function run() {
    Data.init(); await DB.init(); await Life.init();
    invoke('GameServer/Bot/Population/ColdOccupationSources').initialise();
    await q("INSERT INTO clans(id,name,level,leaderId) VALUES(701,'CrystalSupply',3,98101)");
    for (const [id, targetId] of [[98101, 608], [98102, 2406]]) {
        let state = await seed(id, targetId);
        const original = structuredClone(state.stats.equipmentPlan);
        const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        assert.equal(lifecycleKind({ ...state, activity: 'hunting' }), 'command',
            'a clan crystal shortage reaches the native writer before inputs have arrived');
        assert.equal(lifecycleKind({ ...state, activity: 'traveling' }), 'resolver', 'travel still finishes in the pure resolver');
        assert.equal(lifecycleKind({ ...state, activity: 'resting', stats: { ...state.stats, restUntil: Date.now() + 1000 } }),
            'resolver', 'paid recovery finishes before crystal supply');
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const personal = { ...state, stats: { ...state.stats, equipmentPlan: { ...original, clanGoal: undefined } } };
        assert.notEqual(Sections.semanticFacts(state).stores, Sections.semanticFacts(personal).stores,
            'clan ownership changes invalidate held economy decisions even when material counts are unchanged');
        assert(Supply.requirement(state));
        assert(!Supply.requirement({ ...state, clanId: 0 }), 'leaving the clan releases the supply request');
        assert(!Supply.requirement({ ...state, stats: { ...state.stats, equipmentPlan: { ...original, status: 'cancelled' } } }));
        assert(!Supply.requirement({ ...state, inventory: { ...state.inventory,
            [targetId]: { selfId: targetId, amount: 1, equipped: false } } }),
            'a delivered target cannot start another crystal trip while native equipment selection retains its current set');
        const operations = [];
        for (let step = 0; step < 16; step++) {
            const economy = context(state), leaf = economy.network.activity;
            assert(leaf, 'accepted clan crystal demand must select a physical supply operation');
            const selected = Providers.personalCraftPlan(state, economy);
            assert.equal(selected?.target.selfId, targetId, `personal gear cannot replace the accepted clan target: ${JSON.stringify(leaf)}`);
            assert.deepEqual(selected.clanGoal, original.clanGoal);
            state = await Life.upsertState({ ...state, activity: 'shopping', stats: { ...state.stats,
                ...economy.statsPacket, equipmentPlan: selected } }, 'clan_crystal_step');
            if (leaf.activity === 'shopping') {
                const needs = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(state, { economy });
                assert.equal(needs[0].type, 'buy_craft_material', 'crystallization inputs use the material basket');
                assert.equal(needs[0].target.amount, leaf.amount, 'the native executor retains the full bounded input batch');
                const purchase = Market.planPurchase(state, leaf.itemId, leaf.amount, { npcOnly: true,
                    towns: ['Giran'], money: state.adena,
                    r: invoke('GameServer/Bot/Economy/PurchaseFunding').leafRatio(leaf,
                        economy.network.queue.find(row => row.key === leaf.rootKey)) });
                assert(purchase, JSON.stringify(leaf));
                const bought = await Market.buyHere(state, purchase);
                assert(bought.units > 0); state = bought.state; operations.push('buy');
            } else {
                assert.equal(leaf.activity, 'improving', JSON.stringify(leaf));
                const packet = Decision.capture(economy, state);
                const result = await Improvements.reviewCold(state, { decide: () => packet });
                assert(result.changed, `${leaf.kind}: ${result.reason}`);
                state = result.state; operations.push(leaf.kind);
            }
            if (targetId === 608 && state.inventory[608]?.equipped) break;
            if (targetId === 2406 && Number(state.inventory[1459]?.amount) >= 95) break;
        }
        assert(operations.includes('buy') && operations.includes('crystallize') && operations.includes('luxury_exchange'));
        if (targetId === 608) assert(state.inventory[608]?.equipped, 'native exchange delivers and equips the requested C gloves');
        else assert(Number(state.inventory[1459]?.amount) >= 95, 'native D purchase, D crystallization, C exchange and C crystallization fund the B recipe');
        assert(state.adena < 30000000 && state.adena >= 0, 'all inputs are physically paid for');
        assert((await DB.fetchItems(id)).some(row => row.equipped && row.slot !== 9), 'worn equipment survives crystallization');
        console.log(targetId, operations.join(' -> '));
    }
    const waiting = await seed(98106, 608), board = new BoardIndex();
    const beforeSupply = context(waiting, { board, caller: 'step' });
    const supplied = { ...waiting, inventory: { ...waiting.inventory,
        1458: { selfId: 1458, amount: 310, stackable: true } },
        stats: { ...waiting.stats, ...beforeSupply.statsPacket }, updatedAt: waiting.updatedAt + 1 };
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    assert.notEqual(Sections.semanticFacts(waiting).stores, Sections.semanticFacts(supplied).stores,
        'physical crystal progress invalidates retained source calculations and worker advice');
    assert.equal(Sections.semanticFacts(supplied).stores, Sections.semanticFacts({ ...supplied,
        inventory: { ...supplied.inventory, 1458: { ...supplied.inventory[1458], amount: 400 } } }).stores,
        'surplus crystals beyond this owner requirement do not rebuild its supply route');
    const afterSupply = context(supplied, { board, caller: 'step' });
    assert.equal(afterSupply.network.activity?.kind, 'luxury_exchange',
        'a held crystal purchase advances to delivery when its physical crystals arrive');
    const crowded = await seed(98105, 608);
    crowded.inventory = { ...crowded.inventory, 628: { selfId: 628, amount: 3, equipped: false, stackable: false } };
    const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const limit = invoke('GameServer/Inventory/InventoryLimits').forState(crowded);
    for (const item of Data.items) {
        if (Floor.stateInventory(crowded, Data.items).slots >= limit) break;
        if (Number(item.template.mass || 0) === 0 && !Number(item.etc.slot) && !crowded.inventory[item.selfId]
            && ![1458, 1459].includes(item.selfId)) crowded.inventory[item.selfId] = { selfId: item.selfId, amount: 1, stackable: true };
    }
    assert.equal(Floor.forState(crowded).reason, 'no_slot');
    const crowdedEconomy = context(crowded);
    assert.equal(crowdedEconomy.network.activity?.kind, 'crystallize', 'the shared solver selects existing free physical inputs');
    const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    assert.equal(Needs.evaluate(crowded, { economy: crowdedEconomy })[0].type, 'improving',
        'space-releasing crystallization can resolve the full bag instead of waiting on a sale');
    assert.equal(Needs.evaluate({ ...crowded, activity: 'dead' }, { economy: crowdedEconomy })[0].type, 'recover');
    const buyEconomy = { ...crowdedEconomy, network: { ...crowdedEconomy.network,
        activity: { ...crowdedEconomy.network.activity, activity: 'shopping', kind: 'buy' } } };
    assert.equal(Needs.evaluate(crowded, { economy: buyEconomy })[0].type, 'sell_inventory', 'a full bag still forbids purchases');
    const now = Date.now();
    const field = { ...crowded, activity: 'hunting', currentRegion: 'Breka Orc Overlord fields',
        loc: { locX: 78088, locY: 124933, locZ: -2792 }, stats: { ...crowded.stats,
            partyMarketReturn: { partyId: 'retired_clan_party', until: now - 1 } } };
    const travel = Improvements.acquisitionTravel(field, crowdedEconomy.network.activity, now);
    assert(travel?.stats.travel && !travel.stats.partyMarketReturn, 'an expired party ticket cannot block the selected crystallization trip');
    assert.equal(field.stats.partyMarketReturn.partyId, 'retired_clan_party', 'trip planning leaves the input snapshot unchanged');
    assert.equal(Improvements.acquisitionTravel({ ...field, stats: { ...field.stats,
        partyMarketReturn: { ...field.stats.partyMarketReturn, until: now + 60000 } } }, crowdedEconomy.network.activity, now),
        null, 'a current party reservation still owns its member');

    let exact = await seed(98103, 608);
    await DB.setItem(exact.characterId, { selfId: 1458, name: 'Crystal: D-Grade', amount: 310 });
    exact = await Life.upsertState({ ...exact, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(exact.characterId)) }, 'exact_clan_crystals');
    const exchange = invoke('GameServer/Bot/Economy/BotLuxuryExchange').recipes().get(608);
    const packet = Decision.capture({ riskWeight: 1, network: { activity: { activity: 'improving', improvement: {
        kind: 'luxury_exchange', ...exchange } } } }, exact);
    const completed = await Improvements.reviewCold(exact, { decide: () => packet });
    assert(completed.changed && completed.state.inventory[608]?.equipped, 'the current clan owner may consume exactly its 310 reserved crystals');
    assert(!completed.state.inventory[1458], 'the exchange consumes the exact physical stack');

    let stale = await seed(98104, 608);
    await DB.setItem(stale.characterId, { selfId: 1458, name: 'Crystal: D-Grade', amount: 310 });
    stale = await Life.upsertState({ ...stale, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(stale.characterId)) }, 'stale_clan_crystals');
    await q("UPDATE clan_simulation_clans SET stateJson=json_set(stateJson,'$.goal.goalKey','replacement') WHERE clanId=701");
    await assert.rejects(DB.applyBotImprovement(stale.characterId, { kind: 'luxury_exchange', ...exchange }, { coldState: stale }),
        /improvement_missing_materials/, 'an obsolete owner cannot consume crystals reserved for the replacement goal');
    console.log('Clan D/C crystal supply native purchases, conversions, ownership and equipment checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await DB.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
});
