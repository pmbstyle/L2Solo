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
        // It hunts on a camp of its level (its ground under it: with no earning answer its trip
        // keeps it there, asking nothing).
        const ground = planningSpots.find(spot => Number(spot.minLevel) <= 20 && Number(spot.maxLevel) >= 20) || planningSpots[0];
        const hunting = { ...entry.state, spotId: ground.id, loc: { ...ground.center } };
        kernel.states.set(id, { ...entry, state: hunting });
        const plan = await kernel.planLifecycle({ state: hunting, timestamp });
        const decided = builds;
        const state = plan.plannedState || hunting;
        const projection = await kernel.projectResolve(state, { patch: {}, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [{ selfId: 736, amount: 1 }] },
            nextResolveAt: timestamp + 60000 }, timestamp, plan);
        const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const afterRound = builds - decided;
        // The next rounds, from the projected state, on the same step decision: one ends
        // at the rest, then a trip arrives in town.
        const round = (from, patch, at) => kernel.projectResolve(from, { patch, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at, plan);
        const Situations = invoke('GameServer/Bot/Situations');
        // Its own lines are looked at only at their situations (own_lines): none of the
        // field rounds, once at the arrival in town, its bit cleared on the state committed.
        const looks = () => Situations.counts().decided.own_lines?.[0] || 0;
        const looked = looks();
        const rest = await round(projection.state, { activity: 'resting' }, timestamp + 1000);
        const back = await round(rest.state, { activity: 'hunting' }, timestamp + 1500);
        const fieldLooks = looks() - looked;
        const town = await round({ ...rest.state, activity: 'traveling' }, { activity: 'shopping' }, timestamp + 2000);
        const ownLines = [fieldLooks, looks() - looked - fieldLooks, Number(Situations.woken(town.state.stats, 'own_lines'))];
        const built = next => Number(Situations.woken(next.state.stats, 'build'));
        const raised = next => [built(next), Number(next.state.stats.decisionSeq || 0)];
        return { decided, afterRound, activity: state.activity, ownLines,
            woken: built(projection),
            seq: [Number(plan.statsPacket.decisionSeq || 0), Number(projection.state.stats.decisionSeq || 0)],
            rest: raised(rest), town: raised(town),
            selectedActivity: plan.economy.network.activity?.activity,
            selectedRoot: plan.economy.network.activity?.rootKey,
            execution: plan.economyPlan?.travel,
            baseline: [plan.statsPacket.wishSections?.at, projection.state.stats.wishSections?.at],
            // A round carries its step's plan (the taken build's, asked once before it); none asks another.
            buildPlan: !!plan.economyPlan,
            fieldPlans: [projection, rest, back].filter(next => next.economyPlan && next.economyPlan !== plan.economyPlan).length,
            card: { updatedAt: projection.economyDecision?.updatedAt, echo: projection.economyDecision?.echo,
                projectedAt: Number(projection.state.updatedAt || 0), projectedEcho: ColdEconomyDecision.stateEcho(projection.state) } };
    } finally { Economy.forState = original; }
};
// Quiet steps (no loot) leave the step decision held: the next decision
// point reuses it while no situation wakes the build. The first quiet round
// records the hunt cycle (an income event), so the second step is the warm one.
module.exports.heldProbe = async (id) => {
    const timestamp = Date.now();
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
        // A served step in the field asks no town route rows (only a build or a town visit reads them).
        const rowsAsk = occupationFor, wishAsks = [];
        occupationFor = (state, at, options, mode) => { if (mode === 'wish') wishAsks.push(state.activity); return rowsAsk(state, at, options, mode); };
        let same;
        try { same = await step(timestamp + 2000); } finally { occupationFor = rowsAsk; }
        const ask = () => ColdEconomyDecision.refusal(kernel.states.get(id).state, kernel.states.get(id).wishAdvisory,
            { timestamp: timestamp + 3000 });
        const held = ask();
        // The body goes near and far again with no decision of its own between: its far card serves.
        const far = kernel.states.get(id);
        kernel.states.set(id, { ...far, state: { ...far.state, phase: 'hot' } });
        kernel.states.set(id, { ...kernel.states.get(id), state: far.state });
        const handoff = ask();
        const later = await step(timestamp + 3000);
        // A build it takes while near (a situation on its post) is the card it carries back far.
        const posted = kernel.states.get(id), builtAt = state => state.stats?.wishSections?.at, farBuilt = builtAt(posted.state);
        const nearRow = { ...posted.state, phase: 'hot', updatedAt: Number(posted.state.updatedAt || 0) + 1, stats: { ...posted.state.stats },
            raise: { seq: 1, names: [{ name: 'goal_failed', payload: null, seq: 1 }] } };
        kernel.states.set(id, { ...posted, state: nearRow });
        for (const deadline = Date.now() + 30000; builtAt(kernel.states.get(id).state) === farBuilt && Date.now() < deadline;)
            await new Promise(resolve => setTimeout(resolve, 10));
        const near = kernel.states.get(id).state, nearBuilt = builtAt(near) !== farBuilt;
        kernel.states.set(id, { ...kernel.states.get(id), state: { ...near, phase: 'cold', raise: undefined,
            updatedAt: Number(near.updatedAt || 0) + 1, stats: { ...near.stats } } });
        const nearHandoff = ask();
        const unwoken = Object.keys(invoke('GameServer/Bot/Situations').counts().unwoken).filter(key => key.startsWith('build:'));
        const nearLater = await step(timestamp + 4000);
        return { same, wishAsks, held, handoff, later, unwoken, nearBuilt, nearHandoff, nearLater };
    } finally { Economy.forState = original; }
};
// A step whose commit has not landed: main sends the row of the decision the step's build
// replaced, one decisionSeq behind its card (a visit's write before the commit, a command
// answered without its decision; the build woken by a worker-local situation, a board wake
// or its leaf's outcome, so the row carries no raise). The card is still the answer to that
// row only while the commit it rides is in flight, or its command answered that it waits on
// a trade preparation; refused or dropped, the card goes. A waiting card serves the next
// step with no build, proposing its own decision again.
module.exports.pendingProbe = async id => {
    const card = kernel.states.get(id).wishAdvisory, row = kernel.states.get(id).state;
    const behind = { ...row, stats: { ...row.stats, decisionSeq: card.decisionSeq - 1 } };
    const commandId = 'lifecycle:probe:1';
    const publish = ride => {
        const record = kernel.states.get(id);
        record.wishAdvisory = card; record.cardCommit = ride;
        kernel.states.set(id, { ...record, state: behind });
        return kernel.states.get(id).wishAdvisory === card;
    };
    kernel.commandStartedAt.set(id, { kind: 'lifecycle', commandId });
    const inFlight = publish({ card, id: commandId });
    kernel.commandStartedAt.delete(id);
    const refused = publish({ card, id: commandId });
    const waiting = publish({ card, id: commandId, waiting: true });
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), original = Economy.forState;
    let builds = 0;
    Economy.forState = (...args) => { builds++; return original(...args); };
    try {
        const plan = await kernel.planLifecycle({ state: behind, timestamp: Date.now() + 10000 });
        return { echo: [behind.stats.decisionSeq, card.decisionSeq], inFlight, refused, waiting, builds,
            proposed: Number(plan.statsPacket?.decisionSeq || 0) };
    } finally { Economy.forState = original; kernel.states.set(id, { ...kernel.states.get(id), state: row }); }
};
// A far bot whose held card names no leaf (its decision completed: nothing left to carry
// out) serves it while no situation wakes its build. Its party progress request, closed by
// forming's no, is held there as on any served step; its next build asks again, its
// attempts kept. The fixture: the card's leaf completed, and a partner would bring the bot
// to its next level sooner on its earning ground.
module.exports.closedProbe = async (id) => {
    const saved = kernel.states.get(id), refresh = ColdEconomyDecision.refreshAdvisory;
    const Progress = invoke('GameServer/Bot/Population/PartyProgressComparison');
    const { partnerFor, compare } = Progress;
    const ground = planningSpots.find(spot => Number(spot.minLevel) <= 20 && Number(spot.maxLevel) >= 20) || planningSpots[0];
    ColdEconomyDecision.refreshAdvisory = (...args) => {
        const served = refresh(...args);
        if (served) served.economy.network.activity = null;
        return served;
    };
    Progress.partnerFor = () => ({ characterId: 0 });
    Progress.compare = () => ({ accept: true, reason: 'party' });
    try {
        const closed = { status: 'closed', priority: 'preferred', objectiveKey: 'spot:' + ground.id, reason: 'party_progress',
            spotId: ground.id, npcId: null, itemId: null, targetId: null, attempts: 2, requestedAt: 1, lastReason: 'forming_refused' };
        const earning = EquipmentIncomeRoute.answerOf({ spot: ground, row: { income: 100 }, earning: 100 }, 1);
        const step = async (woken, at) => {
            const base = saved.state, state = { ...base, phase: 'cold', activity: 'hunting', spotId: ground.id, loc: { ...ground.center },
                stats: { ...base.stats, woken, waiting: 0, earning, equipmentPlan: null, partyRequest: closed } };
            kernel.states.set(id, { ...saved, progressAsk: null, state });
            const plan = await kernel.planLifecycle({ state, timestamp: at });
            const projection = await kernel.projectResolve(plan.plannedState || state, { patch: {}, debug: {}, events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at, plan);
            const request = projection.state.stats.partyRequest || null;
            return { built: plan.buildTaken === true, leaf: plan.economy.network.activity?.activity ?? null, status: request?.status ?? null,
                reason: request?.reason ?? null, attempts: request?.attempts ?? null };
        };
        const at = Date.now() + 50000;
        const served = await step(0, at);
        const built = await step(Situations.BITS.build, at + 50000);
        return { served, built };
    } finally {
        ColdEconomyDecision.refreshAdvisory = refresh;
        Object.assign(Progress, { partnerFor, compare });
        kernel.states.set(id, saved);
    }
};
// A deferred plan's next page: main's write while pages wait asks it, once per
// state; the bot's own commit and a sent plan with nothing deferred ask none.
module.exports.pageProbe = async id => {
    const asked = () => !!occupationPlanner.entry(id, 'page');
    const record = economyPending => { const entry = kernel.states.get(id);
        return { ...entry, economyPending, state: { ...entry.state, phase: 'cold' } }; };
    const run = (pending, own) => {
        occupationPlanner.cancel(id);
        kernel.states.set(id, record(pending), own);
        const ran = asked();
        occupationPlanner.cancel(id);
        return ran;
    };
    return { own: run(1, 'commit'), main: run(1), none: run(0) };
};
// A party member's step (no decision before its round): a new expertise grade
// gained in its round moves its kit, which its party step reads to open a re-plan
// (at the party's rest: in its fight the kit waits); a quiet step moves nothing.
module.exports.kitProbe = async (id) => {
    const entry = kernel.states.get(id), timestamp = Date.now();
    const Data = invoke('GameServer/DataCache');
    {
        const step = (state, exp, at) => kernel.projectResolve(state, { patch: {}, debug: {}, events: [],
            materialize: { exp, sp: 0, adena: 0, items: [] }, nextResolveAt: at + 60000 }, at);
        // One level under C (40): the level it gains opens a grade.
        const member = { ...entry.state, level: 39, exp: Number(Data.experience[38]), activity: 'grouped',
            party: { partyId: 'kit-party', leaderId: id }, stats: { ...entry.state.stats, classProgressionLevel: 39 } };
        const first = await step(member, 0, timestamp);
        const quiet = await step(first.state, 0, timestamp + 1000);
        const gain = Number(Data.experience[quiet.state.level]) - Number(quiet.state.exp) + 1;
        // The grade comes in a party fight and waits there; the party's rest hears it
        // (its stop) and the member's build it wakes moves the kit.
        const levelUp = await step(quiet.state, gain, timestamp + 2000);
        const rested = await step({ ...levelUp.state, activity: 'resting' }, 0, timestamp + 3000);
        // Its earning spot woken (a death in the party's fight) is its party's to hold: no
        // build of the member's for it, step after step, until it hunts alone.
        const Situations = invoke('GameServer/Bot/Situations');
        const died = { ...rested.state, stats: { ...rested.state.stats, woken: Situations.BITS.earning_spot } };
        const after = await step(died, 0, timestamp + 4000);
        return { quiet: quiet.kitMoved, inFight: levelUp.kitMoved, levelUp: rested.kitMoved, levels: [quiet.state.level, levelUp.state.level],
            earningBuilds: after.build ? 1 : 0, classId: levelUp.state.stats.classId,
            trainingAsked: [levelUp.durable?.classId ?? null, rested.durable?.classId ?? null] };
    }
};
// A crafter's workshop decision: taken at a recipe learned, held across a step that
// moves only its wallet. With neither a known recipe book nor a listing it is not
// taken: the next step takes it.
module.exports.workshopProbe = async (id) => {
    const saved = kernel.states.get(id), service = CraftEligibility.isServiceCrafter;
    CraftEligibility.isServiceCrafter = () => true;
    try {
        const at = Date.now(), counts = [];
        const taken = () => Situations.counts().decided.workshop?.[0] || 0;
        const step = async (state, t) => {
            const before = taken();
            kernel.states.set(id, { ...saved, wishAdvisory: null, state });
            const plan = await kernel.planLifecycle({ state, timestamp: t });
            counts.push(taken() - before);
            return { ...plan.plannedState, stats: { ...plan.plannedState.stats, ...plan.statsPacket } };
        };
        const learned = state => ({ ...state, stats: Situations.raise({ ...state.stats }, 'recipe_learned', null, Situations.OPEN, id) });
        // An Artisan: only a class line that crafts hears the workshop.
        let state = await step(learned({ ...saved.state, stats: { ...saved.state.stats, classId: 56, workshop: undefined } }), at);
        state = await step({ ...state, stats: { ...state.stats, workshop: { entries: [] } } }, at + 500);
        state = await step({ ...state, adena: Number(state.adena) + 5000 }, at + 1000);
        await step(learned(state), at + 2000);
        return { counts };
    } finally { CraftEligibility.isServiceCrafter = service; kernel.states.set(id, saved); }
};
// Main's row with a step's packet applied over it, as BotLifeState.prepareResolve lands it
// (a round that raised nothing): its keys, and its bits as their change (Situations.landMind).
const mainRow = (row, plan) => {
    const { mind, ...keys } = plan.statsPacket;
    return Situations.landMind({ ...row.stats, ...keys }, mind, row.stats);
};
// A newbie's rebuff taken at a town arrival, on the step that takes the build the arrival
// woke: the guide answer reaches main in the step's packet (main applies the packet over
// its own row), held there until main's guide visit carries it out.
module.exports.rebuffProbe = async (id) => {
    const saved = kernel.states.get(id), guide = BotBuffs.GUIDES[0];
    try {
        const state = { ...saved.state, loc: { locX: guide.locX + 1000, locY: guide.locY, locZ: guide.locZ },
            stats: Situations.raise({ ...saved.state.stats }, 'arrived_town', null, Situations.OPEN, id) };
        // (No camp in this world takes its kit: its earning answer names none, and its ask for one
        // was answered so before, Situations.spotAsk: in town it asks no spot again.)
        kernel.states.set(id, { ...saved, wishAdvisory: null, spotAsk: { at: -1, none: true }, state });
        const plan = await kernel.planLifecycle({ state, timestamp: Date.now() });
        const main = mainRow(state, plan);
        return { built: plan.buildTaken === true, via: main.rebuff?.via ?? null, done: !!main.rebuff?.done,
            woken: [Situations.woken(main, 'rebuff'), Situations.woken(main, 'build')] };
    } finally { kernel.states.set(id, saved); }
};
// A far bot in town whose held earning answer names no spot (a save from before easier ground)
// asks the decision again from its trip, on the step that takes the build a situation woke: the
// ask's raise (spot_empty) reaches main with the step's packet, which main applies over the
// round's stats, so its next step searches the spot again instead of waiting forever.
module.exports.askProbe = async (id) => {
    const saved = kernel.states.get(id), guide = BotBuffs.GUIDES[0];
    const asks = () => Object.entries(Situations.counts().raised).filter(([key]) => key.startsWith('spot_empty@'))
        .reduce((sum, [, n]) => sum + n, 0);
    try {
        const none = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').answerOf(null, 1);
        const stats = Situations.raise({ ...saved.state.stats, woken: 0, waiting: 0, earning: none, equipmentPlan: null },
            'goal_failed', null, Situations.OPEN, id);
        const state = { ...saved.state, phase: 'cold', activity: 'hunting', spotId: null,
            loc: { locX: guide.locX + 1000, locY: guide.locY, locZ: guide.locZ }, stats };
        kernel.states.set(id, { ...saved, wishAdvisory: null, huntSpot: null, spotAsk: null, state });
        const before = asks();
        const plan = await kernel.planLifecycle({ state, timestamp: Date.now() });
        const main = mainRow(state, plan);
        return { built: plan.buildTaken === true, asked: asks() - before, woken: [Situations.woken(main, 'earning_spot'), Situations.woken(main, 'build')] };
    } finally { kernel.states.set(id, saved); }
};
// A far bot on its camp raised empty for it this stay (stats.emptyGround: the stay's spot_empty spent)
// whose held earning answer names no spot (a save from before easier ground): that ground holds no hunt,
// so its trip asks the decision again on the step that takes the build a situation woke; the ask reaches
// main with the step's packet, and the round on the same ground (no fight, the stay's raise spent) keeps it.
module.exports.emptyAskProbe = async (id) => {
    const saved = kernel.states.get(id);
    const asks = () => Object.entries(Situations.counts().raised).filter(([key]) => key.startsWith('spot_empty@'))
        .reduce((sum, [, n]) => sum + n, 0);
    try {
        const ground = planningSpots.find(spot => Number(spot.minLevel) <= 20 && Number(spot.maxLevel) >= 20) || planningSpots[0];
        const none = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').answerOf(null, 1);
        const base = { ...saved.state, phase: 'cold', activity: 'hunting', spotId: ground.id, loc: { ...ground.center } };
        const stats = Situations.raise({ ...saved.state.stats, woken: 0, waiting: 0, earning: none, equipmentPlan: null,
            emptyGround: String(ground.id) }, 'goal_failed', null, Situations.place(base), id);
        const state = { ...base, stats };
        kernel.states.set(id, { ...saved, wishAdvisory: null, huntSpot: null, spotAsk: null, state });
        const before = asks(), timestamp = Date.now();
        const plan = await kernel.planLifecycle({ state, timestamp });
        const main = mainRow(state, plan);
        const projection = await kernel.projectResolve(plan.plannedState || state, { patch: {}, debug: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 60000 }, timestamp, plan);
        return { built: plan.buildTaken === true, asked: asks() - before,
            woken: [Situations.woken(main, 'earning_spot'), Situations.woken(main, 'build')],
            kept: Situations.woken(projection.state.stats, 'earning_spot') };
    } finally { kernel.states.set(id, saved); }
};
// A far bot's trip ends on its spot on the step that takes the decisions a situation woke, its
// earning spot among them, and the units holding the spot turn it away (contest_lost, raised
// by its round after the decision): the state it commits keeps its earning spot woken and the
// spot marked, so its next step searches another camp instead of hunting where it was refused.
module.exports.arrivalProbe = async (id) => {
    const saved = kernel.states.get(id), contest = arrivalContest, Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const spot = planningSpots.find(row => Number(row.minLevel) <= 20 && Number(row.maxLevel) >= 20) || planningSpots[0];
    arrivalContest = ({ spotId }) => ({ action: 'avoid', reason: 'even', spotId: String(spotId) });
    try {
        const timestamp = Date.now() + 30000;
        const travel = { spotId: spot.id, reason: 'level_replan', to: { ...spot.center }, arrivalAt: timestamp };
        const stats = Situations.raise({ ...saved.state.stats, woken: 0, waiting: 0, travel }, 'party_left', null, Situations.OPEN, id);
        const state = { ...saved.state, phase: 'cold', activity: 'traveling', spotId: null, stats };
        kernel.states.set(id, { ...saved, wishAdvisory: null, state });
        const plan = await kernel.planLifecycle({ state, timestamp });
        // The round's arrival on the step's planned state (its patch: the whole stats copy, as a trip's end writes it).
        const planned = plan.plannedState || state, arriving = { ...planned, activity: 'traveling', stats: { ...planned.stats, travel } };
        const projection = await kernel.projectResolve(arriving, { patch: { activity: 'hunting', spotId: spot.id, stats: { ...arriving.stats } },
            debug: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 60000 }, timestamp, plan);
        return { built: plan.buildTaken === true, decided: !Situations.woken(planned.stats, 'earning_spot'),
            woken: Situations.woken(projection.state.stats, 'earning_spot'), marked: Risk.isMarked(projection.state.stats, spot.id) };
    } finally { arrivalContest = contest; kernel.states.set(id, saved); }
};
// A situation raised where the bot stands wakes the decisions that declare it, and its next
// decision point takes them: a far bot's step (raised at its place in the field), a near body's
// post (its bag heard where the body stands; one heard at a stop waits for its rest's end).
// Each case: the decisions it woke, those the decision point took (counted as taken, none
// unwoken), those still woken after, and the earning answer.
module.exports.cellsProbe = async (id) => {
    const saved = kernel.states.get(id), service = CraftEligibility.isServiceCrafter;
    CraftEligibility.isServiceCrafter = () => true;
    const names = Object.keys(Situations.BITS), wokenOf = stats => names.filter(d => Situations.woken(stats, d));
    const taken = d => Situations.counts().decided[d]?.[0] || 0;
    const unwoken = ds => Object.entries(Situations.counts().unwoken).filter(([key]) => ds.includes(key.split(':')[0]))
        .reduce((sum, [, n]) => sum + n, 0);
    const marked = String(saved.state.stats?.earning?.spotId ?? planningSpots[0].id);
    const commanded = String(planningSpots.find(spot => String(spot.id) !== marked).id);
    let at = Date.now() + 20000;
    const out = [];
    try {
        // An Artisan (a class line that crafts hears its workshop), its workshop held; its ask for a
        // spot answered before (no camp here takes its kit, Situations.spotAsk): a spot it is refused
        // leaves it asking nothing again.
        const start = saved.state;
        kernel.states.set(id, { ...saved, wishAdvisory: null, spotAsk: { at: -1, none: true }, state: { ...start, phase: 'cold', activity: 'hunting',
            stats: { ...start.stats, classId: 56, woken: (Number(start.stats.woken) || 0) & ~Situations.BITS.workshop } } });
        for (const [name, payload] of [['spot_unreachable', { spotId: marked, reason: 'route_unavailable' }],
            ['goal_affordable:potions'], ['karma_changed'], ['source_stalled'], ['player_command', { spotId: commanded, at }]]) {
            const base = kernel.states.get(id).state, state = { ...base, stats: { ...base.stats } };
            const before = wokenOf(state.stats);
            Situations.raise(state.stats, name, payload ?? null, Situations.place(state), id);
            const woke = wokenOf(state.stats).filter(d => !before.includes(d)), counts = woke.map(taken), u = unwoken(woke);
            kernel.states.set(id, { ...kernel.states.get(id), wishAdvisory: null, state });
            const plan = await kernel.planLifecycle({ state, timestamp: at += 1000 });
            const next = { ...(plan.plannedState || state), stats: { ...(plan.plannedState || state).stats, ...plan.statsPacket } };
            next.activity = 'hunting'; next.phase = 'cold';
            kernel.states.set(id, { ...kernel.states.get(id), wishAdvisory: null, state: next });
            out.push({ place: 'far', name, woke, taken: woke.filter((d, i) => taken(d) > counts[i]), left: woke.filter(d => Situations.woken(next.stats, d)),
                unwoken: unwoken(woke) - u, earning: next.stats.earning?.spotId ?? null });
        }
        let seq = 0;
        for (const [name, payload, stop] of [['party_left'], ['goal_affordable:potions'], ['karma_changed'], ['recipe_learned', null, 'rest'],
            ['source_stalled'], ['clan_call', null, 'rest'], ['clan_changed', null, 'rest'], ['player_command', { spotId: commanded, at }]]) {
            const entry = kernel.states.get(id), base = entry.state;
            seq = Math.max(seq, Number(entry.raiseSeq) || 0) + 1;
            const row = { ...base, phase: 'hot', activity: 'hunting', nearSeq: Number(base.nearSeq || 0) + 1,
                updatedAt: Number(base.updatedAt || 0) + 1, stats: { ...base.stats },
                raise: { seq, names: [{ name, payload: payload ?? null, seq }], impossible: false, ...(stop ? { stop } : {}) } };
            const before = wokenOf(base.stats);
            kernel.states.set(id, { ...entry, state: row });
            // Its bag was heard as the post landed; its decisions are taken on the planner's turn.
            const woke = wokenOf(row.stats).filter(d => !before.includes(d)), counts = woke.map(taken), u = unwoken(woke);
            // The body's answer: published on the record once its decisions are taken.
            for (const deadline = Date.now() + 30000; Date.now() < deadline
                && (kernel.states.get(id).state !== row || woke.some(d => Situations.woken(row.stats, d)));)
                await new Promise(resolve => setTimeout(resolve, 10));
            out.push({ place: 'near', name, woke, taken: woke.filter((d, i) => taken(d) > counts[i]),
                left: woke.filter(d => Situations.woken(row.stats, d)), unwoken: unwoken(woke) - u, earning: row.stats.earning?.spotId ?? null });
        }
        return { cells: out, marked, commanded };
    } finally { CraftEligibility.isServiceCrafter = service; kernel.states.set(id, saved); }
};
module.exports.occupationProbe = async (id) => {
    const saved = kernel.states.get(id), state = saved.state;
    kernel.states.set(id, { ...saved, wishAdvisory: null, route: null,
        state: { ...state, adena: 100000000, inventory: { ...state.inventory, 57: { selfId: 57, amount: 100000000 } },
            stats: { ...state.stats, wishFocus: null, activityLeaf: 0, equipmentPlan: null } } });
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
    const probe = ['stepProbe', 'pendingProbe', 'heldProbe', 'closedProbe', 'kitProbe', 'workshopProbe', 'rebuffProbe', 'askProbe', 'emptyAskProbe', 'arrivalProbe', 'occupationProbe', 'pageProbe', 'cellsProbe'].find(name => message[name]);
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
        assert.equal(step.buildPlan, true, 'a build taken in the field plans its market once');
        assert.equal(step.fieldPlans, 0, 'loot, a rest and its end ask no market plan in the field');
        // A looted Scroll of Escape is no supply event: the scroll has no line.
        assert.equal(step.woken, 0, 'on the hunt the round\'s loot wakes no build');
        assert.equal(step.seq[1], step.seq[0], 'and the decision sequence stands');
        assert.equal(step.rest[0], 0, 'nor does the round that ends at the rest');
        assert.equal(step.town[0], 1, 'the arrival in town wakes the build: its shopping moment (arrived_town)');
        assert.deepEqual(step.ownLines, [0, 1, 0], 'its own lines: no look in the field, one at the arrival in town, held after');
        assert.equal(step.baseline[1], step.baseline[0], 'the projected state keeps the baseline of the step decision');
        assert.equal(step.card.updatedAt, step.card.projectedAt, 'main gets the step card stamped to the projected state');
        assert.deepEqual(step.card.echo, step.card.projectedEcho, 'main gets the step card with the projected decision echo');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'held'), heldProbe: id });
        const heldResponse = await wait(message => message.probeId === 'held'); if (heldResponse.error) throw Error(heldResponse.error);
        const held = heldResponse.value;
        console.log(JSON.stringify(held));
        assert.equal(held.same, 0, 'a quiet step reuses the held decision');
        assert.deepEqual(held.wishAsks, [], 'and asks no town route rows in the field');
        assert.equal(held.held, '', 'the held decision holds on the warm state');
        assert.equal(held.handoff, '', 'a near body back far serves its far card: no build for the handoff');
        assert.equal(held.later, 0, 'with no situation the next decision point builds nothing');
        assert.deepEqual(held.unwoken, [], 'every build of the steps was woken by a situation (decided:build:unwoken 0)');
        assert.equal(held.nearBuilt, true, 'fixture: the body builds on a situation while near');
        assert.equal(held.nearHandoff, '', 'back far it serves the card of its near build');
        assert.equal(held.nearLater, 0, 'with no situation its first far step builds nothing');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'closed'), closedProbe: id });
        const closedResponse = await wait(message => message.probeId === 'closed'); if (closedResponse.error) throw Error(closedResponse.error);
        const closed = closedResponse.value;
        console.log(JSON.stringify(closed));
        assert.deepEqual([closed.served.built, closed.served.leaf], [false, null], 'fixture: an unwoken step serves the card with no leaf');
        assert.deepEqual([closed.served.status, closed.served.reason, closed.served.attempts], ['closed', 'party_progress', 2],
            'a served card holds the request forming closed, its attempts with it: no reopening between builds');
        assert.equal(closed.built.built, true, 'fixture: the woken build is taken');
        assert.deepEqual([closed.built.status, closed.built.reason, closed.built.attempts], ['open', 'party_progress', 2],
            'its next build asks again, its attempts kept');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'pending'), pendingProbe: id });
        const pendingResponse = await wait(message => message.probeId === 'pending'); if (pendingResponse.error) throw Error(pendingResponse.error);
        const pending = pendingResponse.value;
        console.log(JSON.stringify(pending));
        assert.equal(pending.inFlight, true, 'main\'s row sent before the step\'s commit lands keeps its card');
        assert.equal(pending.refused, false, 'a commit refused or dropped drops it: no card held past its commit');
        assert.equal(pending.waiting, true, 'a command answered that it waits on a trade preparation keeps it');
        assert.equal(pending.builds, 0, 'the next step serves the waiting card: no build');
        assert.equal(pending.proposed, pending.echo[1], 'and proposes the card\'s own decision again');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'kit'), kitProbe: id });
        const kitResponse = await wait(message => message.probeId === 'kit'); if (kitResponse.error) throw Error(kitResponse.error);
        const kit = kitResponse.value;
        console.log(JSON.stringify(kit));
        assert.equal(kit.levels[1], kit.levels[0] + 1, 'the fixture member levels up in its round');
        assert.equal(kit.quiet, false, 'a quiet party member step moves no kit');
        assert.equal(kit.inFight, false, 'a grade gained in a party fight waits for the party\'s rest');
        assert.equal(kit.levelUp, true, 'and is a kit event for the party step there');
        assert.equal(kit.earningBuilds, 0, 'a member\'s woken earning spot builds nothing: its party holds the spot');
        // The level crossed 40 in its round: the record takes the class only through main's
        // training, so each step after it asks for that training until it lands, not only
        // the step whose round gained the level (a hunt window's later rounds project on it).
        assert.deepEqual(kit.trainingAsked, [kit.classId, kit.classId], 'a projected class keeps naming main\'s training');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'workshop'), workshopProbe: id });
        const workshopResponse = await wait(message => message.probeId === 'workshop');
        if (workshopResponse.error) throw Error(workshopResponse.error);
        assert.deepEqual(workshopResponse.value.counts, [1, 0, 0, 1],
            'a crafter takes its workshop at a recipe learned (as none while main has not loaded its book: no later step '
            + 'takes it again), never for a listing or a wallet that moved');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'rebuff'), rebuffProbe: id });
        const rebuffResponse = await wait(message => message.probeId === 'rebuff');
        if (rebuffResponse.error) throw Error(rebuffResponse.error);
        assert.deepEqual(rebuffResponse.value, { built: true, via: 'guide', done: false, woken: [false, false] },
            'a newbie reaching a town with a guide holds the guide answer on main\'s row, taken with the build it woke');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'ask'), askProbe: id });
        const askResponse = await wait(message => message.probeId === 'ask');
        if (askResponse.error) throw Error(askResponse.error);
        assert.deepEqual(askResponse.value, { built: true, asked: 1, woken: [true, true] },
            'a bot whose answer names no spot asks again on its build\'s step, and main\'s row keeps the ask woken');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'emptyask'), emptyAskProbe: id });
        const emptyAskResponse = await wait(message => message.probeId === 'emptyask');
        if (emptyAskResponse.error) throw Error(emptyAskResponse.error);
        console.log(JSON.stringify(emptyAskResponse.value));
        assert.deepEqual(emptyAskResponse.value, { built: true, asked: 1, woken: [true, true], kept: true },
            'a bot on ground it raised empty whose answer names no spot asks again, and the round there keeps the ask');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'arrival'), arrivalProbe: id });
        const arrivalResponse = await wait(message => message.probeId === 'arrival');
        if (arrivalResponse.error) throw Error(arrivalResponse.error);
        assert.deepEqual(arrivalResponse.value, { built: true, decided: true, woken: true, marked: true },
            'a bot turned away at the spot it arrives at on the step that took its earning spot keeps that decision woken, the spot marked');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'page'), pageProbe: id });
        const pageResponse = await wait(message => message.probeId === 'page'); if (pageResponse.error) throw Error(pageResponse.error);
        assert.deepEqual(pageResponse.value, { own: false, main: true, none: false },
            'main\'s write pages a deferred plan; the own commit and a plan with nothing deferred do not');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'occupation'), occupationProbe: id });
        const occupationResponse = await wait(message => message.probeId === 'occupation');
        if (occupationResponse.error) throw Error(occupationResponse.error);
        const occupation = occupationResponse.value;
        console.log(JSON.stringify(occupation));
        assert.equal(occupation.activity, 'shopping', 'a funded native purchase is selected without a supplied leaf');
        assert.equal(occupation.execution, occupation.root, 'the selected purchase reaches native execution');
        assert.equal(occupation.resumedExecution, occupation.root, 'resuming a held decision still supplies its physical execution');
        assert.equal(occupation.route, null, 'the purchase cannot be replaced with an unrelated field trip');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'cells'), cellsProbe: id });
        const cellsResponse = await wait(message => message.probeId === 'cells');
        if (cellsResponse.error) throw Error(cellsResponse.error);
        const { cells, marked, commanded } = cellsResponse.value;
        console.log(JSON.stringify(cells));
        // The decisions each situation wakes (Situations.DECISIONS), far and near alike.
        const wakes = { spot_unreachable: ['earning_spot', 'build'], 'goal_affordable:potions': ['earning_spot', 'build'],
            karma_changed: ['earning_spot'], source_stalled: ['build', 'gear_plan'], player_command: ['build'], party_left: ['earning_spot', 'build'],
            recipe_learned: ['build', 'workshop'], clan_call: ['build'], clan_changed: ['build', 'gear_plan'] };
        assert.deepEqual(cells.map(cell => `${cell.place} ${cell.name}`), ['far spot_unreachable', 'far goal_affordable:potions', 'far karma_changed',
            'far source_stalled', 'far player_command', 'near party_left', 'near goal_affordable:potions', 'near karma_changed', 'near recipe_learned',
            'near source_stalled', 'near clan_call', 'near clan_changed', 'near player_command']);
        for (const cell of cells) {
            const what = `${cell.place} ${cell.name}`;
            assert(wakes[cell.name].every(decision => cell.woke.includes(decision)), `${what} wakes ${wakes[cell.name]} (woke ${cell.woke})`);
            assert.deepEqual(cell.taken, cell.woke, `${what}: its decision point takes every decision it woke`);
            assert.deepEqual(cell.left, [], `${what}: none is left woken`);
            assert.equal(cell.unwoken, 0, `${what}: none taken unwoken`);
        }
        for (const cell of cells.filter(cell => cell.name === 'spot_unreachable'))
            assert.notEqual(cell.earning, marked, `${cell.place}: the spot it could not reach is passed by`);
        for (const cell of cells.filter(cell => cell.name === 'player_command'))
            assert.equal(cell.earning, commanded, `${cell.place}: the commanded spot is the held answer the build hunts`);
        console.log('One economy decision per far solo step passed');
    } finally { await worker?.terminate(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
