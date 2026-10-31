const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
Data.init();

// A far step starts early by its lead, the start -> commit ack time the
// kernel measured on its own acks, so its commit lands by the bot's due; the
// step is resolved as of the due, never earlier. The clock is stubbed; the
// committed row is the real projection (BotLifeState.prepareResolve) of the
// timestamp the step was resolved at.
const ROUND_MS = 30000;
// Bot 1 measures the lead round after round; the probed bots' next round
// lies past the test.
const PROBE_ROUND_MS = 10 * 3600 * 1000;
const FLUSH_MS = 100;

function soloState(characterId, nextResolveAt, overrides = {}) {
    return {
        characterId, phase: 'cold', activity: 'hunting', level: 35, exp: Number(Data.experience[34]) + 1000,
        sp: 0, adena: 0, inventory: {}, loc: {}, spotId: 'field',
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
        timing: { lastResolvedAt: nextResolveAt - ROUND_MS, nextResolveAt },
        stats: { classId: 1, classProgressionClassId: 1, classProgressionLevel: 35, deaths: 0 },
        simulation: { revision: 3 }, updatedAt: nextResolveAt - ROUND_MS,
        ...overrides
    };
}

function world() {
    const clock = { at: 0 };
    const resolvedAt = new Map(), proposals = new Map(), commands = [];
    const kernel = new ColdSimulationKernel({
        now: () => clock.at,
        flushTargetMs: FLUSH_MS,
        resolveSolo: ({ state, timestamp }) => {
            resolvedAt.set(Number(state.characterId), timestamp);
            const roundMs = Number(state.characterId) === 1 ? ROUND_MS : PROBE_ROUND_MS;
            return { patch: {}, events: [], nextResolveAt: timestamp + roundMs,
                materialize: { exp: 0, sp: 0, adena: 0, items: [] }, debug: {} };
        },
        projectResolve: (state, result, timestamp, lifecyclePlan, writtenAt) => Life.prepareResolve(state, result,
            { timestamp, writtenAt, persist: false, projectClassProgression: true }),
        emit: (type, payload) => {
            if (type === 'proposal_batch') for (const proposal of payload.proposals) proposals.set(proposal.characterId, proposal);
            if (type === 'command_request') commands.push(...payload.requests);
            return true;
        }
    });
    // Ticks at `at`: the bots whose step started there.
    const tickAt = async (at) => {
        clock.at = at;
        const before = new Set(kernel.inFlight.keys());
        kernel.tick();
        await kernel.resolveChain;
        return [...kernel.inFlight.keys()].filter(id => !before.has(id));
    };
    // The step's proposal leaves after the flush target; main commits it
    // `ackAfterMs` after the step's start and answers with the row it wrote.
    const commit = (id, ackAfterMs, startedAt, eventWaitMs) => {
        clock.at = startedAt + Math.max(FLUSH_MS, ackAfterMs);
        kernel.flushDue();
        const proposal = proposals.get(id);
        assert(proposal, 'the step sent its proposal');
        proposals.delete(id);
        const state = { ...proposal.nextState, simulation: { revision: proposal.revision + 1 } };
        kernel.onCommitAck({ results: [{ ok: true, characterId: id, proposalId: proposal.proposalId, state, eventWaitMs }] });
        return state;
    };
    // One round of bot `id` started at its due, committed `ackAfterMs` later.
    const round = async (id, ackAfterMs, eventWaitMs) => {
        const due = kernel.states.get(id).state.timing.nextResolveAt;
        assert.deepStrictEqual(await tickAt(due), [id]);
        return commit(id, ackAfterMs, due, eventWaitMs);
    };
    // A due between now and the measuring bot's next round.
    const gap = () => kernel.states.get(1).state.timing.nextResolveAt - 10000;
    return { clock, kernel, resolvedAt, commands, tickAt, commit, round, gap };
}

