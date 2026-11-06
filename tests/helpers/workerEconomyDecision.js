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
// stepEconomy: the ask a step makes after its own economy build (its action edges):
// with that build and the bot's shot stock.
module.exports.nativeRecipeEarning = async (id, timestamp, stepEconomy = false) => {
    const entry = kernel.states.get(Number(id));
    const economy = stepEconomy ? invoke('GameServer/Bot/Economy/EconomyContext').forState(entry.state, { timestamp }) : null;
    const result = await occupationFor(entry.state, timestamp, economy ? { stock: economy.stock('shots'), economy } : {}, 'action');
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
// The planner's answers per mode across main's resend of the same row, the
// moves a test names (moves: { name: fields set on the state, in order }) and an ask of
// another mode: builds counted by mode, answers as values, each kept or
// rebuilt answer beside a fresh build on the same state. A move's stats are
// merged into the state's (one field moves, the earlier moves stay).
module.exports.nativePlannerReuse = async (id, timestamp, moves = {}) => {
    const builds = {}, create = occupationPlanner.create;
    occupationPlanner.create = captured => { builds[captured.mode] = (builds[captured.mode] || 0) + 1; return create(captured); };
    const counted = () => ({ ...builds });
    const set = state => { kernel.states.set(id, { ...kernel.states.get(id), state }); return state; };
    const resend = (state, at) => set({ ...structuredClone(state), updatedAt: at, simulation: { revision: at },
        timing: { nextResolveAt: at + 60000 } });
    const plain = value => JSON.parse(JSON.stringify(value));
    const ask = async (state, at, mode = 'occupation') => plain(await occupationFor(state, at, {}, mode));
    const fresh = async (state, at, mode = 'occupation') => { occupationPlanner.cancel(id, mode); return ask(state, at, mode); };
    try {
        const start = kernel.states.get(id).state;
        const out = { workshop: await ask(start, timestamp), rows: await ask(start, timestamp, 'wish'),
            action: await ask(start, timestamp, 'action'), actionAgain: await ask(start, timestamp, 'action') };
        out.first = counted();
        const resent = resend(start, timestamp + 1000);
        out.keptWorkshop = await ask(resent, timestamp + 1000);
        out.keptRows = await ask(resent, timestamp + 1000, 'wish');
        out.keptAction = await ask(resent, timestamp, 'action');
        out.kept = counted();
        out.freshWorkshop = await fresh(resent, timestamp + 1000);
        out.moves = {};
        let at = timestamp + 2000, current = resent;
        for (const [name, patch] of Object.entries(moves)) {
            current = set({ ...current, ...patch, ...(patch.stats ? { stats: { ...current.stats, ...patch.stats } } : {}), updatedAt: at });
            const before = counted().occupation || 0;
            const answer = await ask(current, at);
            const built = (counted().occupation || 0) - before;
            out.moves[name] = { built, answer, fresh: await fresh(current, at) };
            at += 1000;
        }
        // A job in flight goes on across main's resend of the same row.
        occupationPlanner.cancel(id, 'occupation');
        const before = counted().occupation || 0;
        const flying = occupationFor(current, at, {}, 'occupation');
        const echoed = resend(current, at + 1000);
        out.flown = plain(await flying);
        out.flight = (counted().occupation || 0) - before;
        out.echoedWorkshop = await ask(echoed, at + 1000);
        out.afterEcho = (counted().occupation || 0) - before;
        // The route rows move with the bot's point.
        const walked = set({ ...echoed, activity: 'hunting', loc: { locX: 82000, locY: 148000, locZ: -3400 }, updatedAt: at + 2000 });
        const wishBefore = counted().wish || 0;
        out.walkedRows = await ask(walked, at + 2000, 'wish');
        out.walkedBuilt = (counted().wish || 0) - wishBefore;
        out.forbiddenLoaded = Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key));
        return out;
    } finally { occupationPlanner.create = create; }
};
// Whether a crafter's held card prepares its craft again at a new MP
// (refreshCraftPacket): pairs [preparedMp, mp], the action asks counted.
module.exports.nativeCraftMpRefresh = async (id, timestamp, pairs) => {
    const request = occupationPlanner.request, asks = [];
    occupationPlanner.request = function (key, input) { asks.push(input.mode); return Promise.resolve({}); };
    try {
        const state = kernel.states.get(id).state, out = [];
        for (const [preparedMp, mp] of pairs) {
            asks.length = 0;
            const refreshed = { advisory: { preparedMp }, economy: { stock: () => null } };
            const answer = await refreshCraftPacket({ ...state, vitals: { ...state.vitals, mp } }, timestamp, refreshed);
            out.push({ asked: [...asks], kept: answer === refreshed });
        }
        return { out, forbiddenLoaded: Object.keys(require.cache).filter(key => /\/(?:Database|Network)\/|\/src\/Database\.js$|\/World\/World\.js$|\/Bot\/BotManager\.js$/.test(key)) };
    } finally { occupationPlanner.request = request; }
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
        value: await loaded.exports[message.craftMp ? 'nativeCraftMpRefresh' : message.plannerReuse ? 'nativePlannerReuse' : message.meetingRequest ? 'nativeMeetingPreparation' : message.townVisit ? 'nativeTownVisit' : message.recipeEarning ? 'nativeRecipeEarning' : 'nativeEconomyDecision'](message.characterId, message.timestamp, message.craftMp || message.plannerReuse || message.meetingRequest || (message.recipeEarning ? message.stepEconomy : message.nativeRoutes)) }); }
    catch (error) { parentPort.postMessage({ probeId: message.msgId, error: error.stack, meetingTrace: error.meetingTrace }); }
});`;

// recipes: the bot's row of main's 'recipes' table ({ recipeBook, knownShotRecipes }), if any.
module.exports = async function workerEconomyDecision(state, { recipes = null, timestamp = Date.now(),
    boardRows = [], extraStates = [], tablePages = [], tables = [], recipeEarning = false, stepEconomy = false, nativeRoutes = false, townVisit = false, meetingRequest = null, duringMeetingMarket = [], plannerReuse = null, craftMp = null } = {}) {
    const epoch = `native:economy-decision:${state.characterId}`;
    const messages = [];
    const worker = new Worker(wrapper, { eval: true, workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch, duringMeetingMarket,
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
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
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
            characterId: state.characterId, timestamp, recipeEarning, stepEconomy, nativeRoutes, townVisit, meetingRequest, plannerReuse, craftMp });
        const response = await wait(message => message.probeId === 'native-economy');
        if (response.error) {
            const error = Error(response.error); error.meetingTrace = response.meetingTrace; throw error;
        }
        assert.deepEqual(response.value.forbiddenLoaded, [], 'native economy worker loads no World actor/network/database implementation');
        return response.value;
    } finally { await worker.terminate(); }
};
