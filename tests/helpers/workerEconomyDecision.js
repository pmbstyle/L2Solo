'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const root = path.resolve(__dirname, '../..');
const Protocol = require('../../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Geodata = require('../../src/GameServer/Geodata/GeodataEngine');

// A test-only observer of the actual cold worker's native economy and capture.
// No supplied activity/wish/material leaf and no main-thread full model.
const observer = String.raw`
// The town visit's plan (showcase), where a crafter selects its craft. stepEconomy: with
// the step's own economy build and the bot's shot stock.
module.exports.nativeRecipeEarning = async (id, timestamp, stepEconomy = false) => {
    const entry = kernel.states.get(Number(id));
    const economy = stepEconomy ? invoke('GameServer/Bot/Economy/EconomyContext').forState(entry.state, { timestamp }) : null;
    const result = await occupationFor(entry.state, timestamp, economy ? { stock: economy.stock('shots'), economy } : {}, 'showcase');
    return { ...result, forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};
module.exports.nativeTownVisit = async (id, timestamp) => {
    const entry = kernel.states.get(Number(id));
    const lifecycle = await kernel.planLifecycle({ state: entry.state, timestamp });
    // The plan as main receives it: the step's economy stays in the worker.
    const plan = lifecycle && { ...lifecycle };
    if (plan) delete plan.economy;
    return { plan, forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};
module.exports.nativeMarketPlan = async (id, timestamp) => {
    const entry = kernel.states.get(Number(id));
    let state = entry.state;
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), warmCache = [];
    if (workerData.marketWarm) {
        let previous = workerData.marketWarm;
        for (let pass = 0; pass < 3; pass++) {
            kernel.states.set(Number(id), { ...entry, state: previous });
            const routes = await occupationFor(previous, timestamp, {}, 'wish');
            const warmed = Economy.forState(previous, { timestamp, routeRows: routes, caller: 'step' });
            warmCache.push([...Economy.buildDoors().step]);
            previous = { ...previous, stats: { ...previous.stats, ...warmed.statsPacket } };
        }
        // Preserve the real producer's event delta across this warm baseline,
        // exactly as main applies it after the worker's published packet.
        const delta = Number(state.stats?.decisionSeq || 0) - Number(workerData.marketWarm.stats?.decisionSeq || 0);
        state = { ...state, stats: { ...state.stats, ...previous.stats,
            shotRecipeDemand: state.stats.shotRecipeDemand, wishDirty: Number(state.stats.wishDirty) || 0,
            decisionSeq: Number(previous.stats.decisionSeq || 0) + delta } };
        kernel.states.set(Number(id), { ...entry, state });
    }
    const routeRows = await occupationFor(state, timestamp, {}, 'wish');
    const economy = Economy.forState(state, { timestamp, routeRows, caller: 'step' });
    const planState = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    const plan = await occupationFor(planState, timestamp, { economy, stock: economy.stock('shots') }, 'action');
    return { ...plan, statsPacket: economy.statsPacket, warmCache,
        forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};
module.exports.nativeFundingReview = async (id, timestamp, terms) => {
    const entry = kernel.states.get(Number(id)), E = invoke('GameServer/Bot/Economy/EconomyContext');
    const D = require('./ColdEconomyDecision'), T = require('../Economy/TradeIntent');
    const P = require('../Economy/MarketPricing'), B = require('../Economy/BuyAdPolicy');
    let state = entry.state, economy, routes;
    for (let pass = 0; pass < 3; pass++) {
        kernel.states.set(Number(id), { ...entry, state });
        routes = await occupationFor(state, timestamp, {}, 'wish');
        economy = E.forState(state, { timestamp, routeRows: routes, caller: 'step' });
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    }
    const itemId = Number(state.stats.shotRecipeDemand.itemId);
    const intent = economy.watchList.find(row => row.itemId === itemId);
    const options = { economy, board: boardReady(), town: 'Giran', npcOffersFor: () => [] };
    const bid = B.bidFor(state, { type: 'buy_craft_material', target: { itemId, amount: 1 }, intent,
        plan: { purpose: 'recipe', valueRate: intent.valueRate } }, options);
    const before = [...(E.buildDoors().meeting_prepare || [0, 0, 0, 0, 0])], oldMoneyPrice = economy.moneyPrice;
    state = { ...state, adena: terms.adena, inventory: { ...state.inventory,
        ...(state.inventory[57] ? { 57: { ...state.inventory[57], amount: terms.adena } } : {}) } };
    kernel.states.set(Number(id), { ...entry, state });
    economy = E.forState(state, { timestamp, routeRows: routes, caller: 'meeting_prepare' });
    state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    const current = economy.watchList.find(row => row.itemId === itemId);
    const fresh = T.project(state, economy.network, economy.projection, id => economy.worth(id), 40,
        boardReady(), economy.trip.details, economy.survivalReserve).find(row => row.itemId === itemId);
    if (terms.rivalPrice) boardReady().put({ id: 990190, ownerId: 990191, kind: 'shop', custodyPolicy: 0,
        storeType: 3, town: 'Giran', revision: 1, lines: [{ id: 990192, lineId: 990192,
            selfId: itemId, count: 1, price: terms.rivalPrice, enchant: 0 }] });
    const card = D.capture(economy, state), cardWorth = D.preparedCardWorth(card, itemId, state,
        economy.moneyPrice, economy.persona.understanding, true);
    const ctx = P.traderContext(state, { ...options, economy,
        preparedWorth: id => D.preparedCardWorth(card, id, state, economy.moneyPrice, economy.persona.understanding, true) });
    ctx.reviewReasons = new Map([[990193, 2]]);
    const review = P.look(state, [{ ...bid, recordId: 990194, lineId: 990193, ownerId: Number(id),
        storeType: 3, kind: 'shop', custodyPolicy: 0, town: 'Giran', revision: 1 }], ctx);
    return { bid, current, fresh, cardWorth, review, before, after: [...E.buildDoors().meeting_prepare],
        oldMoneyPrice, moneyPrice: economy.moneyPrice,
        spendable: require('../Economy/PurchaseFunding').spendable(state, 0, { r: intent.valueRate }),
        forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};
module.exports.nativeMeetingPreparation = async (id, timestamp, request) => {
    const state = kernel.states.get(Number(id)).state;
    const own = request.actorA === Number(id) ? 0 : 1;
    Object.assign(request.parties[own], require('../Economy/EconomyCommit').authority(state));
    request.parties[own].needRevision = request.parties[own].revision;
    for (const party of request.parties) party.needRevision ??= party.revision;
    const Intent = require('../Economy/TradeIntent'), original = Intent.meetingPurchase;
    const originalStep = occupationPlanner.step;
    let trace, flowInjected = false, flowInvalidated = false;
    if (workerData.duringMeetingMarket?.length) occupationPlanner.step = work => {
        const done = originalStep(work);
        if (!flowInjected && work.stage === WORK_STAGES.indexOf('candidate') + 1) {
            flowInjected = true;
            tables.apply([{ name: 'market', from: 0, to: 1, full: false, last: true, removed: [],
                rows: workerData.duringMeetingMarket.map(row => [row[0], row]) }]);
            flowInvalidated = occupationPlanner.entry(Number(id), 'meeting')?.dirty === true;
        }
        return done;
    };
    Intent.meetingPurchase = (...args) => {
        const [network, intents, terms] = args;
        trace = { terms, activity: network.activity, moneyPrice: network.moneyPrice, intents,
            queue: network.queue.map(row => ({ key: row.key, price: row.price, valueHours: row.valueHours,
                ratio: row.ratio, funded: row.funded, object: row.object })) };
        return original(...args);
    };
    try {
        const prepared = await kernel.prepareMeeting(Number(id), request);
        return { request: prepared, frames: kernel.meetingResultPages(prepared, Number(id), request.token), trace,
            flowInjected, flowInvalidated, forbiddenLoaded: Object.keys(require.cache)
            .filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
    } catch (error) { error.meetingTrace = trace; throw error; }
    finally { Intent.meetingPurchase = original; occupationPlanner.step = originalStep; }
};
// The planner's answers per mode across main's resend of the same row and an ask of
// another mode: builds counted by mode, answers as values, each kept answer beside the
// first one on the same state.
module.exports.nativePlannerReuse = async (id, timestamp) => {
    const builds = {}, create = occupationPlanner.create;
    occupationPlanner.create = captured => { builds[captured.mode] = (builds[captured.mode] || 0) + 1; return create(captured); };
    const counted = () => ({ ...builds });
    const set = state => { kernel.states.set(id, { ...kernel.states.get(id), state }); return state; };
    const resend = (state, at) => set({ ...structuredClone(state), updatedAt: at, simulation: { revision: at },
        timing: { nextResolveAt: at + 60000 } });
    const plain = value => JSON.parse(JSON.stringify(value));
    const ask = async (state, at, mode) => plain(await occupationFor(state, at, {}, mode));
    try {
        const start = kernel.states.get(id).state;
        const out = { rows: await ask(start, timestamp, 'wish'),
            action: await ask(start, timestamp, 'showcase'), actionAgain: await ask(start, timestamp, 'showcase') };
        out.first = counted();
        const resent = resend(start, timestamp + 1000);
        out.keptRows = await ask(resent, timestamp + 1000, 'wish');
        out.keptAction = await ask(resent, timestamp, 'showcase');
        out.kept = counted();
        // A job in flight goes on across main's resend of the same row.
        const at = timestamp + 2000, current = resent;
        occupationPlanner.cancel(id, 'showcase');
        const before = counted().showcase || 0;
        const flying = occupationFor(current, at, {}, 'showcase');
        const echoed = resend(current, at + 1000);
        out.flown = plain(await flying);
        out.flight = (counted().showcase || 0) - before;
        out.echoed = await ask(echoed, at, 'showcase');
        // The route rows move with the bot's point.
        const walked = set({ ...echoed, activity: 'hunting', loc: { locX: 82000, locY: 148000, locZ: -3400 }, updatedAt: at + 2000 });
        const wishBefore = counted().wish || 0;
        out.walkedRows = await ask(walked, at + 2000, 'wish');
        out.walkedBuilt = (counted().wish || 0) - wishBefore;
        out.forbiddenLoaded = Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key));
        return out;
    } finally { occupationPlanner.create = create; }
};
module.exports.nativeEconomyDecision = async (id, timestamp, nativeRoutes = false) => {
    const state = kernel.states.get(Number(id)).state;
    const routeRows = nativeRoutes ? await occupationFor(state, timestamp, {}, 'wish') : undefined;
    const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { timestamp, ...(nativeRoutes ? { routeRows } : {}) });
    const decision = require('./ColdEconomyDecision').capture(economy, state);
    // Inputs from this worker's own native catalogue and price counters. A
    // test can sum E1 independently; no supplied packet or altered context.
    const reserveInputs = {
        stocks: ['shots', 'potions'].map(kind => {
            const stock = economy.stock(kind);
            return { selfId: stock.itemId, perHour: stock.usePerHour, refill: stock.refill,
                held: Number(state.inventory?.[stock.itemId]?.amount || 0), unitPrice: stock.survivalPrice };
        })
    };
    return { ...(nativeRoutes ? { watchList: economy.watchList } : {}),
        warehouseAssets: invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').inventory(state),
        decision: { ...decision }, activity: economy.network.activity, materials: decision.materials, statsPacket: economy.statsPacket, reserveInputs,
        tradeIntents: require('../Economy/TradeIntent').project(state, economy.network, economy.projection,
            id => economy.worth(id) ?? economy.price(id), 40),
        queue: economy.network.queue.map(row => ({ key: row.key, materials: row.object?.materials || [], price: row.price, ratio: row.ratio, valueHours: row.valueHours, funded: row.funded, cumulativePrice: row.cumulativePrice, object: row.object })),
        forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', async message => {
    if (!message.nativeEconomyDecision) return;
    try { parentPort.postMessage({ probeId: message.msgId,
        value: await loaded.exports[message.fundingReview ? 'nativeFundingReview' : message.plannerReuse ? 'nativePlannerReuse' : message.meetingRequest ? 'nativeMeetingPreparation' : message.marketPlan ? 'nativeMarketPlan' : message.townVisit ? 'nativeTownVisit' : message.recipeEarning ? 'nativeRecipeEarning' : 'nativeEconomyDecision'](message.characterId, message.timestamp, message.fundingReview || message.plannerReuse || message.meetingRequest || (message.recipeEarning ? message.stepEconomy : message.nativeRoutes)) }); }
    catch (error) { parentPort.postMessage({ probeId: message.msgId, error: error.stack, meetingTrace: error.meetingTrace }); }
});`;

// recipes: the bot's row of main's 'recipes' table ({ recipeBook, knownShotRecipes }), if any.
module.exports = async function workerEconomyDecision(state, { recipes = null, timestamp = Date.now(),
    boardRows = [], extraStates = [], tablePages = [], tables = [], recipeEarning = false, stepEconomy = false, nativeRoutes = false, marketPlan = false, marketWarm = null, fundingReview = null, townVisit = false, meetingRequest = null, duringMeetingMarket = [], plannerReuse = null } = {}) {
    const epoch = `native:economy-decision:${state.characterId}`;
    const messages = [];
    const worker = new Worker(wrapper, { eval: true, workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch, duringMeetingMarket, marketWarm,
        workerPath: path.join(root, 'src/GameServer/Bot/Population/ColdSimulationWorker.js'), observer } });
    let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => {
        const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) {
            if (fault) throw fault;
            const failure = messages.find(message => message.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure));
            if (Date.now() >= deadline) throw Error('native economy decision worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    };
    const send = (type, payload, id) => worker.postMessage(Protocol.envelope(type, epoch, payload, id));
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots',
            rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 },
            recomputeGeneration: invoke('GameServer/Bot/Population/RecomputeGeneration').metadata() }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        send('pause', {}, 'pause');
        // Pre-paged payloads take precedence; legacy full tables use the
        // native channel's bounded pagination. boardRows remains supported.
        const pages = tablePages.length ? tablePages : tables.length
            ? require('../../src/GameServer/Bot/Population/ColdTableChannel').shared.pages(tables).map(page => page.payload)
            : [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows: boardRows, removed: [], last: true }] }];
        for (const page of pages) send('table_page', page);
        if (recipes) send('table_page', { tables: [{ name: 'recipes', from: null, to: 0, full: true, removed: [], last: true,
            rows: [[Number(state.characterId), { characterId: Number(state.characterId), ...recipes }]] }] });
        send('snapshot_page', { rows: [{ state }, ...extraStates], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'native-economy'), nativeEconomyDecision: true,
            characterId: state.characterId, timestamp, recipeEarning, stepEconomy, nativeRoutes, marketPlan, fundingReview, townVisit, meetingRequest, plannerReuse });
        const response = await wait(message => message.probeId === 'native-economy');
        if (response.error) {
            const error = Error(response.error); error.meetingTrace = response.meetingTrace; throw error;
        }
        assert.deepEqual(response.value.forbiddenLoaded, [], 'native economy worker loads no World actor/network/database implementation');
        return response.value;
    } finally { await worker.terminate(); }
};
