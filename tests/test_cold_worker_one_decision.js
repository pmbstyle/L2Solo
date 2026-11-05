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
// the bot did not carry (new loot and a supply event, which far from a player
// waits through the hunt and the rest for the bot's arrival in town).
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
        const afterRound = builds - decided;
        // The next rounds, from the projected state, on the same step decision: one ends
        // at the rest, then a trip arrives in town.
        const round = (from, patch, at) => kernel.projectResolve(from, { patch, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at, plan);
        const rest = await round(projection.state, { activity: 'resting' }, timestamp + 1000);
        // The rest ends with nothing moved since the step's action ask.
        const back = await round(rest.state, { activity: 'hunting' }, timestamp + 1500);
        const arrive = at => round({ ...rest.state, activity: 'traveling' }, { activity: 'shopping' }, at);
        const town = await arrive(timestamp + 2000);
        // Main drops that step: the same arrival asks again. Once main commits
        // a step that asked on it, the arrival asks nothing more.
        const again = await arrive(timestamp + 2500);
        const proposalId = id + ':edges-probe';
        kernel.inFlight.set(id, { state: kernel.states.get(id).state, startedAt: timestamp, pendingCommitId: proposalId,
            actionBaseline: again.actionBaseline });
        kernel.onCommitAck({ results: [{ ok: true, characterId: id, proposalId, state: kernel.states.get(id).state }] });
        const committed = await arrive(timestamp + 3000);
        const supply = invoke('GameServer/Bot/Economy/DecisionSections').sectionBit('supply');
        const raised = next => [Number(next.state.stats.wishDirty || 0) & supply, Number(next.state.stats.decisionSeq || 0)];
        return { decided, afterRound, activity: state.activity,
            wishDirty: Number(projection.state.stats.wishDirty || 0),
            seq: [Number(plan.statsPacket.decisionSeq || 0), Number(projection.state.stats.decisionSeq || 0)],
            rest: raised(rest), town: raised(town),
            selectedActivity: plan.economy.network.activity?.activity,
            selectedRoot: plan.economy.network.activity?.rootKey,
            execution: plan.economyPlan?.travel,
            baseline: [plan.statsPacket.wishSections?.at, projection.state.stats.wishSections?.at],
            edges: projection.economyEdges, laterEdges: [rest.economyEdges, back.economyEdges, town.economyEdges, again.economyEdges, committed.economyEdges],
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
// A kept card's craft refresh (a crafter's MP out of its band) asks the action
// before the round: the step's projection compares against that ask, so the
// band crossing asks once, though the last committed ask read another level.
// The probe stands in for the crafter's refresh (refreshCraftPacket) with a
// real action ask on the step's state.
module.exports.craftStepProbe = async (id) => {
    const timestamp = Date.now() + 10000, callers = [];
    const ask = askAction, refresh = refreshCraftPacket;
    askAction = (state, at, options) => { callers.push(options.caller); return ask(state, at, options); };
    refreshCraftPacket = async (state, at, refreshed) => refreshed && { ...refreshed,
        actionBaseline: (await askAction(state, at, { economy: refreshed.economy, caller: 'craft_mp' })).baseline };
    try {
        const record = kernel.states.get(id), state = record.state;
        record.actionBaseline = ColdEconomyPlan.actionBaseline({ ...state, level: Number(state.level) - 1 });
        const plan = await kernel.planLifecycle({ state, timestamp });
        const projection = await kernel.projectResolve(plan.plannedState || state, { patch: {}, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 60000 }, timestamp, plan);
        return { callers, edges: Number(projection.economyEdges || 0), carried: !!projection.actionBaseline };
    } finally { askAction = ask; refreshCraftPacket = refresh; }
};
// A refresh of a dirty bot waits for its step, whose build it would repeat, and
// runs on that step's output.
module.exports.refreshProbe = async id => {
    const asked = () => !!occupationPlanner.entry(id, 'refresh');
    const record = (stats, economyPending) => { const entry = kernel.states.get(id);
        return { ...entry, economyPending, state: { ...entry.state, phase: 'cold', stats: { ...entry.state.stats, ...stats } } }; };
    const run = (pending, ask) => {
        occupationPlanner.cancel(id);
        kernel.states.set(id, record({ wishDirty: 1 }, pending));
        ask?.();
        const waited = !asked();
        kernel.states.set(id, record({ wishDirty: 0 }, pending), 'commit');
        return { waited, ran: asked() };
    };
    // A plan that does not stand: the request leaves it to the step, which answers.
    const left = async () => {
        occupationPlanner.cancel(id);
        const worker = record({ wishDirty: 0 }, 0);
        kernel.states.set(id, { ...worker, state: { ...worker.state, activity: 'hunting', party: null, partyId: null } });
        EconomyContext.forget(id);
        const door = () => (EconomyContext.buildDoors().economy_refresh || [0, 0, 0]).slice();
        const before = door();
        occupationOwnerChanged(id, true);
        for (let tries = 0; tries < 500 && !kernel.states.get(id).refreshWaits; tries++) await new Promise(done => setTimeout(done, 10));
        const waited = kernel.states.get(id).refreshWaits === true && !asked();
        const after = door();
        const own = kernel.states.get(id);
        kernel.states.set(id, { ...own, state: { ...own.state } }, 'commit');
        const ran = asked();
        occupationPlanner.cancel(id);
        return { waited, ran, built: after[0] - before[0], left: after[2] - before[2] };
    };
    // Main's reconcile asks with no pending count.
    return { pending: run(1), reconcile: run(0, () => occupationOwnerChanged(id, true)), left: await left() };
};
// A party member's step (no decision before its round): a level gained in
// its round moves its kit, which its party step reads to open a re-plan (at
// the party's rest: in its fight the kit waits); a quiet step moves nothing.
// A member that is no crafter builds with no workshop and asks the
// occupation planner for none.
module.exports.kitProbe = async (id) => {
    const entry = kernel.states.get(id), timestamp = Date.now();
    const Data = invoke('GameServer/DataCache');
    const request = occupationPlanner.request;
    let workshopAsks = 0;
    occupationPlanner.request = function (key, input, ...rest) {
        if (input?.mode === 'occupation') workshopAsks++;
        return request.call(this, key, input, ...rest);
    };
    try {
        const step = (state, exp, at) => kernel.projectResolve(state, { patch: {}, debug: {}, events: [],
            materialize: { exp, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at);
        const member = { ...entry.state, activity: 'grouped', party: { partyId: 'kit-party', leaderId: id } };
        const first = await step(member, 0, timestamp);
        const quiet = await step(first.state, 0, timestamp + 1000);
        const gain = Number(Data.experience[quiet.state.level]) - Number(quiet.state.exp) + 1;
        const levelUp = await step({ ...quiet.state, activity: 'resting' }, gain, timestamp + 2000);
        return { quiet: quiet.kitMoved, levelUp: levelUp.kitMoved, levels: [quiet.state.level, levelUp.state.level],
            workshop: first.economy?.workshop || null, workshopAsks };
    } finally { occupationPlanner.request = request; }
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
    const probe = ['stepProbe', 'goalProbe', 'craftStepProbe', 'kitProbe', 'occupationProbe', 'refreshProbe'].find(name => message[name]);
    if (!probe) return;
    loaded.exports[probe](message[probe]).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;

// The after-round action ask reads the facts of the bot's last action ask
// (ColdEconomyPlan.edgesSince): with nothing moved, no ask; each moved fact
// names its bit.
{
    const Plan = invoke('GameServer/Bot/Population/ColdEconomyPlan');
    const Craft = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
    const asked = { characterId: 1, level: 30, activity: 'hunting', currentRegion: 'Giran', adena: 100, vitals: { mp: 300 },
        inventory: { 1864: { selfId: 1864, amount: 5 }, 1463: { selfId: 1463, amount: 100 } }, stats: { dwarvenCraftLevel: 4 } };
    const lines = [{ lineId: 7, fills: 1 }];
    const options = { stockFor: (_state, kind) => kind === 'shots' ? { itemId: 1463, keep: 50 } : null, ownLines: lines };
    const baseline = Plan.actionBaseline(asked, { ownLines: lines });
    const since = (patch, extra = {}) => Plan.edgesSince(baseline, { ...asked, ...patch }, { ...options, ...extra });
    assert.equal(Plan.edges({ ...asked, activity: 'resting' }, asked, options), 8, 'a round from rest to hunt is the round\'s edge');
    assert.equal(since({}), 0, 'nothing moved since the last action ask: no ask, though a rest ended');
    assert.equal(since({ activity: 'resting' }), 0, 'a rest asks nothing');
    assert.equal(since({ inventory: { ...asked.inventory, 1865: { selfId: 1865, amount: 1 } } }), 1, 'new loot');
    assert.equal(since({ inventory: { ...asked.inventory, 1463: { selfId: 1463, amount: 10 } } }), 2, 'a kit stock threshold');
    assert.equal(since({ inventory: { ...asked.inventory, 1463: { selfId: 1463, amount: 90 } } }), 0, 'a count inside it');
    assert.equal(since({ activity: 'shopping' }), 8, 'a shopping town reached');
    assert.equal(since({ level: 31 }), 16, 'a level');
    assert.equal(since({ activity: 'dead' }), 32, 'a death');
    const band = Craft.craftMpBand(4, 300), inside = 300 + 0.5, outside = band[3] ? band[2] + 1 : band[2];
    assert(Craft.sameCraftMp(4, 300, inside), 'fixture: an MP inside its band');
    assert.equal(since({ vitals: { mp: inside } }), 0, 'an MP inside the band of the craft checks');
    assert.equal(since({ vitals: { mp: outside } }), 64, 'the craft MP out of its band');
    assert.equal(since({ vitals: { mp: outside }, stats: { dwarvenCraftLevel: 0 } }), 0, 'a bot with no craft reads no MP');
    assert.equal(since({}, { ownLines: [{ lineId: 7, fills: 2 }] }), 128, 'a trade on an own line');
    assert.equal(since({}, { ownLines: [{ lineId: 7, fills: 1 }, { lineId: 8, fills: 0 }] }), 0, 'a line the bot posted');
    assert.equal(since({}, { ownLines: [{ lineId: 7, fills: 1 }, { lineId: 8, fills: 1 }] }), 128, 'a trade on a line posted since');
}

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
        assert.deepEqual(step.laterEdges.map(bits => bits & 9), [0, 0, 8, 8, 0],
            'a rest asks nothing, its end with nothing moved since the last action ask asks nothing, the arrival in town asks, '
            + 'again after main dropped that step, and not after main committed it');
        assert.equal(step.wishDirty, 0, 'on the hunt the round\'s supply event raises nothing');
        assert.equal(step.seq[1], step.seq[0], 'and the decision sequence stands');
        assert.equal(step.rest[0], 0, 'nor does the round that ends at the rest');
        assert(step.town[0] !== 0, 'the arrival in town raises it');
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
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'craft'), craftStepProbe: id });
        const craftResponse = await wait(message => message.probeId === 'craft'); if (craftResponse.error) throw Error(craftResponse.error);
        console.log(JSON.stringify(craftResponse.value));
        assert.deepEqual(craftResponse.value, { callers: ['craft_mp'], edges: 0, carried: true },
            'a kept card\'s craft refresh is the step\'s one action ask: the round compares against it, not the last commit');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'kit'), kitProbe: id });
        const kitResponse = await wait(message => message.probeId === 'kit'); if (kitResponse.error) throw Error(kitResponse.error);
        const kit = kitResponse.value;
        console.log(JSON.stringify(kit));
        assert.equal(kit.levels[1], kit.levels[0] + 1, 'the fixture member levels up in its round');
        assert.equal(kit.quiet, false, 'a quiet party member step moves no kit');
        assert.equal(kit.levelUp, true, 'a level gained in a party round is a kit event for the party step');
        assert.deepEqual(kit.workshop, { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0, feasibility: null },
            'a member that is no crafter builds with no workshop');
        assert.equal(kit.workshopAsks, 0, 'and asks the occupation planner for none');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'refresh'), refreshProbe: id });
        const refreshResponse = await wait(message => message.probeId === 'refresh'); if (refreshResponse.error) throw Error(refreshResponse.error);
        const moved = { waited: true, ran: true };
        assert.deepEqual(refreshResponse.value, { pending: moved, reconcile: moved, left: { ...moved, built: 0, left: 1 } },
            'a dirty bot refreshes after its step, not beside it, and no ask is lost');
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
