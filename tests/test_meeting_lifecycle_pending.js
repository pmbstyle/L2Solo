'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const state = { characterId: 1, phase: 'cold', activity: 'shopping', simulation: { revision: 0 }, stats: {} };
const party = { phase: 'cold', revision: 0, hotAt: 0,
    sequence: 1, needRevision: 0, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } };
const originalCached = Life.cachedState;
(async () => {
    try {
        Life.cachedState = () => state;
        Service.stage({ token: 'pending-lifecycle', actorA: 1, actorB: 2, seqA: 1, seqB: 1,
            town: 'Giran', point: { locX: 0, locY: 0, locZ: 0 }, parties: [party, { ...party }],
            lines: [{ payer: 0, itemId: 3, selfId: 1867, count: 1, price: 10 }] });
        const coordinator = new ColdSimulationCoordinator();
        assert.equal(await coordinator.reviewCommittedEconomy(state, () => { throw Error('unwanted writer'); }), state);
        const result = await Population.resolveColdState(state);
        assert.equal(result.pending, true); assert.equal(result.state, state);
        // The waiting bot's command answer says it waits: the worker holds the bot until the
        // preparation's end (not a step at once on the unchanged row, a loop until it ended).
        const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
        const sent = [];
        Object.assign(coordinator, { worker: { postMessage() {} }, workerEpoch: 'pending-lifecycle',
            population: Population, postCollections: (type, payload) => { sent.push({ type, results: payload.results }); return 1; } });
        coordinator.handleCommandRequest({ payload: { requests: [{ characterId: 1, kind: 'lifecycle', commandId: 'command:1:1',
            commandCheckpoint: Protocol.commandCheckpoint(state), state, precomputedResult: { patch: {}, events: [], materialize: {} } }] } });
        await coordinator.commandTail;
        const [answer] = sent.find(message => message.type === 'command_ack').results;
        assert.equal(answer.ok, true, `the waiting command is applied: ${answer.reason}`);
        assert.equal(answer.waiting, true, 'and its answer waits for the preparation\'s end');
        assert.equal(answer.retryAfterMs, undefined, 'with no poll');
        // The payer's own command writes nothing after its deal staged the preparation (its
        // consent was read at its revision): no bid correction, buff or training follows.
        const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService'), Buffs = invoke('GameServer/Bot/Economy/ColdBuffService');
        const kept = { limits: Market.reviewPurchaseLimits, buff: Buffs.applyOffer };
        const writes = [];
        Market.reviewPurchaseLimits = async () => { writes.push('limits'); return { state, changed: true }; };
        Buffs.applyOffer = async () => { writes.push('buff'); return { ok: true }; };
        try {
            await Population.reviewColdOutcomeAfterCommit(state, { ok: true, state }, {});
            coordinator.handleCommandRequest({ payload: { requests: [{ characterId: 1, kind: 'review', commandId: 'command:1:2',
                commandCheckpoint: Protocol.commandCheckpoint(state), economyPlan: { b: [] }, buffOffer: { providerId: 2, recipientId: 1 }, training: true }] } });
            await coordinator.commandTail;
            const review = sent.filter(message => message.type === 'command_ack').at(-1).results[0];
            assert.equal(review.ok, true, `the review is answered: ${review.reason}`);
            assert.deepEqual(writes, [], 'no write of the payer follows its staged deal in its own command');
            // The seller (it pays nothing) keeps its standing offer through its own steps: its
            // command's bid correction runs while the preparation stands.
            const seller = { ...state, characterId: 2 };
            assert.equal(Service.paysInPreparation(1), true); assert.equal(Service.paysInPreparation(2), false);
            await Population.reviewColdOutcomeAfterCommit(seller, { ok: true, state: seller }, { workerAdmission: {} });
            assert.deepEqual(writes, ['limits'], 'the non-paying side\'s own command still corrects its bids');
        } finally { Market.reviewPurchaseLimits = kept.limits; Buffs.applyOffer = kept.buff; }
        // A town visit whose plan's deal staged a preparation the bot pays in: the round was
        // written before the plan (applyResolve); the visit stops there with no write of its own,
        // its round's events recorded once, and its answer waits for the preparation's end. The
        // step after it is a new round with its own events.
        {
            const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService'), LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
            const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
            const kept = { limits: Market.reviewPurchaseLimits, plan: Market.executePlan, record: LifeEvents.recordMany, shots: Shots.review };
            const recorded = [], later = [];
            Market.reviewPurchaseLimits = async row => ({ state: row, changed: false });
            Market.executePlan = async row => ({ state: row });
            LifeEvents.recordMany = async (id, events) => { recorded.push(...events); };
            Shots.review = async row => { later.push('shots'); return { state: row }; };
            try {
                const round = { ...state, stats: { forcedMarketCleanup: true } };
                const events = [{ type: 'kill', summary: 'round' }];
                const visit = await Population.applyColdResolve(state, round, { economyPlan: { b: [] } },
                    { events, debug: {} }, null, null, [], []);
                assert.equal(visit.waiting, true, 'the visit waits for its preparation');
                assert.equal(visit.state, round, 'on the round it wrote');
                assert.deepEqual(recorded, events, 'the round\'s events are recorded once');
                assert.deepEqual(later, [], 'no later step of the visit writes');
            } finally { Object.assign(Market, { reviewPurchaseLimits: kept.limits, executePlan: kept.plan }); LifeEvents.recordMany = kept.record; Shots.review = kept.shots; }
        }
        Shopping.tick({}, { fetchId: () => 1 }); // Any ordinary tick work would need the absent actor/session fields.
        assert(Service.hasPreparation(1));
        // The preparation's end wakes its far actors: their rows go back to the worker, which
        // schedules a bot its waiting answer held (no poll).
        const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator'), woken = [];
        const keptEnded = Coordinator.preparationEnded;
        Coordinator.preparationEnded = ids => woken.push(...ids);
        try { Service.discard('pending-lifecycle'); } finally { Coordinator.preparationEnded = keptEnded; }
        assert(!Service.hasPreparation(1));
        assert.deepEqual(woken, [1, 2], 'the end wakes both far actors');
        const marked = [];
        Object.assign(coordinator, { worker: {}, ready: true, markDirty: (row, options) => marked.push([row.characterId, options.reason]) });
        coordinator.preparationEnded([1]);
        assert.deepEqual(marked, [[1, 'trade_preparation_end']], 'a far actor\'s row is sent to the worker at the end');
        console.log('PASS pending preparation gates native cold lifecycle, follow-up training/improvement and visible shopping');
    } finally { Service.reset(); Life.cachedState = originalCached; }
})().catch(error => { console.error(error); process.exitCode = 1; });
