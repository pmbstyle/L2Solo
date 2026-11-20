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
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

const T = 1_750_000_000_000, FLUSH_MS = 100;
const fieldOf = level => {
    const npc = Data.npcs.find(entry => Number(entry.template?.level) === level && entry.template?.kind === 'Monster'
        && invoke('GameServer/Bot/AI/BotHuntingTargetPolicy').canHunt(entry)
        && Data.npcRewards.find(reward => reward.selfId === entry.selfId)?.rewards
            .some(group => group.items.some(item => item.selfId === 57)));
    assert(npc, 'the window fixture needs a huntable NPC with authored Adena drops');
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
        stats: { ...worn.stats, stepCount: 0, woken: 0, equipmentPlan: null, earning: { spotId: spot.id }, wishSections: { ...Sections.semanticFacts(worn), funding: 0 } }, ...overrides };
}

// The step's decision: hold the hunt, as a held card does. `plan` overrides it.
// windowed: false, a kernel without the worker's window readers: a round a step.
// ends: a round that ends the window as its held leaf's check would (none by default).
function world({ windowed = true, plan = null, ends = () => false, ground = spot, leaf = {}, stock = () => null, onRound = () => {}, onSolo = () => {} }) {
    const clock = { at: 0 };
    const proposals = [];
    const activity = { activity: 'hunting', spotId: spot.id, ...leaf };
    const held = state => ({ economy: { network: { activity }, stock }, statsPacket: {}, plannedState: state,
        activityPick: { activity: 'hunting', spotId: spot.id, npcId: 0 } });
    const project = (state, result, timestamp, writtenAt) => Life.prepareResolve(state, result,
        { timestamp, writtenAt, persist: false, projectClassProgression: true, statsPacket: {}, statsPacketBeforeResolve: true });
    const kernel = new ColdSimulationKernel({
        now: () => clock.at, flushTargetMs: FLUSH_MS,
        resolveSolo: options => { const result = Resolver.resolveSolo(options); onSolo(options, result); return result; },
        spotOf: () => ground,
        planLifecycle: ({ state }) => plan ? plan(state, held(state)) : held(state),
        // ready: the window's projection of its last round, the step's own (the worker's contract).
        projectResolve: (state, result, timestamp, lifecyclePlan, writtenAt, ready) => ready || project(state, result, timestamp, writtenAt),
        soloWindow: !windowed ? null : {
            projectRound: (state, result, timestamp, lifecyclePlan, writtenAt) => { onRound(kernel); return project(state, result, timestamp, writtenAt); },
            readers: () => ({ feasible: after => !ends(after) && !Economy.leafOutcome(after, activity, {}, 0) }) },
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
        // A round's action begun before its timestamp runs to its end: the next round
        // starts there (its timestamp - its elapsed), never before it (no time credited
        // twice, no stamp moved back), and the window credits through its last round's
        // last action.
        const rounds = [];
        const { kernel, step } = world({ ground: fieldOf(6), onSolo: (options, result) => rounds.push({
            start: options.timestamp - options.elapsedMs, timestamp: options.timestamp, doneAt: result.doneAt }) });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert(rounds.length >= 2 && rounds.slice(0, -1).some(round => round.doneAt > round.timestamp),
            'fixture: a round\'s last action runs past its timestamp');
        for (let k = 1; k < rounds.length; k++) {
            assert.strictEqual(rounds[k].start, Math.ceil(rounds[k - 1].doneAt), `round ${k + 1} starts at round ${k}'s last action's end`);
        }
        const last = rounds[rounds.length - 1];
        assert.strictEqual(state.stats.huntedThrough, Math.max(last.timestamp, Math.ceil(last.doneAt)),
            'the window credits through its last round\'s last action');
    }

    {
        // A rest ends the window at the round that sat down (a level-16 field: a rest
        // that runs past the round's end; one that ends inside it hunts on).
        const { kernel, step } = world({ ground: fieldOf(16) });
        kernel.upsert({ state: await hunter() });
        const { state } = await step();
        assert.equal(state.activity, 'resting', 'the fights wore the bot out');
        assert.equal(state.timing.nextResolveAt, state.stats.restUntil, 'the next due is the rest\'s end');
    }

    {
        // A level is no decision point (what it opens is heard at the rest): the window runs on.
        const next = Number(Data.experience[18]);
        const { kernel, step } = world({ ground: earning });
        kernel.upsert({ state: await hunter({ exp: next - 1 }) });
        const { state } = await step();
        assert.equal(state.level, 19);
        assert(roundsOf(state) > 1, `the window runs on past the round that reached it, ended early, not stalled (${roundsOf(state)} rounds)`);
    }

    {
        // A round ended early by its level moved the bot's clock to its kill: the window
        // counts it as no stalled round even when its next due falls before the round's
        // own bound (a long first round whose first kill gains the level).
        const next = Number(Data.experience[18]), rounds = [];
        const { kernel, step } = world({ ground: earning, onSolo: (options, result) => rounds.push({ timestamp: options.timestamp, result }) });
        kernel.upsert({ state: await hunter({ exp: next - 1, timing: { lastResolvedAt: T - 120000, nextResolveAt: T } }) });
        const { state } = await step();
        assert.equal(state.level, 19);
        const first = rounds[0];
        assert(first.result.doneAt < first.timestamp && Math.ceil(first.result.nextResolveAt) <= first.timestamp,
            `fixture: the levelling round's next due falls before its bound (${first.timestamp - first.result.nextResolveAt} ms)`);
        assert(!kernel.soloWindowStats.ended.stalled && roundsOf(state) > 1,
            `the window runs on past it, not stalled (${roundsOf(state)} rounds, stalled ${kernel.soloWindowStats.ended.stalled})`);
    }

    {
        // C4: a level up fills HP and MP to the new level's maxima (hot LevelUp); the round
        // ends at the kill that reached it.
        const next = Number(Data.experience[18]);
        const levelling = await hunter({ exp: next - 1, spotId: earning.id });
        const worn = { ...levelling, vitals: { ...levelling.vitals, hp: 1 + Math.floor(levelling.vitals.maxHp / 2), mp: 1 } };
        const result = Resolver.resolveSolo({ state: worn, spot: earning, elapsedMs: 120000, timestamp: T, rng: () => 0.5 });
        assert(result.doneAt < T && result.patch.activity === 'hunting', 'the round ends at the kill that gains the level');
        const up = await Life.prepareResolve(worn, result, { timestamp: T, persist: false, projectClassProgression: true });
        const max = Cold.fightProfile({ ...up, level: 19 }, T);
        assert.equal(up.level, 19);
        assert.deepEqual([up.vitals.hp, up.vitals.mp], [up.vitals.maxHp, up.vitals.maxMp], 'HP and MP are full at the level up');
        assert.deepEqual([up.vitals.maxHp, up.vitals.maxMp], [max.maxHp, max.maxMp], 'to the new level\'s maxima');
        // A body that levelled and then died in the round lies dead at the MP it died with,
        // and gets up at that MP, not refilled by the level.
        const died = { ...result, patch: { ...result.patch, activity: 'dead', vitals: { ...result.patch.vitals, hp: 0, mp: 1 } } };
        const dead = await Life.prepareResolve(worn, died, { timestamp: T, persist: false, projectClassProgression: true });
        assert.deepEqual([dead.level, dead.activity, dead.vitals.hp, dead.vitals.mp], [19, 'dead', 0, 1], 'dead at the MP it died with');
        const risen = Resolver.resolveDeathRecovery(dead, T + 3600000);
        assert.strictEqual(risen.patch.vitals.mp, 1, `it gets up at that MP (${risen.patch.vitals.mp} of ${max.maxMp})`);
    }

    {
        // The goal in reach: the first adena past the build's threshold raises
        // goal_affordable (the round's own diff) and ends it, raised once: the
        // step goes on from the window's projection of that round.
        const Situations = invoke('GameServer/Bot/Situations');
        const raised = () => Object.entries(Situations.counts().raised).filter(([key]) => key.startsWith('goal_affordable'))
            .reduce((sum, [, n]) => sum + n, 0);
        const rounds = [];
        const { kernel, step } = world({ onSolo: (options, result) => rounds.push({ timestamp: options.timestamp, doneAt: result.doneAt }) });
        const bound = await hunter();
        bound.stats.wishSections = { ...bound.stats.wishSections, affordAt: { at: bound.adena + 1, kind: 'focus' } };
        kernel.upsert({ state: bound });
        const before = raised();
        const { state } = await step();
        assert.equal(state.activity, 'hunting');
        assert.equal(roundsOf(state), 1, 'the round that paid it is the last');
        assert.equal(raised() - before, 1, 'the crossing is raised once');
        // The round ended at the fight that paid it: the hunt is credited to there and the
        // decision it woke is taken there, not a hunt cycle later.
        const paid = rounds[rounds.length - 1];
        assert(paid.doneAt < paid.timestamp, `the round ends at the paying fight, before its bound (${paid.timestamp - paid.doneAt} ms)`);
        assert.equal(state.stats.huntedThrough, Math.ceil(paid.doneAt), 'the hunt is credited through that fight');
        assert.equal(state.timing.nextResolveAt, state.stats.huntedThrough, 'the woken decision is due where the round ended');
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
        // Ground the bot's kit no longer admits (its gear or level lost, a table
        // row moved): its round stands with nothing to fight, and though far at
        // work it raises its ground at once (occupation, sources: the next step's
        // decision searches its spot afresh); the window ends at that round. A
        // decision that keeps it there (no other ground) is not asked again by
        // every empty round of the stay.
        const Situations = invoke('GameServer/Bot/Situations');
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
        assert(Situations.woken(state.stats, 'earning_spot') && Situations.woken(state.stats, 'build'), 'the empty spot wakes its ground and its build');
        assert.equal(roundsOf(state), 1, 'the window ends at the first empty round');
        // The decision answered and kept it on the spot: the stay raises nothing more.
        kernel.upsert({ state: { ...state, stats: { ...state.stats, woken: 0 }, simulation: { revision: 50 } } });
        const { state: stays } = await step();
        assert(!Situations.woken(stays.stats, 'build'), 'a later empty round of the stay raises nothing');
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
        const { kernel, step } = world({ ends: after => roundsOf(after) >= 3, ground: fieldOf(6) });
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
            // The round starts at the clock's end and credits nothing before it; its
            // first action may end a moment past it.
            assert(woken.timing.lastResolvedAt >= end, `the bot's clock never runs back (${woken.timing.lastResolvedAt - end} ms past it)`);
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
