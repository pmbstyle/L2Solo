'use strict';
// Read a saved world through a read-only connection; the actual cold worker
// projects its native lifecycle, then main freshly builds exactly that input.
// Usage: L2NODE_CONFIG_FILE=config/default.ini node scripts/economy-plan-parity.js <world-copy.sqlite> [300]
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const root = path.resolve(__dirname, '..'), workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare("SELECT * FROM bot_life_state WHERE phase='cold' AND activity='hunting' AND (partyId IS NULL OR partyId='') ORDER BY characterId LIMIT ?").all(Number(process.argv[3] || 300));
assert(rows.length >= 300, 'parity requires at least 300 native cold states');
const json = raw => JSON.parse(raw || '{}');
const states = rows.map(row => ({ characterId: row.characterId, name: row.characterName, level: row.level, exp: row.exp,
    sp: row.sp, adena: row.adena, phase: row.phase, activity: row.activity, currentRegion: row.currentRegion,
    spotId: row.spotId, updatedAt: row.updatedAt, loc: { locX: row.locX, locY: row.locY, locZ: row.locZ },
    vitals: { hp: row.hp, maxHp: row.maxHp, mp: row.mp, maxMp: row.maxMp },
    timing: { lastResolvedAt: row.lastResolvedAt, nextResolveAt: row.nextResolveAt },
    simulation: { ownerId: 'legacy_main', revision: row.simRevision || 0 },
    party: row.partyId ? { partyId: row.partyId } : null, stats: json(row.statsJson), inventory: json(row.inventorySummary) }));
