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
        // A raise on the payer (a recipe learned) waits for the preparation's end: landed now it
        // would move the revision its consent was read at. The seller's lands at once.
        const Events = invoke('GameServer/Bot/AI/DecisionEvents'), raised = [], keptRaise = Events.raiseFar;
        Events.raiseFar = async id => { raised.push(id); return null; };
        // The preparation's end wakes its far actors: their rows go back to the worker, which
        // schedules a bot its waiting answer held (no poll).
        const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator'), woken = [];
        const keptEnded = Coordinator.preparationEnded;
        Coordinator.preparationEnded = ids => woken.push(...ids);
        try {
            Events.raiseOn(1, 'recipe_learned'); Events.raiseOn(2, 'recipe_learned');
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(raised, [2], 'the payer\'s raise waits, the seller\'s lands');
            Service.discard('pending-lifecycle');
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(raised, [2, 1], 'the payer\'s raise lands at the preparation\'s end');
        } finally { Coordinator.preparationEnded = keptEnded; Events.raiseFar = keptRaise; }
        assert(!Service.hasPreparation(1));
        assert.deepEqual(woken, [1, 2], 'the end wakes both far actors');
        // A raise held behind a preparation lands at its end once: a preparation staged right
        // after does not hold it again, a command started meanwhile does until it ends.
        {
            const Events = invoke('GameServer/Bot/AI/DecisionEvents'), raised = [], keptRaise = Events.raiseFar;
            const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator'), keptEnded = Coordinator.preparationEnded;
            const request = token => ({ token, actorA: 1, actorB: 2, seqA: 1, seqB: 1, town: 'Giran', point: { locX: 0, locY: 0, locZ: 0 },
                parties: [party, { ...party }], lines: [{ payer: 0, itemId: 3, selfId: 1867, count: 1, price: 10 }] });
            Events.raiseFar = async id => { raised.push(id); return null; };
            Coordinator.preparationEnded = () => {};
            const tick = () => new Promise(resolve => setImmediate(resolve));
            try {
                Service.stage(request('held-once'));
                Events.raiseOn(1, 'recipe_learned');
                Service.discard('held-once'); Service.stage(request('staged-after'));
                await tick();
                assert.deepEqual(raised, [1], 'a preparation staged after the end does not hold the raise again');
                Events.raiseOn(1, 'recipe_learned');
                let finish; const command = new Promise(resolve => { finish = resolve; });
                Coordinator.commandInflight.set(1, command);
                Service.discard('staged-after');
                await tick();
                assert.deepEqual(raised, [1], 'a command started while the preparation stood holds the raise');
                Coordinator.commandInflight.delete(1); finish();
                await tick();
                assert.deepEqual(raised, [1, 1], 'it lands at the command\'s end');
            } finally { Coordinator.commandInflight.delete(1); Coordinator.preparationEnded = keptEnded; Events.raiseFar = keptRaise; }
        }
        // An accept's rows land before its preparation ends: the end's republication and the
        // raises it held read the accepted rows, the board records refreshed before them.
        {
            const Events = invoke('GameServer/Bot/AI/DecisionEvents'), keptRaise = Events.raiseFar;
            const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator'), keptEnded = Coordinator.preparationEnded;
            const Database = invoke('Database'), Afk = invoke('GameServer/AfkTrade/AfkTradeService');
            const kept = { accept: Database.acceptTradeMeeting, shops: Database.fetchAfkTradeShops, admission: Database.withoutMutationAdmission,
                refresh: Afk.refreshRecord, row: Life.acceptLifecycleRow };
            const order = [];
            Events.raiseFar = async id => { order.push(`raise:${id}`); return null; };
            Coordinator.preparationEnded = ids => order.push(`ended:${ids.join(',')}`);
            Database.fetchAfkTradeShops = async id => { await new Promise(resolve => setImmediate(resolve)); return [{ id: 90 + id }]; };
            Database.withoutMutationAdmission = () => {};
            Afk.refreshRecord = record => order.push(`record:${record.id}`);
            Life.acceptLifecycleRow = row => { order.push(`row:${row.characterId}`); return null; };
            const meeting = { id: 7, token: 'accepted-lifecycle', actorA: 1, actorB: 2, state: 'accepted', revision: 1, locX: 0, locY: 0, locZ: 0 };
            Database.acceptTradeMeeting = async () => ({ meeting, pending: true, coldLifeRows: { 1: { characterId: 1 }, 2: { characterId: 2 } } });
            try {
                Service.stage({ token: 'accepted-lifecycle', actorA: 1, actorB: 2, seqA: 1, seqB: 1, town: 'Giran', point: { locX: 0, locY: 0, locZ: 0 },
                    parties: [party, { ...party }], lines: [{ payer: 0, itemId: 3, selfId: 1867, count: 1, price: 10 }] });
                Events.raiseOn(1, 'recipe_learned');
                const answer = await Service.accept('accepted-lifecycle');
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(answer.outcome, 'accepted');
                assert.deepEqual(order, ['record:91', 'record:92', 'row:1', 'row:2', 'ended:1,2', 'raise:1'],
                    'records, then the accepted rows, then the end and the raise it held');
            } finally {
                Object.assign(Database, { acceptTradeMeeting: kept.accept, fetchAfkTradeShops: kept.shops, withoutMutationAdmission: kept.admission });
                Afk.refreshRecord = kept.refresh; Life.acceptLifecycleRow = kept.row;
                Coordinator.preparationEnded = keptEnded; Events.raiseFar = keptRaise;
            }
        }
        const marked = [];
        Object.assign(coordinator, { worker: {}, ready: true, markDirty: (row, options) => marked.push([row.characterId, options.reason]) });
        coordinator.preparationEnded([1]);
        assert.deepEqual(marked, [[1, 'trade_preparation_end']], 'a far actor\'s row is sent to the worker at the end');
        console.log('PASS pending preparation gates native cold lifecycle, follow-up training/improvement and visible shopping');
    } finally { Service.reset(); Life.cachedState = originalCached; }
})().catch(error => { console.error(error); process.exitCode = 1; });
