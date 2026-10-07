'use strict';
// Read-only saved-world comparison: native worker projections feed a clan's
// member numbers; the old full-context adapter and current aggregate see the
// same projected members, board, NPC/spot catalogs, personas and timestamp.
// Usage: L2NODE_CONFIG_FILE=config/default.ini node scripts/clan-numbers-parity.js <world-copy.sqlite>
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Context = invoke('GameServer/Clan/ClanEconomyContext');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const root = path.resolve(__dirname, '..'), workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js';
const db = new DatabaseSync(process.argv[2], { readOnly: true }), json = raw => JSON.parse(raw || '{}');
const clans = db.prepare("SELECT c.*,s.stateJson FROM clans c JOIN clan_simulation_clans s ON s.clanId=c.id WHERE s.mode='autonomous' ORDER BY c.id").all();
assert.ok(clans.length, 'a world with autonomous clans is required');
const membership = new Map(db.prepare('SELECT id,clanId,classId FROM characters WHERE clanId>0').all().map(row => [row.id,row]));
const personas = new Map(db.prepare('SELECT * FROM bot_personas').all().map(row => [row.characterId,
    { traits: json(row.traitsJson), primaryDrive: row.primaryDrive, archetype: row.archetype }]));
const rows = db.prepare('SELECT * FROM bot_life_state ORDER BY characterId').all().filter(row => membership.has(row.characterId));
const states = rows.map(row => ({ characterId: row.characterId, name: row.characterName, level: row.level, exp: row.exp,
    sp: row.sp, adena: row.adena, phase: row.phase, activity: row.activity, currentRegion: row.currentRegion,
    spotId: row.spotId, updatedAt: row.updatedAt, loc: { locX: row.locX, locY: row.locY, locZ: row.locZ },
    vitals: { hp: row.hp, maxHp: row.maxHp, mp: row.mp, maxMp: row.maxMp },
    timing: { lastResolvedAt: row.lastResolvedAt, nextResolveAt: row.nextResolveAt },
    simulation: { ownerId: 'legacy_main', revision: row.simulationRevision || 0 },
    party: row.partyId ? { partyId: row.partyId } : null, stats: { ...json(row.statsJson), clanId: membership.get(row.characterId).clanId },
    classId: membership.get(row.characterId).classId, inventory: json(row.inventorySummary), persona: personas.get(row.characterId) }));
