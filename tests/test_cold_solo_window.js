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

const T = 1_750_000_000_000, FLUSH_MS = 100, HOLD_MS = 300000;
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
        stats: { ...worn.stats, stepCount: 0, wishDirty: 0, wishSections: { ...Sections.semanticFacts(worn), funding: 0 } }, ...overrides };
}

// The step's decision: hold the hunt, as a held card does. `plan` overrides it.
// on: true a window, false its shadow, null no window at all (the steps as they were).
function world({ on, plan = null, deadlineMs = HOLD_MS, planHolds = () => true, ground = spot, leaf = {}, stock = () => null, onRound = () => {} }) {
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
        soloWindow: on === null ? null : { on,
            projectRound: (state, result, timestamp, lifecyclePlan, writtenAt) => { onRound(kernel); return project(state, result, timestamp, writtenAt); },
            deadline: (state, timestamp) => timestamp + deadlineMs,
            readers: () => ({ edges: (before, after) => Plan.edges(before, after, { stockFor: (state, kind) => stock(kind) }),
                moneyBound: after => Sections.moneyBound(after, after.stats?.wishSections),
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
        const windowed = world({ on: true });
        windowed.kernel.upsert({ state: await hunter() });
        const { state: window, proposal } = await windowed.step();
        const rounds = roundsOf(window);
        assert(rounds >= 2, `a window of more than one round (${rounds})`);
        assert.equal(await windowed.step(window.timing.nextResolveAt - 6000), null, 'no step before the window\'s next due');
        // As the steps were, and in the shadow that counts beside them.
        for (const on of [null, false]) {
            const stepped = world({ on });
            stepped.kernel.upsert({ state: await hunter() });
            let row;
            for (let i = 0; i < rounds; i++) row = (await stepped.step()).state;
            assert(row.stats.fightsWon > 0, 'the bot fought');
            assert.deepStrictEqual(saved(window), saved(row), `one window equals its rounds as steps (on: ${on})`);
        }
        assert(window.timing.nextResolveAt > T + 30000 * (rounds - 1), 'the next due is past the rounds it holds');
        const hunts = proposal.result.events.filter(event => event.type === 'hunt').length;
        assert(hunts >= 2, `every round's hunt event rides the one commit (${hunts})`);
    }

    {
        // No event before the plan's deadline: the window stops at the round past it.
        const { kernel, step } = world({ on: true, deadlineMs: 60000 });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert(state.timing.nextResolveAt >= T + 60000, 'it runs up to the deadline');
        assert(state.timing.lastResolvedAt < T + 60000, 'its last round began before the deadline');
    }

    {
        // A rest ends the window at the round that sat down.
        const { kernel, step } = world({ on: true, deadlineMs: 1e7 });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(state.activity, 'resting', 'the fights wore the bot out');
        assert.equal(state.timing.nextResolveAt, state.stats.restUntil, 'the next due is the rest\'s end');
    }

    {
        // A level ends it at the round that reached it.
        const next = Number(Data.experience[18]);
        const { kernel, step } = world({ on: true, deadlineMs: 1e7, ground: earning });
        kernel.upsert({ state: await hunter({ exp: next - 1 }) });
        const { state } = await step();
        assert.equal(state.level, 19);
        assert.equal(roundsOf(state), 1, 'the round that reached it is the last');
    }

    {
        // The money bound: the first adena past the next wish's price ends it.
        const { kernel, step } = world({ on: true, deadlineMs: 1e7 });
        const bound = await hunter();
        bound.stats.wishSections = { ...bound.stats.wishSections, cashBounds: [-1, bound.adena + 1], wallet: bound.adena, moneyError: -1 };
        kernel.upsert({ state: bound });
        const { state } = await step();
        assert.equal(state.activity, 'hunting');
        assert.equal(roundsOf(state), 1, 'the round that paid it is the last');
    }

    {
        // Supplies: a stock passes the decision's keep (edges, either way).
        const { kernel, step } = world({ on: true, deadlineMs: 1e7, stock: kind => kind === 'shots' ? { itemId: 57, keep: 101 } : null });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert(state.adena >= 101, 'the stock passed its keep');
        assert.equal(roundsOf(state), 1, 'the round that passed the keep is the last');
    }

    {
        // A material hunt's order done: the held leaf fails its execution check
        // (LEAF_CHECKS), the window ends though no fact moved.
        const drop = 57;
        const { kernel, step } = world({ on: true, deadlineMs: 1e7, leaf: { itemId: drop, amount: 1 } });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert(state.adena > 100, 'the hunt brought its order');
        assert.equal(roundsOf(state), 1, 'the round that filled it is the last');
    }

    {
        // A native fact the plan reads failed: the window ends at that round.
        const { kernel, step } = world({ on: true, deadlineMs: 1e7, planHolds: () => false });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(roundsOf(state), 1);
    }

    {
        // A plan that acts keeps its one round.
        const { kernel, step } = world({ on: true, plan: (state, plan) => ({ ...plan, economyPlan: { take: [1] } }) });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(roundsOf(state), 1, 'an acting plan holds no window');
    }

    {
        // A step woken inside a window goes on from the bot's own clock, one
        // round, whoever moved lastResolvedAt: a command's or a hot session's
        // write leaves the window's end, the time is not hunted again.
        const { kernel, step } = world({ on: true, deadlineMs: 150000, ground: fieldOf(6) });
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
        const { clock, kernel } = world({ on: true, onRound: held => { if (++rounds === 2) fenced = held.fence(901); } });
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
