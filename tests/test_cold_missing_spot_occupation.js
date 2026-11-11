'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-missing-spot-occupation');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'), DB = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const Native = require('./helpers/nativeMarketFixture');
const Situations = invoke('GameServer/Bot/Situations');

(async () => {
    Data.init(); await DB.init();
    const originalEconomy = Economy.forState;
    try {
        const id = 9410, account = 'bot_missing_spot_occupation';
        const loc = Town.marketTown('Gludio').center;
        await Native.character(DB, id, 'MissingSpotBuyer', account, loc);
        await DB.execute(['UPDATE characters SET level=14,exp=? WHERE id=?', [Data.experience[13], id]]);
        await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 200000, slot: 0 });
        await Life.init();
        const plan = { status: 'active', strategy: 'market', target: { selfId: 50, slot: 9 },
            market: { town: 'Gludio', price: 10000, reserve: 0 } };
        const state = await Life.upsertState({ characterId: id, accountName: account, name: 'MissingSpotBuyer',
            phase: 'cold', activity: 'hunting', level: 14, exp: Data.experience[13], adena: 200000,
            spotId: null, currentRegion: 'Gludio', loc, timing: { lastResolvedAt: Date.now()-30000 },
            vitals: { hp: 400, maxHp: 400, mp: 200, maxMp: 200 },
            inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
            stats: { classId: 0, role: 'dps', classProgressionLevel: 14, classProgressionClassId: 0,
                equipmentPlan: plan, wishFocus: ['power:50:9', 0, 10000] } }, 'missing_spot_fixture');
        const card = Decision.capture({ riskWeight: 1, network: { quantityPrepared: true, activity: {
            activity: 'shopping', rootKey: 'power:50:9', itemId: 50, amount: 1,
            price: 10000, town: 'Gludio', sourceType: 'npc', heldAtDecision: 0 } } }, state);
        // Main must consume the accepted worker action, not build another wish network.
        Economy.forState = () => { throw Error('unexpected main-thread economy build'); };
        const result = await Population.executeWorkerLifecycleCommand(state, {
            precomputedPlan: { previousPlan: plan, acquisitionPlan: plan, economyDecision: card,
                economyPlan: { travel: 'power:50:9' } },
            precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                occupation: 'shopping', nextResolveAt: Date.now()+30000, debug: { activity: 'shopping' } }
        });
        assert(result.ok, 'a purchase round does not require a hunting spot');
        // Its town is the one it stands in: the visit starts here (no trip), else a trip to it.
        assert(result.state.inventory[50]?.amount > 0 || result.state.stats.travel?.arrivalActivity === 'shopping'
            || result.state.activity === 'shopping',
            `the native purchase executes or starts its visit: ${JSON.stringify({ activity: result.state.activity,
                reason: result.reason, goal: result.state.stats.lastReason, travel: result.state.stats.travel })}`);
        assert.equal(Coordinator.economyDecisions.byId.get(id)?.held, false, 'the command releases its worker decision');

        // A far bot resting where it stands, no spot under it and no trip from its step: its
        // worker step ended the rest (due now) and raised spot_empty. Main applies the step as
        // the worker took it, its decisions with it, and writes no rest of its own.
        const restId = 9411, restAccount = 'bot_missing_spot_rest';
        await Native.character(DB, restId, 'NoSpotRester', restAccount, loc);
        await DB.execute(['UPDATE characters SET level=14,exp=? WHERE id=?', [Data.experience[13], restId]]);
        const resting = await Life.upsertState({ characterId: restId, accountName: restAccount, name: 'NoSpotRester',
            phase: 'cold', activity: 'resting', level: 14, exp: Data.experience[13], adena: 0,
            spotId: null, currentRegion: 'Gludio', loc, timing: { lastResolvedAt: Date.now()-30000 },
            vitals: { hp: 400, maxHp: 400, mp: 200, maxMp: 200 },
            inventory: Life.inventorySummaryFromItems(await DB.fetchItems(restId)),
            stats: { classId: 0, role: 'dps', classProgressionLevel: 14, classProgressionClassId: 0, woken: 0, waiting: 0 } },
            'no_spot_fixture');
        const raised = Situations.raise({ woken: 0, waiting: 0 }, 'spot_empty');
        const ended = await Population.executeWorkerLifecycleCommand(resting, {
            precomputedPlan: { statsPacket: Situations.stepMind({ decisionSeq: 42 }, { woken: 0, waiting: 0 }, raised) },
            precomputedResult: { patch: { activity: 'hunting' }, events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: Date.now(),
                debug: { fights: 0, wins: 0 } }
        });
        const row = Life.cachedState(restId);
        assert(ended.ok);
        assert.equal(row.activity, 'hunting', 'a far bot with no spot in its step leaves its rest as the worker ended it');
        assert(row.timing.nextResolveAt <= Date.now() + 1000, 'a far bot with no spot in its step is due as the worker set it');
        assert.equal(row.stats.decisionSeq, 42, 'the step\'s decisions are on the row');
        assert(raised.woken && (row.stats.woken & raised.woken) === raised.woken, 'the step\'s spot_empty raise is on the row');
        assert.notEqual(ended.reason, 'missing_spot_recovery');
        assert.equal(row.stats.routeRecovery, undefined, 'main keeps no recovery count of its own');
        // The one cold no-spot fallback: a hunting bot with no ground gets nothing and stays put.
        const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
        const before = Date.now();
        const idle = BackgroundResolver.resolveSolo({ state: { ...row, activity: 'hunting' }, spot: null, timestamp: before });
        assert.deepEqual(idle.patch, {}, 'a hunting bot with no spot stays where it stands');
        assert.deepEqual(idle.materialize, { exp: 0, sp: 0, adena: 0, items: [] }, 'no exp, sp, adena or items without a spot');
        assert.equal(idle.nextResolveAt, before + 60000, 'it is due again in 60 s');
        console.log('PASS missing spot: a worker step with no hunting ground is applied as the worker took it');
    } finally {
        Economy.forState = originalEconomy;
        await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
