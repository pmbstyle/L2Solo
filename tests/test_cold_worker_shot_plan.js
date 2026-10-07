const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
process.env.BOT_STATIC_SHOTS_DISABLED = 'true';
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const root = path.resolve(__dirname, '..');
const observer = String.raw`
module.exports.shotProbe = async () => {
    const entry = kernel.states.get(710021), state = entry.state, timestamp = Date.now();
    entry.context.goalReviewAt = timestamp;
    const result = await kernel.projectResolve(state, { patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        debug: {}, events: [], nextResolveAt: timestamp + 60000 }, timestamp);
    const index = require('../Economy/ShotMarketIndex').native(), market = index.marketSnapshot(timestamp);
    const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(result.state, { timestamp });
    const regen = invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(result.state);
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(20);
    const candidate = require('../Economy/ShotCraftPolicy').craftCandidate(result.state, recipe, { ...market, offersFor: (...args) => index.offersFor(...args), context: { ...economy, mpPerHour: regen.mp * 1200 } });
    const crafted = { ...state, stats: { ...state.stats, shotCraft: { recipeId: 20 } },
        inventory: { ...state.inventory, 1463: { selfId: 1463, amount: 1000000 } } };
    kernel.upsert({ state: crafted, context: entry.context });
    const before = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    const proposed = { ...crafted, inventory: { ...crafted.inventory, 1463: { selfId: 1463, amount: 1000100 } } };
    const overlay = index.marketSnapshot(timestamp, proposed).unlistedSupply.get(1463);
    const held = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    kernel.upsert({ state: proposed, context: entry.context });
    const committed = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    kernel.upsert({ state: proposed, context: entry.context });
    const duplicate = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    kernel.remove(state.characterId);
    const removed = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    return { indexHooks: { before, overlay, held, committed, duplicate, removed }, candidate, hour: economy.hourAdena, regen, demand: market.shotDemand.get(1463), orePrice: market.npcPrice.get(1785), fixed: require('../Economy/StaticMerchantPricing').botPurchasePrice(1463), recipe, plan: result.economyPlan, edges: result.economyEdges, state: result.state,
        forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/World\/World\.js$/.test(key)),
        known: entry.context.knownShotRecipes };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.shotProbe) return;
    loaded.exports.shotProbe().then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;
(async () => {
    const id = 710021, sellerId = 710022;
    const world = await createWorld([{ id, classId: 56, level: 20 }, { id: sellerId, classId: 0, level: 30 }], 'worker-shot-plan');
    let worker;
    try {
        await Life.init();
        await Database.createAccount('bot_worker_shots', 'fixture');
        await Database.createAccount('bot_recipe_supplier', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_worker_shots', id]]);
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_recipe_supplier', sellerId]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000000 });
        await Database.setItem(id, { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 });
        const now = Date.now();
        let state = await Life.upsertState({ characterId: id, name: 'WorkerCrafter', accountName: 'bot_worker_shots',
            level: 20, exp: Number(DataCache.experience[19]), phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
            adena: 100000000, sp: 0, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId: 56, classProgressionClassId: 56, classProgressionLevel: 20, generatedCold: true },
            timing: { lastResolvedAt: now - 10000, nextResolveAt: now + 60000 } }, 'shot_plan_fixture');
        const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
        for (let i = 0; i < 3; i++) state = { ...state, stats: { ...state.stats,
            huntEfficiency: Hunt.record(state, { spotId: 'crafter_fixture_hunt', cycleMs: 60000,
                adena: 100, exp: 10, kills: 1, timestamp: now }) } };
        state = await Life.upsertState(state, 'shot_plan_measured_income');
        const epoch = 'native:shot-plan', messages = []; let fault;
        worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch,
            workerPath: root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js', observer } });
        worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
        const wait = async predicate => { const deadline = Date.now() + 60000;
            while (!messages.some(predicate)) { if (fault) throw fault;
                const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected));
                if (Date.now() > deadline) throw Error('native shot worker timeout');
                await new Promise(resolve => setTimeout(resolve, 10)); } return messages.find(predicate); };
        const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots', rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        // A real mirrored buy line funds one repeatable D-shot craft route.
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [[710090, [710090, 'buy_ad', 3, sellerId, 'Giran', 1, [[710091, 1463, 0, 10000, 100, null, 0], [710092, 2510, 0, 10000, 300, null, 0]], 1]]], removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state, context: { knownShotRecipes: [], buyOrderEscrow: 0 } }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), shotProbe: true });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        const result = response.value;
        console.log(JSON.stringify({ edges: result.edges, shot: result.plan?.shot, huntHour: result.hour, forbiddenLoaded: result.forbiddenLoaded }));
        assert(result.edges & 8); assert(result.plan?.shot?.recipeTarget > 0, 'native worker with no known recipe selects a profitable recipe');
        assert.deepEqual(result.forbiddenLoaded, [], 'pure craft decision loads no World actor, Network or database implementation');
        assert.equal(result.indexHooks.overlay, result.indexHooks.before + 100, 'projected own stock has a transient overlay');
        assert.equal(result.indexHooks.held, result.indexHooks.before, 'an uncommitted projection does not publish global spare');
        assert.equal(result.indexHooks.committed, result.indexHooks.overlay, 'canonical publish advances the index exactly once');
        assert.equal(result.indexHooks.duplicate, result.indexHooks.committed);
        assert.equal(result.indexHooks.removed, 0, 'canonical delete releases all spare stock');

        for (const step of [{ craft: { recipeId: 327, batches: 64 } }, { recipeTarget: 327 }, { wealth: { recipeId: 612 } }]) {
            const packed = Policy.packStep(step);
            assert(Buffer.byteLength(JSON.stringify({ shot: packed })) - 2 <= 32);
            assert.deepEqual(Policy.unpackStep(packed), step);
        }
        assert.deepEqual(Policy.unpackKnown(Policy.packKnown(Policy.SHOT_RECIPE_IDS)), Policy.SHOT_RECIPE_IDS);
        assert(Buffer.byteLength(JSON.stringify({ knownShotRecipes: Policy.packKnown(Policy.SHOT_RECIPE_IDS) })) <= 64);
        // The real execute site rejects non-positive margin before any write.
        const before = await Database.fetchItems(id), previousAcquire = invoke('GameServer/Bot/Economy/ColdMarketService').acquire;
        let purchases = 0;
        invoke('GameServer/Bot/Economy/ColdMarketService').acquire = async () => { purchases++; throw Error('unexpected recipe spend'); };
        try {
            const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(result.plan.shot.recipeTarget);
            assert.strictEqual(await Shots.obtainRecipe(state, { recipe, route: { profit: 0 } }, now), state);
            assert.strictEqual(await Shots.obtainRecipe(state, { recipe, route: { profit: -1 } }, now), state);
            assert.equal(purchases, 0);
            assert.deepEqual(await Database.fetchItems(id), before);
        } finally { invoke('GameServer/Bot/Economy/ColdMarketService').acquire = previousAcquire; }
        const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(result.plan.shot.recipeTarget);
        await Database.setItem(sellerId, { selfId: 57, name: 'Adena', amount: 10000000 });
        await Database.setItem(sellerId, { selfId: recipe.recipeItemId, name: 'Genuine shot recipe', amount: 1 });
        let supplier = await Life.upsertState({ characterId: sellerId, accountName: 'bot_recipe_supplier', name: 'RecipeSupplier',
            level: 30, exp: Number(DataCache.experience[29]), phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
            adena: 10000000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(sellerId)),
            loc: state.loc, vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, stats: { classId: 0 } }, 'shot_supplier_fixture');
        await Afk.openBotRecords(sellerId, 'buy_ad', [{ storeType: 3, town: 'Giran', title: 'Funded crafted shots',
            lines: [{ selfId: 2510, name: 'Spiritshot D', count: 10000, price: 300, enchant: 0, stackable: true, slot: 0 }] }]);
        const scroll = (await Database.fetchItems(sellerId)).find(row => Number(row.selfId) === Number(recipe.recipeItemId));
        await Afk.openBotRecords(sellerId, 'sell_ad', [{ storeType: 1, town: 'Giran', title: 'One real recipe',
            lines: [{ objectId: scroll.id, selfId: recipe.recipeItemId, name: scroll.name, count: 1, price: 1,
                enchant: 0, stackable: false, slot: 0 }] }]);
        state = await Life.upsertState({ ...result.state, activity: 'shopping', currentRegion: 'Giran' }, 'shot_plan_accepted_fixture');
        const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
        const coordinator = new ColdSimulationCoordinator();
        coordinator.fenceBot = () => { throw Error('economic_fence_forbidden'); };
        const Market = require('../src/GameServer/Bot/Economy/BotAfkMarketService');
        const Goals = invoke('GameServer/Bot/Goals/GoalService'), originalReview = Goals.review;
        Goals.review = async () => null;
        const wallet = state.adena;
        try {
            const execution = await Market.executePlan(state, { shot: result.plan.shot, sell: [], withdraw: [], buyAds: [], travel: null },
                { beforeWrite: () => {}, step: work => coordinator.step('economyPlan', id, work) });
            assert((await Database.fetchCharacterRecipes(id)).some(row => Number(row.recipeId) === recipe.recipeId),
                'main executes the worker recipe target from a genuine physical scroll');
            assert.equal(execution.state.adena, wallet - 1, 'the quoted recipe price is paid once');
            assert.equal((await Database.fetchItems(sellerId)).filter(row => row.selfId === recipe.recipeItemId).reduce((sum, row) => sum + row.amount, 0), 0);
            assert.equal((await Database.fetchItems(id)).filter(row => row.selfId === recipe.recipeItemId).reduce((sum, row) => sum + row.amount, 0), 0,
                'learning consumes the delivered physical scroll');
            assert.equal(coordinator.counters.fences, 0);
            assert.equal(coordinator.counters.afterCommitStepErrors.economyPlan, 0);
        } finally { Goals.review = originalReview; }
        // An owned natural drop is learned even when no current D-shot buyer
        // exists; it is not a second recipe purchase or invented knowledge.
        await Database.setItem(id, { selfId: 1804, name: 'Recipe: Soulshot D', amount: 1 });
        state = await Life.syncExternalInventory(id, 'natural_recipe_fixture', Life.cachedState(id));
        state = await Life.upsertState({ ...state, stats: { ...state.stats,
            shotRecipeDemand: { itemId: 1804, amount: 1, maxSpend: 1, at: Date.now() } } }, 'owned_recipe_demand_fixture');
        const noDemand = { ...await Shots.marketSnapshot(), shotDemand: new Map(), offersFor: () => [] };
        const ownedStep = Policy.decide(state, noDemand, [317]);
        assert.deepEqual(ownedStep, { recipeTarget: 20 }, 'a craftable owned book schedules native learning without requiring a purchase margin');
        const beforeLearn = state.adena;
        const learned = await Shots.execute(state, ownedStep);
        assert((await Database.fetchCharacterRecipes(id)).some(row => Number(row.recipeId) === 20));
        assert.equal(learned.adena, beforeLearn, 'learning an owned scroll spends no Adena');
        assert.equal(learned.stats.shotRecipeDemand, null, 'learning fills the matching recipe demand');
        assert.equal((await Database.fetchItems(id)).filter(row => row.selfId === 1804).reduce((sum, row) => sum + row.amount, 0), 0);
        console.log('Native worker recipe decision, physical purchase/owned-book learning, zero economy fences and margin rejection passed');
    } finally { await worker?.terminate(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
