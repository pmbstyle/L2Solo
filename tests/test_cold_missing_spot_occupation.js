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
                equipmentPlan: plan, routeRecovery: { reason: 'missing_spot', attempts: 1000 },
                lastReason: 'missing_spot_recovery', wishFocus: ['power:50:9', 0, 10000] } }, 'missing_spot_fixture');
        const card = Decision.capture({ riskWeight: 1, network: { quantityPrepared: true, activity: {
            activity: 'shopping', rootKey: 'power:50:9', itemId: 50, amount: 1,
            price: 10000, town: 'Gludio', sourceType: 'npc', heldAtDecision: 0 } } }, state);
        // Main must consume the accepted worker action, not build another wish network.
        Economy.forState = () => { throw Error('unexpected main-thread economy build'); };
        const result = await Population.executeWorkerLifecycleCommand(state, {
            route: { needed: false, spotId: null },
            precomputedPlan: { previousPlan: plan, acquisitionPlan: plan, economyDecision: card,
                economyPlan: { travel: 'power:50:9' } },
            precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                occupation: 'shopping', nextResolveAt: Date.now()+30000, debug: { activity: 'shopping' } }
        });
        assert(result.ok);
        assert.notEqual(result.reason, 'missing_spot_recovery', 'a purchase round does not require a hunting spot');
        assert.equal(result.state.stats.routeRecovery.attempts, 1000, 'the command does not repeat fake recovery');
        // Its town is the one it stands in: the visit starts here (no trip), else a trip to it.
        assert(result.state.inventory[50]?.amount > 0 || result.state.stats.travel?.arrivalActivity === 'shopping'
            || result.state.activity === 'shopping',
            `the native purchase executes or starts its visit: ${JSON.stringify({ activity: result.state.activity,
                reason: result.reason, goal: result.state.stats.lastReason, travel: result.state.stats.travel })}`);
        assert.equal(Coordinator.economyDecisions.byId.get(id)?.held, false, 'the command releases its worker decision');
        // A combat result still needs its actual ground: a fight at an absent
        // destination is not applied, the bot rests and the worker routes it.
        const hunting = await Life.upsertState({ ...result.state, activity: 'hunting', spotId: null,
            stats: { ...result.state.stats, travel: null, marketErrand: null, marketErrands: [],
                equipmentPlan: null, partyMarketReturn: null }, timing: {} }, 'missing_combat_ground');
        const combat = await Population.resolveColdState(hunting, {
            route: { needed: false, spotId: null },
            precomputedPlan: { statsPacket: { decisionSeq: 42, activityLeaf: 99, wishDirty: 0 } },
            precomputedResult: { patch: { activity: 'hunting' }, events: [],
                materialize: { exp: 1000, sp: 100, adena: 100, items: [] }, debug: { fights: 1, wins: 1 } }
        });
        assert.equal(combat.reason, 'missing_spot_recovery');
        assert.equal(combat.state.exp, hunting.exp, 'a fight without its ground grants no experience');
        assert.equal(combat.state.adena, hunting.adena, 'a fight without its ground grants no money');
        console.log('PASS missing spot: selected worker purchase escapes recovery through the native action');
    } finally {
        Economy.forState = originalEconomy;
        await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