db.close();
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure(), catalog = npcPlanningCatalogRows();
const board = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => spots);
invoke('GameServer/Bot/Economy/BotMarketPricing').useNpcOfferSnapshot(catalog);
Economy.configure({ board: () => board, spots: () => spots, memory: () => null });
const epoch = 'economy-plan-parity';
const observer = String.raw`
module.exports.decisionOracle = async ids => {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), original = Economy.forState;
    const result = [];
    const planner = require('./ColdEconomyPlan'), oldEdges = planner.edges, oldDecide = planner.decide;
    for (const id of ids) {
        const entry = kernel.states.get(id), state = entry.state, timestamp = Number(state.updatedAt || 1e12) + 1;
        let seen, built, addedMs = 0;
        planner.edges = (...args) => { const start = performance.now(); const value = oldEdges(...args); addedMs += performance.now() - start; return value; };
        planner.decide = (...args) => { const start = performance.now(); const value = oldDecide(...args); addedMs += performance.now() - start; return value; };
        Economy.forState = (value, deps) => { seen = structuredClone(value); built = original(value, deps); return built; };
        entry.context.goalReviewAt = timestamp;
        try {
            const start = performance.now();
            const projected = await kernel.projectResolve(state, { patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                debug: {}, events: [], nextResolveAt: timestamp + 60000 }, timestamp);
            result.push({ id, seen, state: projected.state, timestamp, plan: projected.economyPlan,
                edges: projected.economyEdges, addedMs, planMs: performance.now() - start });
        } finally { Economy.forState = original; planner.edges = oldEdges; planner.decide = oldDecide; }
    }
    return result;
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.decisionOracle) return;
    loaded.exports.decisionOracle(message.decisionOracle).then(value => parentPort.postMessage({ oracleId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ oracleId: message.msgId, error: error.stack }));
});`;
(async () => {
    const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, observer, workerEpoch: epoch, contractId: states[0].characterId } });
    const messages = []; let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) { if (fault) throw fault; const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected)); if (Date.now() > deadline) throw Error('native parity worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); } return messages.find(predicate); };
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    let sellEqual = 0, buyEqual = 0, planMs = [], addedMs = [], maxBytes = 0;
    const mismatches = [];
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots', rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        const contexts = new Map(states.map(state => [state.characterId, { workshop: state.stats?.workshop?.entries?.length
            ? Economy.craftIncome(state, { hourAdena: Economy.basics(state).hunt.perHour, worth: Economy.basics(state).price, timestamp: Number(state.updatedAt) + 1 }) : null }]));
        for (let at = 0; at < states.length; at += 4) send('snapshot_page', { rows: states.slice(at, at + 4)
            .map(state => ({ state, context: contexts.get(state.characterId) })), ack: true }, 'state-' + at);
        await wait(message => message.type === 'ready' && message.msgId === 'state-' + (Math.floor((states.length - 1) / 4) * 4));
        console.log('native states loaded', states.length);
        for (let at = 0; at < states.length; at += 20) {
            const msgId = 'oracle-' + at;
            worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, msgId), decisionOracle: states.slice(at, at + 20).map(state => state.characterId) });
            const response = await wait(message => message.oracleId === msgId); if (response.error) throw Error(response.error);
            for (const row of response.value) {
                assert(row.edges & 8, 'actual worker goal-due resolve produces a plan');
                assert(row.plan, 'native worker did not build a plan');
                const fresh = Economy.forState(row.seen, { timestamp: row.timestamp, board, spots, memory: null,
                    workshop: contexts.get(row.id).workshop, caller: 'plan-parity' });
                const options = { now: row.timestamp, economy: fresh, board, persona: fresh.persona,
                    npcOffersFor: selfId => catalog.filter(item => item.selfId === Number(selfId)),
                    findSpot: id => spots.find(spot => String(spot.id) === String(id)), slots: 8, stored: new Map() };
                // The old main pass's sale/bid functions on the identical bag
                // and mirrors. Warehouse stock is deliberately excluded here.
                const oldListings = invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(row.state, options).listings;
                const ctx = invoke('GameServer/Bot/Economy/MarketListingPolicy').traderContext(row.state, options);
                const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
                const townOptions = { tripCost: ctx.tripCost, timestamp: row.timestamp };
                const shopTown = row.state.stats?.shopTown?.town || Town.shopTown(row.state, oldListings.slice(0, 3), townOptions);
                const oldSell = oldListings.slice(0, 8).map((item, at) => [item.selfId, item.count, item.price,
                    at < 3 ? shopTown : Town.shopTown(row.state, [item], townOptions)]);
                const needs = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(row.state, { ...options, errand: null, saleTown: shopTown });
                const goal = needs[0];
                const funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
                const oldBuy = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyLines(row.state, goal, {
                    ...options, watchList: fresh.watchList, money: funding.spendable(row.state, 0,
                        goal?.plan?.valueRate === undefined ? { itemId: goal?.target?.itemId } : { r: goal.plan.valueRate }) })
                    .slice(0, 3).map(item => [item.selfId, item.count, item.price]);
                const checks = [JSON.stringify(row.plan.sell) === JSON.stringify(oldSell),
                    JSON.stringify(row.plan.buyAds) === JSON.stringify(oldBuy)];
                sellEqual += +checks[0]; buyEqual += +checks[1];
                maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(row.plan)));
                planMs.push(row.planMs); addedMs.push(row.addedMs);
                if (!checks.every(Boolean)) mismatches.push({ id: row.id, checks, worker: row.plan, oldSell, oldBuy });
            }
        }
        const p95 = rows => rows.sort((a, b) => a - b)[Math.floor(rows.length * .95)];
        console.log(JSON.stringify({ bots: states.length, sellEqual, buyEqual, maxPlanBytes: maxBytes,
            triggeredResolveP95Ms: p95(planMs), addedPlanP95Ms: p95(addedMs), mismatches: mismatches.slice(0, 10),
            inputs: 'native hunting solo states, native NPC/spot catalogs, same empty board/counters',
            warehouse: 'field warehouse rows are excluded; release now happens only on a town visit' }, null, 2));
        assert(sellEqual / states.length >= .95); assert(buyEqual / states.length >= .95);
        assert(maxBytes <= 614); assert(p95(addedMs) <= 5);
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