assert.ok(states.length, 'native saved clan members are required');
const warehouse = db.prepare('SELECT * FROM clan_warehouse_items ORDER BY clanId,id').all();
const halls = db.prepare('SELECT * FROM clan_halls ORDER BY id').all().map(row => ({ ...row, functions: json(row.functionsJson) }));
db.close();
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure(), catalog = Coordinator.npcPlanningCatalogRows();
const board = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => spots);
invoke('GameServer/Bot/Economy/BotMarketPricing').useNpcOfferSnapshot(catalog);
Economy.configure({ board: () => board, spots: () => spots, memory: () => null });
const epoch = 'clan-numbers-parity', timestamp = Date.now();
const observer = String.raw`
module.exports.clanOracle = async ids => {
    const result = [];
    for (const id of ids) {
        const entry = kernel.states.get(id), state = entry.state;
        let built, seen;
        const projected = await LifeStateProjector.prepareResolve(state, { patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            debug: {}, events: [], nextResolveAt: workerData.timestamp + 60000 }, { persist: false, timestamp: workerData.timestamp,
            projectClassProgression: true, economyDeps: { board: boardIndex, spots: planningSpots, memory: null, workshop: entry.context.workshop },
            onEconomy: (context, input) => { built = context; seen = structuredClone(input); } });
        result.push({ id, projected, seen, decision: ColdEconomyDecision.capture(built, projected, seen) });
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
    if (!message.clanOracle) return;
    loaded.exports.clanOracle(message.clanOracle).then(value => parentPort.postMessage({ oracleId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ oracleId: message.msgId, error: error.stack }));
});`;
(async () => {
    const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, observer, workerEpoch: epoch, timestamp } });
    const messages = []; let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) { if (fault) throw fault; const rejected = messages.find(message => message.type === 'fault');
            if (rejected) throw Error(JSON.stringify(rejected)); if (Date.now() > deadline) throw Error('native clan parity worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); } return messages.find(predicate); };
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    const projected = new Map(), seenInputs = new Map(), contexts = new Map(), differences = [], actualNow = Date.now;
    let fallbackMembers = 0, elapsedOld = 0, elapsedNew = 0, valueAndBudgetEqual = 0, normalizedEqual = 0;
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers', rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots', rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        for (const state of states) {
            const basics = state.stats?.workshop?.entries?.length ? Economy.basics(state, { timestamp }) : null;
            contexts.set(state.characterId, { workshop: basics ? Economy.craftIncome(state, { hourAdena: basics.hunt.perHour, worth: basics.price, timestamp }) : null });
        }
        for (let at = 0; at < states.length; at += 4) send('snapshot_page', { rows: states.slice(at, at + 4).map(state => ({ state, context: contexts.get(state.characterId) })), ack: true }, 'state-' + at);
        await wait(message => message.type === 'ready' && message.msgId === 'state-' + (Math.floor((states.length - 1) / 4) * 4));
        for (let at = 0; at < states.length; at += 20) {
            const msgId = 'oracle-' + at;
            worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, msgId), clanOracle: states.slice(at, at + 20).map(state => state.characterId) });
            const response = await wait(message => message.oracleId === msgId); if (response.error) throw Error(response.error);
            for (const row of response.value) {
                const original = states.find(state => state.characterId === row.id), member = { ...row.projected, persona: original.persona, classId: original.classId };
                projected.set(row.id, member); seenInputs.set(row.id, row.seen);
                if (original.phase === 'cold') Coordinator.economyDecisions.accept(row.id, row.decision);
                else { fallbackMembers++; Coordinator.economyDecisions.forget(row.id); }
            }
        }
        Date.now = () => timestamp;
        const positive = value => Math.max(0, Number(value) || 0);
        const fallback = (member, id, basics, horizon) => {
            const item = require('../src/GameServer/Item/ItemTemplateIndex').find(Data.items, id);
            if (!item?.etc?.slot) return 0;
            const gain = require('../src/GameServer/Bot/Economy/WishProviders').gearGain(member, item);
            return Math.max(0, (gain.attack + gain.defence * basics.deathHours) * horizon);
        };
        const digest = context => ({ focus: context.network.focus, object: context.focusObject,
            queue: context.network.queue, income: context.incomePerHour, reserve: context.reserve, wallet: context.wallet });
        for (const source of clans) {
            const members = states.filter(state => membership.get(state.characterId).clanId === source.id).map(state => projected.get(state.characterId));
            const clan = { ...source, state: json(source.stateJson), members };
            const equipment = members.flatMap(member => member.stats?.equipmentPlan ? [{ memberId: member.characterId, plan: member.stats.equipmentPlan }] : []);
            const inputs = { warehouse: warehouse.filter(row => row.clanId === source.id), halls, equipment, proofOffer: null };
            let started = performance.now();
            const memberContexts = members.map(member => {
                const full = Economy.forState(seenInputs.get(member.characterId), { persona: member.persona, timestamp, workshop: contexts.get(member.characterId).workshop, caller: 'clan_parity' });
                const horizon = full.horizonHours ?? Valuation.stageHours(member, full.hunt.expPerHour, full.persona);
                return { ...full, clanHorizon: horizon, clanItemUsefulness: id => positive(full.itemUsefulness(id)) || fallback(member, id, full, horizon) };
            });
            const old = Context.build(clan, { ...inputs, memberContexts }); elapsedOld += performance.now() - started;
            started = performance.now(); const current = Context.forClan(clan, inputs); elapsedNew += performance.now() - started;
            const numericDigest = context => { const { focus, object, ...numbers } = digest(context); return numbers; };
            if (JSON.stringify(numericDigest(current)) === JSON.stringify(numericDigest(old))) valueAndBudgetEqual++;
            try { assert.deepEqual(digest(current), digest(old)); }
            catch (_) { differences.push({ clanId: source.id, members: members.length, old: digest(old), current: digest(current) }); }
            // This second oracle isolates values from the required key change.
            // It is NOT historical goal identity: group lotteries use the event key.
            const normalized = Context.build(clan, { ...inputs, memberContexts: memberContexts.map((context, index) => ({ ...context,
                inputKey: `${members[index].characterId}:${Coordinator.economyDecisions.clanNumbers(members[index].characterId)?.updatedAt ?? members[index].updatedAt ?? 0}` })) });
            assert.deepEqual(JSON.parse(current.inputKey)[4], JSON.parse(old.inputKey)[4],
                `complete selected clan nodes retain their values/paths for ${source.id}`);
            assert.equal(current.inputKey, normalized.inputKey, 'normalized oracle has exactly the same event key and node inputs');
            assert.deepEqual(digest(current), digest(normalized), `same-event-key value/goal parity for clan ${source.id}`);
            normalizedEqual++;
            const object = current.focusObject;
            if (object?.kind === 'equipment') {
                const beneficiary = members.find(member => member.characterId === object.memberId);
                assert.ok(beneficiary && Number(beneficiary.stats?.equipmentPlan?.target?.selfId) === object.itemId);
            } else if (object?.kind === 'hall') assert.ok(halls.some(hall => hall.id === object.hallId && !hall.ownerId));
            else if (object?.kind === 'level') assert.equal(object.level, Number(clan.level) + 1);
            assert.ok(current.network.queue.filter(wish => wish.funded).reduce((sum, wish) => sum + wish.price, 0)
                <= Math.max(0, current.wallet - current.reserve), 'funded clan queue stays inside its own purse');
        }
        console.log(JSON.stringify({ clans: clans.length, members: states.length, coldMembers: states.length - fallbackMembers,
            hotFallbackMembers: fallbackMembers, rawHistoricalEqual: clans.length - differences.length, rawDifferences: differences,
            valueAndBudgetEqual, normalizedSameEventKeyEqual: normalizedEqual,
            differenceCause: 'required member id:decision.updatedAt inputKey changes unchanged group lottery seed; normalized oracle isolates numerical parity, not historical goal identity',
            oldFullContextsMs: elapsedOld, decidedNumbersMs: elapsedNew,
            inputs: 'read-only native saved clan members; actual worker prepareResolve; identical projected clan members/personas/NPC/spot catalogs/timestamp; member full-context oracle rebuilt on exact worker seen input before packet/normalization tail; same empty board mirrors' }, null, 2));
        assert.equal(valueAndBudgetEqual, clans.length, 'complete clan queues, prices and budgets differ');
        assert.equal(normalizedEqual, clans.length);
    } finally { Date.now = actualNow; await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
