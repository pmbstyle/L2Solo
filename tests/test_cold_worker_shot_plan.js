process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture asserts the optional worker telemetry bridge.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('worker-shot-plan');
const path = require('node:path');
const fs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
process.env.BOT_STATIC_SHOTS_DISABLED = 'true';
const Database = invoke('Database'), DataCache = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const root = path.resolve(__dirname, '..');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '710021';
// Keep the original native fixture and assertions, with both literal UUID
// database paths configured and asserted before the first connection.
async function createWorld(characters) {
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    Object.assign(options.default.General, { questExpRate: 1, questSpRate: 1, questAdenaRate: 1 });
    DataCache.init();
    fixture.assertConfigured(options.default);
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('quests','test')");
    const insert = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'quests',?,?,?, ?,?,0,187,74,187,74,0,0,0,0,0,0,0,-1,0)`);
    for (const character of characters) insert.run(character.id, character.name || `Quest${character.id}`,
        Number(character.classId || 0), Number(character.race || 0), Number(character.level || 20), Number(character.exp || 0));
    seed.close();
    fixture.assertConfigured(options.default);
    await Database.init();
    return { async close() { await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); } };
}
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
    const before = index.marketSnapshot(timestamp, crafted).unlistedSupply.get(1463);
    const proposed = { ...crafted, inventory: { ...crafted.inventory, 1463: { selfId: 1463, amount: 1000100 } } };
    const overlay = index.marketSnapshot(timestamp, proposed).unlistedSupply.get(1463);
    const held = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    kernel.upsert({ state: proposed, context: entry.context });
    const committed = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    kernel.upsert({ state: proposed, context: entry.context });
    const duplicate = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    kernel.remove(state.characterId);
    const removed = index.marketSnapshot(timestamp).unlistedSupply.get(1463);
    return { indexHooks: { before, overlay, held, committed, duplicate, removed }, candidate, hour: economy.hourAdena, regen, demand: [...market.shotDemand.get(1463)], orePrice: market.npcPrice.get(1785), fixed: require('../Economy/StaticMerchantPricing').botPurchasePrice(1463), recipe, plan: result.economyPlan, edges: result.economyEdges, state: result.state,
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
    const id = 710021, sellerId = 710022, buyerId = 710023;
    const world = await createWorld([{ id, classId: 56, level: 20 }, { id: sellerId, classId: 0, level: 30 }, { id: buyerId, classId: 0, level: 30 }], 'worker-shot-plan');
    let worker;
    try {
        await Life.init();
        await Database.createAccount('bot_worker_shots', 'fixture');
        await Database.createAccount('bot_recipe_supplier', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_worker_shots', id]]);
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_recipe_supplier', sellerId]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000000 });
        await Database.setItem(id, { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 });
        const offeredRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(20);
        await Database.setSkill({ selfId: 172, name: 'Create Item', level: offeredRecipe.level }, id);
        await Database.setItem(sellerId, { selfId: 57, name: 'Adena', amount: 10000000 });
        await Database.setItem(sellerId, { selfId: offeredRecipe.recipeItemId, name: 'Genuine shot recipe', amount: 1 });
        await Database.setItem(sellerId, { selfId: 1458, name: 'Crystal D', amount: 10000 });
        await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 10000000 });
        await Afk.publishBot(buyerId, { kind: 'shop',  storeType: 3, town: 'Giran',
            lines: [1463, 2510].map(selfId => ({ selfId, count: 10000, price: selfId === 1463 ? 100 : 300, stackable: true })) });
        const supplierBag = await Database.fetchItems(sellerId);
        await Afk.publishBot(sellerId, { kind: 'shop',  storeType: 1, town: 'Giran', lines: [
            { objectId: supplierBag.find(item => item.selfId === offeredRecipe.recipeItemId).id, selfId: offeredRecipe.recipeItemId, count: 1, price: 1, stackable: false },
            { objectId: supplierBag.find(item => item.selfId === 1458).id, selfId: 1458, count: 10000, price: 100, stackable: true }] });
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
        const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
        const diagnosticCoordinator = new ColdSimulationCoordinator(); diagnosticCoordinator.worker = worker; diagnosticCoordinator.workerEpoch = epoch;
        worker.on('message', message => {
            messages.push(message);
            if (message.type === 'economy_diagnostics') diagnosticCoordinator.onMessage(message, worker, epoch);
        }); worker.on('error', error => { fault = error; });
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
        send('init', { config: { loopIntervalMs: 1000, developerDiagnostics: true, economyDiagnostics: true, economyDiagnosticsBotIds: '710021' } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        // Finite funded demand and explicit finite inputs/scroll. E2 correctly
        // refuses to invent a missing recipe or ingredient source from a bid.
        const boardRows = [...(await Database.fetchAfkTradeShops(sellerId)), ...(await Database.fetchAfkTradeShops(buyerId))].map(shop => [shop.id,
            require('../src/GameServer/AfkTrade/BoardIndex').rowOf(Afk.recordStore(shop.id))]);
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: boardRows,
            removed: [], last: true }, { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state, context: { knownShotRecipes: [], buyOrderEscrow: 0 } }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), shotProbe: true });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        const result = response.value;
        console.log(JSON.stringify({ edges: result.edges, shot: result.plan?.shot, huntHour: result.hour, forbiddenLoaded: result.forbiddenLoaded }));
        const selectedStep = Policy.unpackStep(result.plan?.shot);
        assert(result.edges & 8); assert(selectedStep?.recipeTarget > 0, 'native worker with no known recipe selects a profitable executable recipe');
        assert(messages.some(message => message.type === 'economy_diagnostics'), 'worker emits sampled decision telemetry on the separate developer bridge');
        assert.deepEqual(result.forbiddenLoaded, [], 'pure craft decision loads no World actor, Network or database implementation');
        assert.equal(result.indexHooks.overlay, result.indexHooks.before + 100, 'projected own stock has a transient overlay');
        assert.equal(result.indexHooks.held, undefined, 'foreign stock is never exposed by a global snapshot');
        assert.equal(result.indexHooks.committed, undefined, 'canonical publishing does not expose private bags');
        assert.equal(result.indexHooks.duplicate, undefined);
        assert.equal(result.indexHooks.removed, undefined);

        for (const step of [{ craft: { recipeId: 327, batches: 64 } }, { recipeTarget: 327 }, { wealth: { recipeId: 612, batches: 1 } }]) {
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
            const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(selectedStep.recipeTarget);
            assert.strictEqual(await Shots.obtainRecipe(state, { recipe, route: { profit: 0 } }, now), state);
            assert.strictEqual(await Shots.obtainRecipe(state, { recipe, route: { profit: -1 } }, now), state);
            assert.equal(purchases, 0);
            assert.deepEqual(await Database.fetchItems(id), before);
        } finally { invoke('GameServer/Bot/Economy/ColdMarketService').acquire = previousAcquire; }
        const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(selectedStep.recipeTarget);
        await Life.upsertState({ characterId: sellerId, accountName: 'bot_recipe_supplier', name: 'RecipeSupplier',
            level: 30, exp: Number(DataCache.experience[29]), phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
            adena: Number((await Database.fetchItems(sellerId)).find(row => row.selfId === 57)?.amount || 0), inventory: Life.inventorySummaryFromItems(await Database.fetchItems(sellerId)),
            loc: state.loc, vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, stats: { classId: 0 } }, 'shot_supplier_fixture');
        state = await Life.upsertState({ ...result.state, activity: 'shopping', currentRegion: 'Giran' }, 'shot_plan_accepted_fixture');
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
        // An owned book without a supported profitable exit is held. Neither
        // ownership nor an old recipe-target packet invents a craft opportunity.
        const ownedRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(317);
        await Database.setItem(id, { selfId: ownedRecipe.recipeItemId, name: 'Owned shot recipe', amount: 1 });
        state = await Life.syncExternalInventory(id, 'natural_recipe_fixture', Life.cachedState(id));
        state = await Life.upsertState({ ...state, stats: { ...state.stats,
            shotRecipeDemand: { itemId: ownedRecipe.recipeItemId, amount: 1, maxSpend: 1, at: Date.now() } } }, 'owned_recipe_demand_fixture');
        const noDemand = { ...await Shots.marketSnapshot(), shotDemand: new Map(), offersFor: () => [] };
        const ownedStep = Policy.decide(state, noDemand, [20]);
        assert.equal(ownedStep, null, 'an unsupported own book stays available for a later useful opportunity');
        const beforeLearn = state.adena;
        const heldBook = await Shots.execute(state, { recipeTarget: 317 });
        assert(!(await Database.fetchCharacterRecipes(id)).some(row => Number(row.recipeId) === 317));
        assert.equal(heldBook.adena, beforeLearn);
        assert.equal((await Database.fetchItems(id)).filter(row => row.selfId === ownedRecipe.recipeItemId).reduce((sum, row) => sum + row.amount, 0), 1);
        await invoke('HistoryDatabase').flush();
        const diagnostics = fs.readFileSync(path.join(fixture.directory, 'logs/economy-diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        // The bridge is bounded (64 records a second): whether the later town
        // choice survives depends on the wall-clock second it lands in, so the
        // check is that this bot's worker records reach the writer at all.
        assert(diagnostics.some(row => row.owner === id && row.thread === 'worker'), 'sampled worker choices reach the existing history writer');
        console.log('Native worker executable recipe decision, physical purchase, own-stock privacy, held unsupported book, zero economy fences and margin rejection passed');
    } finally { await worker?.terminate(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