(async () => {
    {
        // No ack measured yet: the lead is 0 and a bot starts at its due, as before.
        const { kernel, resolvedAt, tickAt, commit } = world();
        const T = 100000;
        kernel.upsert({ state: soloState(1, T) });
        assert.deepStrictEqual(await tickAt(T - 1), [], 'without a measured lead nothing starts before its due');
        assert.deepStrictEqual(await tickAt(T), [1]);
        assert.strictEqual(resolvedAt.get(1), T);
        const row = commit(1, 1500, T);
        assert.strictEqual(row.timing.lastResolvedAt, T);
        assert.strictEqual(row.timing.nextResolveAt, T + ROUND_MS);
    }

    {
        // Slow commits (1.5 s from start to ack): the lead rises toward them,
        // so a bot due at T starts before T, never more than its slowest step
        // early, and its round is resolved and committed as of T.
        const { kernel, resolvedAt, tickAt, commit, round, gap } = world();
        kernel.upsert({ state: soloState(1, 10000) });
        for (let i = 0; i < 20; i++) await round(1, 1500);
        const T = gap();
        kernel.upsert({ state: soloState(2, T) });
        assert.deepStrictEqual(await tickAt(T - 1600), [], 'the lead never passes the slowest measured step');
        assert.deepStrictEqual(await tickAt(T - 1000), [2], 'after slow commits the step starts before its due');
        assert.strictEqual(resolvedAt.get(2), T, 'a step started early is resolved as of its due');
        const row = commit(2, 1500, T - 1000);
        assert.strictEqual(row.timing.lastResolvedAt, T, 'the committed row is stamped at the due, not at the early start');
        assert.strictEqual(row.timing.nextResolveAt, T + PROBE_ROUND_MS, 'the next round counts from the due');
        assert.strictEqual(row.updatedAt, T - 1000, 'the row write stamp is the real start, never the future due');
        assert.deepStrictEqual(await tickAt(T + 1), [], 'a step started early is not started again at its due');

        // A due read from a saved fraction: the step is stamped whole, so the
        // bot's clocks still pass the command checkpoint.
        const F = gap() + 0.5;
        kernel.upsert({ state: soloState(5, F) });
        assert.deepStrictEqual(await tickAt(F - 1000.5), [5], 'a fractional due starts on its lead');
        assert.strictEqual(resolvedAt.get(5), Math.ceil(F), 'the step time is whole milliseconds, never before the due');
        commit(5, 1500, F - 1000.5);

        // Fast commits afterwards: the lead falls back slowly, not at once.
        for (let i = 0; i < 3; i++) await round(1, FLUSH_MS);
        const U = gap();
        kernel.upsert({ state: soloState(3, U) });
        assert.deepStrictEqual(await tickAt(U - 1000), [3], 'a few fast commits do not drop the lead');
        commit(3, FLUSH_MS, U - 1000);
        for (let i = 0; i < 300; i++) await round(1, FLUSH_MS);
        const V = gap();
        kernel.upsert({ state: soloState(4, V) });
        assert.deepStrictEqual(await tickAt(V - 1000), [], 'many fast commits bring the lead down to them');
        assert.deepStrictEqual(await tickAt(V), [4]);
    }

    {
        // Main waits until the prepared round's events happen before writing
        // them. Repeated waits must not make later rounds start ever earlier;
        // the work before and after that wait still needs preparation time.
        const { kernel, resolvedAt, tickAt, commit, round, gap } = world();
        kernel.upsert({ state: soloState(1, 10000) });
        for (let i = 0; i < 20; i++) await round(1, 1500);
        for (let i = 0; i < 180; i++) {
            const due = kernel.states.get(1).state.timing.nextResolveAt;
            const startedAt = Math.ceil(kernel.nextWakeAt());
            assert.deepStrictEqual(await tickAt(startedAt), [1]);
            const queuedAt = startedAt + FLUSH_MS;
            const eventWaitMs = Math.max(0, due - queuedAt);
            const ackAt = Math.max(queuedAt, due) + FLUSH_MS;
            const row = commit(1, ackAt - startedAt, startedAt, eventWaitMs);
            assert.strictEqual(row.timing.lastResolvedAt, due, 'waiting to persist does not move the lived round');
        }
        const T = gap();
        kernel.upsert({ state: soloState(2, T) });
        assert.deepStrictEqual(await tickAt(T - 1000), [], 'waiting for events does not make later rounds start seconds early');
        assert.deepStrictEqual(await tickAt(T - 150), [2], 'the work outside the event wait still starts before the due');
        assert.strictEqual(resolvedAt.get(2), T);
    }

    {
        // Malformed wait metadata cannot erase measured preparation time.
        for (const eventWaitMs of [-1, NaN, Infinity, '1500', 1501]) {
            const { kernel, tickAt, round, gap } = world();
            kernel.upsert({ state: soloState(1, 10000) });
            for (let i = 0; i < 20; i++) await round(1, 1500, eventWaitMs);
            const T = gap();
            kernel.upsert({ state: soloState(2, T) });
            assert.deepStrictEqual(await tickAt(T - 1000), [2], 'invalid event waits cannot prevent timely preparation');
        }
    }

    {
        // A command is main's world action on main's clock: it starts at its
        // due even with a lead, and a step due behind it still starts early.
        const { kernel, commands, tickAt, round, gap } = world();
        kernel.upsert({ state: soloState(1, 10000) });
        for (let i = 0; i < 20; i++) await round(1, 1500);
        const T = gap();
        kernel.upsert({ state: soloState(5, T - 500, { activity: 'shopping' }) });
        kernel.upsert({ state: soloState(6, T) });
        assert.deepStrictEqual(await tickAt(T - 1000), [6], 'the step behind a waiting command starts early');
        assert.deepStrictEqual(commands.map(request => request.characterId), [], 'the command waits for its due');
        await tickAt(T - 500);
        assert.deepStrictEqual(commands.map(request => request.characterId), [5], 'the command starts at its due');
    }

    {
        // A retry held to its due sits at the heap's top: the worker still
        // wakes at the lead start of the round due behind it.
        const { clock, kernel, round, gap } = world();
        kernel.upsert({ state: soloState(1, 10000) });
        for (let i = 0; i < 20; i++) await round(1, 1500);
        const T = gap();
        kernel.upsert({ state: soloState(7, T) });
        kernel.upsert({ state: soloState(8, T + 60000) });
        kernel.requeue(8, T - 500);
        clock.at = T - 3000;
        assert(kernel.stepLeadMs > 1000, 'slow commits measured a lead');
        assert.strictEqual(kernel.nextWakeAt(), T - kernel.stepLeadMs, 'a retry at the top does not hide an earlier lead start');
    }

    console.log('Cold step lead: a step starts its measured lead early, is resolved and committed as of its due; its row keeps the real write stamp; a retry at the top does not hide a lead start; commands keep their due passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
