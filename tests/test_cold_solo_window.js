'use strict';
// T120: a hunting solo step runs on to its next event (ColdSoloWindow). The
// kernel, the fights (BackgroundResolver) and the projection
// (BotLifeState.prepareResolve) are the real ones; the clock and the step's
// decision are the edge.
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Plan = invoke('GameServer/Bot/Population/ColdEconomyPlan');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

const T = 1_750_000_000_000, FLUSH_MS = 100;
const fieldOf = level => {
    const npc = Data.npcs.find(entry => Number(entry.template?.level) === level && entry.template?.kind === 'Monster');
    return { id: 'field', name: 'Field', avgLevel: level, minLevel: level - 1, maxLevel: level + 1, density: 30, npcSelfIds: [npc.selfId],
        npcEntries: [{ selfId: npc.selfId, count: 30 }], center: { locX: 0, locY: 0, locZ: 0 },
        rewards: { exp: 40, sp: 4, adenaMin: 10, adenaMax: 20 } };
};
// A mob the bot wears down slowly, and one that gives it exp.
const spot = fieldOf(10), earning = fieldOf(15);

// A hunter whose decision read its present facts: its rounds raise only what they move.
async function hunter(overrides = {}) {
    const state = HuntCycle.referenceState(0, 18);
    const profile = Cold.profileFor(state, T, { store: false });
    const quiet = { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, debug: {}, nextResolveAt: T };
    const worn = await Life.prepareResolve({ ...state, characterId: 901, name: 'Windowed', exp: Number(Data.experience[17]) + 100, sp: 0,
        adena: 100, spotId: spot.id, loc: {}, vitals: { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp },
        timing: { lastResolvedAt: T - 60000, nextResolveAt: T },
        stats: { ...state.stats, classProgressionClassId: state.stats.classId, classProgressionLevel: 18, deaths: 0 },
        simulation: { revision: 1 }, updatedAt: T - 60000 }, quiet, { timestamp: T - 60000, persist: false, projectClassProgression: true });
    return { ...worn, timing: { lastResolvedAt: T - 60000, nextResolveAt: T },
        stats: { ...worn.stats, stepCount: 0, wishDirty: 0, woken: 0, wishSections: { ...Sections.semanticFacts(worn), funding: 0 } }, ...overrides };
}

// The step's decision: hold the hunt, as a held card does. `plan` overrides it.
// windowed: false, a kernel without the worker's window readers: a round a step.
// market: the worker's per-round read of the market watch, quiet by default.
function world({ windowed = true, plan = null, market = () => false, planHolds = () => true, ground = spot, leaf = {}, stock = () => null, onRound = () => {} }) {
    const clock = { at: 0 };
    const proposals = [];
    const activity = { activity: 'hunting', spotId: spot.id, ...leaf };
    const held = state => ({ economy: { network: { activity }, stock }, statsPacket: {}, plannedState: state,
        activityPick: { activity: 'hunting', spotId: spot.id, npcId: 0 } });
    const project = (state, result, timestamp, writtenAt) => Life.prepareResolve(state, result,
        { timestamp, writtenAt, persist: false, projectClassProgression: true, statsPacket: {}, statsPacketBeforeResolve: true });
    const kernel = new ColdSimulationKernel({
        now: () => clock.at, flushTargetMs: FLUSH_MS,
        resolveSolo: options => Resolver.resolveSolo(options),
        spotOf: () => ground,
        planLifecycle: ({ state }) => plan ? plan(state, held(state)) : held(state),
        projectResolve: (state, result, timestamp, lifecyclePlan, writtenAt) => project(state, result, timestamp, writtenAt),
        soloWindow: !windowed ? null : {
            projectRound: (state, result, timestamp, lifecyclePlan, writtenAt) => { onRound(kernel); return project(state, result, timestamp, writtenAt); },
            readers: () => ({ edges: (before, after) => Plan.edges(before, after, { stockFor: (state, kind) => stock(kind) }),
                moneyBound: after => Sections.moneyBound(after, after.stats?.wishSections), market,
                feasible: after => !Economy.leafCheck(after, activity, {}, { heldUnits: 0 }), planHolds }) },
        emit: (type, payload) => { if (type === 'proposal_batch') proposals.push(...payload.proposals); return true; }
    });
    // One step at the bot's due (or `at`): its committed row, null when none left.
    const step = async (at = kernel.states.get(901).state.timing.nextResolveAt) => {
        clock.at = at;
        kernel.tick();
        await kernel.resolveChain;
        clock.at = at + FLUSH_MS;
        kernel.flushDue();
        const proposal = proposals.shift();
        if (!proposal) return null;
        const state = { ...proposal.nextState, simulation: { revision: proposal.revision + 1 } };
        kernel.onCommitAck({ results: [{ ok: true, characterId: 901, proposalId: proposal.proposalId, state }] });
        return { state, proposal };
    };
    return { clock, kernel, step };
}

