// A far solo bot's step decides once, before its round (ARCH-04): the round's
// own consequences run on that decision; the event its round raised waits
// for the next step's decision point instead of a rebuild after the round.
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('worker-one-decision');
const path = require('node:path');
const fs = require('node:fs');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
fixture.assertConfigured(options.default);
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
process.env.BOT_STATIC_SHOTS_DISABLED = 'true';
const Database = invoke('Database'), DataCache = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const root = path.resolve(__dirname, '..');

async function createWorld(id) {
    useRate('x1');
    DataCache.init();
    fixture.assertConfigured(options.default);
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('quests','test')");
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'quests','OneDecision',0,0,20,0,0,187,74,187,74,0,0,0,0,0,0,0,-1,0)`).run(id);
    seed.close();
    fixture.assertConfigured(options.default);
    await Database.init();
    return { async close() { await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); } };
}

// Runs inside the worker: the kernel's own decision point and projection, in
// the order a solo step runs them, with a round that looted an escape scroll
// the bot did not carry (new loot and a supply event).
const observer = String.raw`
module.exports.stepProbe = async (id) => {
    const entry = kernel.states.get(id), timestamp = Date.now();
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), original = Economy.forState;
    let builds = 0;
    Economy.forState = (...args) => { builds++; return original(...args); };
    try {
        const plan = await kernel.planLifecycle({ state: entry.state, timestamp });
        const decided = builds;
        const state = plan.plannedState || entry.state;
        const projection = await kernel.projectResolve(state, { patch: {}, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [{ selfId: 736, amount: 1 }] },
            nextResolveAt: timestamp + 60000 }, timestamp, plan);
        const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        return { decided, afterRound: builds - decided, activity: state.activity,
            selectedActivity: plan.economy.network.activity?.activity,
            selectedRoot: plan.economy.network.activity?.rootKey,
            execution: plan.economyPlan?.travel,
            wishDirty: Number(projection.state.stats.wishDirty || 0),
            seq: [Number(plan.statsPacket.decisionSeq || 0), Number(projection.state.stats.decisionSeq || 0)],
            baseline: [plan.statsPacket.wishSections?.at, projection.state.stats.wishSections?.at],
            edges: projection.economyEdges,
            card: { updatedAt: projection.economyDecision?.updatedAt, echo: projection.economyDecision?.echo,
                projectedAt: Number(projection.state.updatedAt || 0), projectedEcho: ColdEconomyDecision.stateEcho(projection.state) } };
    } finally { Economy.forState = original; }
};
// Quiet steps (no loot) leave the step decision held: the next decision
// point reuses it while the goal revision holds and rebuilds once it moves.
// The first quiet round records the hunt cycle (an income event), so the
// second step is the warm one.
module.exports.goalProbe = async (id) => {
    const timestamp = Date.now();
    // The goal revision is the worker's 'goals' table row, as main publishes it.
    const goal = revision => ({ characterId: id, nextReviewAt: 0, revision });
    tables.apply([{ name: 'goals', from: null, to: 0, full: true, rows: [[id, goal(1)]], removed: [], last: true }]);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), original = Economy.forState;
    const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
    let builds = 0;
    Economy.forState = (...args) => { builds++; return original(...args); };
    const step = async at => {
        const before = builds, state = kernel.states.get(id).state;
        const plan = await kernel.planLifecycle({ state, timestamp: at });
        const projection = await kernel.projectResolve(plan.plannedState || state, { patch: {}, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at, plan);
        // The step's own record write: the record keeps its fields (the card).
        kernel.states.set(id, { ...kernel.states.get(id), state: projection.state });
        return builds - before;
    };
    try {
        await step(timestamp); await step(timestamp + 1000);
        const same = await step(timestamp + 2000);
        const ask = () => ColdEconomyDecision.refusal(kernel.states.get(id).state, kernel.states.get(id).wishAdvisory,
            { goalRevision: goalRevision(id), timestamp: timestamp + 3000 });
        const held = ask();
        tables.apply([{ name: 'goals', from: 0, to: 1, full: false, rows: [[id, goal(2)]], removed: [], last: true }]);
        const refusal = ask();
        const moved = await step(timestamp + 3000);
        return { same, held, refusal, moved };
    } finally { Economy.forState = original; }
};
// A party member's step (no decision before its round): a level gained in
// its round moves its kit, which its party step reads to open a re-plan; a
// quiet step moves nothing.
module.exports.kitProbe = async (id) => {
    const entry = kernel.states.get(id), timestamp = Date.now();
    const Data = invoke('GameServer/DataCache');
    const step = (state, exp, at) => kernel.projectResolve(state, { patch: {}, debug: {}, events: [],
        materialize: { exp, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at);
    const member = { ...entry.state, activity: 'grouped', party: { partyId: 'kit-party', leaderId: id } };
    const first = await step(member, 0, timestamp);
    const quiet = await step(first.state, 0, timestamp + 1000);
    const gain = Number(Data.experience[quiet.state.level]) - Number(quiet.state.exp) + 1;
    const levelUp = await step(quiet.state, gain, timestamp + 2000);
    return { quiet: quiet.kitMoved, levelUp: levelUp.kitMoved, levels: [quiet.state.level, levelUp.state.level] };
};
module.exports.occupationProbe = async (id) => {
    const saved = kernel.states.get(id), state = saved.state;
    kernel.states.set(id, { ...saved, wishAdvisory: null, route: null,
        state: { ...state, adena: 100000000, inventory: { ...state.inventory, 57: { selfId: 57, amount: 100000000 } },
            stats: { ...state.stats, wishFocus: null, activityLeaf: 0, wishDirty: 1, equipmentPlan: null } } });
    try {
        const plan = await kernel.planLifecycle({ state: kernel.states.get(id).state, timestamp: Date.now() });
        const entry = kernel.states.get(id);
        entry.state = { ...plan.plannedState, stats: { ...plan.plannedState.stats, ...plan.statsPacket } };
        const resumed = await kernel.planLifecycle({ state: entry.state, timestamp: Date.now() + 1 });
        return { activity: plan.economy.network.activity?.activity, root: plan.economy.network.activity?.rootKey,
            execution: plan.economyPlan?.travel, resumedExecution: resumed.economyPlan?.travel, route: plan.route?.spotId || null };
    } finally { kernel.states.set(id, saved); }
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    const probe = ['stepProbe', 'goalProbe', 'kitProbe', 'occupationProbe'].find(name => message[name]);
    if (!probe) return;
    loaded.exports[probe](message[probe]).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;

(async () => {
    const id = 710031;
    const world = await createWorld(id);
    let worker;
    try {
        await Life.init();
        await Database.createAccount('bot_one_decision', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_one_decision', id]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 20000 });
        const now = Date.now();
        let state = await Life.upsertState({ characterId: id, name: 'OneDecision', accountName: 'bot_one_decision',
            level: 20, exp: Number(DataCache.experience[19]), phase: 'cold', activity: 'hunting', currentRegion: 'Gludio',
            adena: 20000, sp: 0, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            loc: { locX: -12672, locY: 122776, locZ: -3116 }, vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
            stats: { classId: 0, classProgressionClassId: 0, classProgressionLevel: 20, generatedCold: true },
            timing: { lastResolvedAt: now - 10000, nextResolveAt: now + 60000 } }, 'one_decision_fixture');
        const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
        for (let i = 0; i < 3; i++) state = { ...state, stats: { ...state.stats,
            huntEfficiency: Hunt.record(state, { spotId: 'one_decision_hunt', cycleMs: 60000,
                adena: 100, exp: 10, kills: 1, timestamp: now }) } };
        state = await Life.upsertState(state, 'one_decision_income');
        const epoch = 'native:one-decision', messages = []; let fault;
        worker = new Worker(wrapper, { eval: true, workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch,
            workerPath: root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js', observer } });
        worker.on('message', message => messages.push(message));
        worker.on('error', error => { fault = error; });
        const wait = async predicate => { const deadline = Date.now() + 60000;
            while (!messages.some(predicate)) { if (fault) throw fault;
                const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected));
                if (Date.now() > deadline) throw Error('one decision worker timeout');
                await new Promise(resolve => setTimeout(resolve, 10)); } return messages.find(predicate); };
        const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots', rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 }, recomputeGeneration: { code: 'a'.repeat(40), config: 'b'.repeat(64) } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'personal_warehouse', from: null, to: 0, full: true, rows: [], removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), stepProbe: id });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        const step = response.value;
        console.log(JSON.stringify(step));
        assert.equal(step.activity, 'hunting', 'the fixture bot hunts this step');
        assert.equal(step.decided, 1, 'a bot without a held decision builds its economy once, before the round');
        assert.equal(step.afterRound, 0, 'the projection after the round builds no economy');
        assert(step.edges & 1, 'the looted scroll is an edge the round acts on with the step decision');
        assert.notEqual(step.wishDirty, 0, 'the supply event of the round waits for the next decision point');
        assert(step.seq[1] > step.seq[0], 'the event check after the round moves the decision sequence');
        assert.equal(step.baseline[1], step.baseline[0], 'the projected state keeps the baseline of the step decision');
        assert.equal(step.card.updatedAt, step.card.projectedAt, 'main gets the step card stamped to the projected state');
        assert.deepEqual(step.card.echo, step.card.projectedEcho, 'main gets the step card with the projected decision echo');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'goal'), goalProbe: id });
        const goalResponse = await wait(message => message.probeId === 'goal'); if (goalResponse.error) throw Error(goalResponse.error);
        const goal = goalResponse.value;
        console.log(JSON.stringify(goal));
        assert.equal(goal.same, 0, 'a quiet step reuses the held decision while the goal revision holds');
        assert.equal(goal.held, '', 'the held decision holds on the warm state at the same goal revision');
        assert.equal(goal.refusal, 'goal', 'a moved goal revision refuses the held decision');
        assert.equal(goal.moved, 1, 'the next decision point after a goal change builds once');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'kit'), kitProbe: id });
        const kitResponse = await wait(message => message.probeId === 'kit'); if (kitResponse.error) throw Error(kitResponse.error);
        const kit = kitResponse.value;
        console.log(JSON.stringify(kit));
        assert.equal(kit.levels[1], kit.levels[0] + 1, 'the fixture member levels up in its round');
        assert.equal(kit.quiet, false, 'a quiet party member step moves no kit');
        assert.equal(kit.levelUp, true, 'a level gained in a party round is a kit event for the party step');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'occupation'), occupationProbe: id });
        const occupationResponse = await wait(message => message.probeId === 'occupation');
        if (occupationResponse.error) throw Error(occupationResponse.error);
        const occupation = occupationResponse.value;
        console.log(JSON.stringify(occupation));
        assert.equal(occupation.activity, 'shopping', 'a funded native purchase is selected without a supplied leaf');
        assert.equal(occupation.execution, occupation.root, 'the selected purchase reaches native execution');
        assert.equal(occupation.resumedExecution, occupation.root, 'resuming a held decision still supplies its physical execution');
        assert.equal(occupation.route, null, 'the purchase cannot be replaced with an unrelated field trip');
        console.log('One economy decision per far solo step passed');
    } finally { await worker?.terminate(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