// The saved fields of a bot: only the write stamp and the credit mark differ by how a step ran.
const saved = state => {
    const row = { ...state, stats: { ...state.stats } };
    delete row.updatedAt;
    delete row.simulation;
    delete row.stats.huntedThrough;
    return row;
};
// The rounds a row has lived (the bot's step counter counts each from 0 here).
const roundsOf = state => state.stats.stepCount;

(async () => {
    {
        // The done_when: one window gives what today's steps give over the same
        // rounds, with the same seeds and no event between them, fight by fight.
        const windowed = world({});
        windowed.kernel.upsert({ state: await hunter() });
        const { state: window, proposal } = await windowed.step();
        const rounds = roundsOf(window);
        assert(rounds >= 2, `a window of more than one round (${rounds})`);
        assert.equal(await windowed.step(window.timing.nextResolveAt - 6000), null, 'no step before the window\'s next due');
        const stepped = world({ windowed: false });
        stepped.kernel.upsert({ state: await hunter() });
        let row;
        for (let i = 0; i < rounds; i++) row = (await stepped.step()).state;
        assert(row.stats.fightsWon > 0, 'the bot fought');
        assert.deepStrictEqual(saved(window), saved(row), 'one window equals its rounds as steps');
        assert(window.timing.nextResolveAt > T + 30000 * (rounds - 1), 'the next due is past the rounds it holds');
        const hunts = proposal.result.events.filter(event => event.type === 'hunt').length;
        assert(hunts >= 2, `every round's hunt event rides the one commit (${hunts})`);
    }

    {
        // No event within the look-ahead (ColdSimulationKernel WINDOW_LEAD_MS,
        // 300 s past the step's clock): the window stops at the round past it.
        const { kernel, step } = world({ ground: fieldOf(6) });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(state.activity, 'hunting', 'fixture: a quiet hunt');
        assert(state.timing.nextResolveAt >= T + 300000, 'it runs up to the look-ahead');
        assert(state.timing.lastResolvedAt < T + 300000, 'its last round began inside it');
        assert(state.stats.huntedThrough < T + 300000, 'its hunt is credited no further');
        assert.equal(kernel.soloWindowStats.ended.lead, 1, 'counted as lead');
    }

    {
        // The market watch crossed at a round (heard at work): the window ends there.
        const { kernel, step } = world({ market: after => roundsOf(after) >= 2, ground: fieldOf(6) });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(state.activity, 'hunting', 'fixture: the bot hunts on');
        assert.equal(roundsOf(state), 2, 'the round that saw it is the last');
        assert.equal(kernel.soloWindowStats.ended.market, 1, 'counted by its reason');
    }

    {
        // A rest ends the window at the round that sat down.
        const { kernel, step } = world({});
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(state.activity, 'resting', 'the fights wore the bot out');
        assert.equal(state.timing.nextResolveAt, state.stats.restUntil, 'the next due is the rest\'s end');
    }

    {
        // A level ends it at the round that reached it.
        const next = Number(Data.experience[18]);
        const { kernel, step } = world({ ground: earning });
        kernel.upsert({ state: await hunter({ exp: next - 1 }) });
        const { state } = await step();
        assert.equal(state.level, 19);
        assert.equal(roundsOf(state), 1, 'the round that reached it is the last');
    }

    {
        // The money bound: the first adena past the next wish's price ends it.
        const { kernel, step } = world({});
        const bound = await hunter();
        bound.stats.wishSections = { ...bound.stats.wishSections, cashBounds: [-1, bound.adena + 1], wallet: bound.adena, moneyError: -1 };
        kernel.upsert({ state: bound });
        const { state } = await step();
        assert.equal(state.activity, 'hunting');
        assert.equal(roundsOf(state), 1, 'the round that paid it is the last');
    }

    {
        // Supplies: a stock passes the decision's keep (edges, either way).
        const { kernel, step } = world({ stock: kind => kind === 'shots' ? { itemId: 57, keep: 101 } : null });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert(state.adena >= 101, 'the stock passed its keep');
        assert.equal(roundsOf(state), 1, 'the round that passed the keep is the last');
    }

    {
        // A material hunt's order done: the held leaf fails its execution check
        // (LEAF_CHECKS), the window ends though no fact moved.
        const drop = 57;
        const { kernel, step } = world({ leaf: { itemId: drop, amount: 1 } });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert(state.adena > 100, 'the hunt brought its order');
        assert.equal(roundsOf(state), 1, 'the round that filled it is the last');
    }

    {
        // A native fact the plan reads failed: the window ends at that round.
        const { kernel, step } = world({ planHolds: () => false });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(roundsOf(state), 1);
    }

    {
        // Ground the bot's kit no longer admits (its gear or level lost, a table
        // row moved): its round stands with nothing to fight, and though far at
        // work it raises its ground at once (occupation, sources: the next step's
        // decision searches its spot afresh); the window ends at that round. A
        // decision that keeps it there (no other ground) is not asked again by
        // every empty round of the stay.
        const occupation = Sections.sectionBit('occupation'), sources = Sections.sectionBit('sources');
        const Targets = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
        const strong = Data.npcs.find(entry => Number(entry.template?.level) === 45 && entry.template?.kind === 'Monster' && Targets.canHunt(entry));
        const beyond = { ...fieldOf(45), npcSelfIds: [strong.selfId], npcEntries: [{ selfId: strong.selfId, count: 30 }] };
        const { kernel, step } = world({ ground: beyond });
        const start = await hunter();
        kernel.upsert({ state: start });
        const { state } = await step();
        assert.equal(state.stats.lastReason, 'no_safe_solo_target', 'fixture: no spawn of the spot admits a fight');
        assert.equal(state.activity, 'hunting', 'the bot stands on the spot');
        assert.equal(state.stats.fightsResolved, start.stats.fightsResolved, 'no fight');
        assert.equal(Number(state.stats.wishDirty) & (occupation | sources), occupation | sources, 'the empty spot raises its ground');
        assert.equal(roundsOf(state), 1, 'the window ends at the first empty round');
        // The decision answered and kept it on the spot: the stay raises nothing more.
        kernel.upsert({ state: { ...state, stats: { ...state.stats, wishDirty: 0, woken: 0 }, simulation: { revision: 50 } } });
        const { state: stays } = await step();
        assert.equal(Number(stays.stats.wishDirty) || 0, 0, 'a later empty round of the stay raises nothing');
        assert.equal(stays.stats.decisionSeq, state.stats.decisionSeq);
    }

    {
        // A plan that acts keeps its one round.
        const { kernel, step } = world({ plan: (state, plan) => ({ ...plan, economyPlan: { take: [1] } }) });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(roundsOf(state), 1, 'an acting plan holds no window');
    }

    {
        // A step woken inside a window goes on from the bot's own clock, one
        // round, whoever moved lastResolvedAt: a command's or a hot session's
        // write leaves the window's end, the time is not hunted again.
        const { kernel, step } = world({ market: after => roundsOf(after) >= 3, ground: fieldOf(6) });
        kernel.upsert({ state: await hunter() });
        const { state: window } = await step();
        assert.equal(window.activity, 'hunting');
        const end = window.stats.huntedThrough;
        assert(end > T, 'the window credited ahead');
        const at = Math.ceil((T + end) / 2);
        let revision = 100;
        for (const lastResolvedAt of [window.timing.lastResolvedAt, at - 1000]) {
            kernel.upsert({ state: { ...window, timing: { lastResolvedAt, nextResolveAt: at }, simulation: { revision: revision += 10 } } });
            const { state: woken } = await step(at);
            assert.equal(woken.timing.lastResolvedAt, end, 'the bot\'s clock never runs back');
            assert.equal(roundsOf(woken), roundsOf(window) + 1, 'a wake earns one round, no window');
        }
    }

    {
        // A bot taken from the worker between two rounds of a window leaves no proposal.
        let rounds = 0, fenced = null;
        const { clock, kernel } = world({ onRound: held => { if (++rounds === 2) fenced = held.fence(901); } });
        kernel.upsert({ state: await hunter() });
        clock.at = T;
        kernel.tick();
        await kernel.resolveChain;
        assert.equal(rounds, 2, 'the window reached its second round');
        assert.equal(fenced.proposal, null);
        clock.at = T + FLUSH_MS;
        assert.equal(kernel.flushDue(), 0, 'the fenced step proposes nothing');
    }
    console.log('test_cold_solo_window ok');
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
