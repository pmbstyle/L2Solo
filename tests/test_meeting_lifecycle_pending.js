'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const state = { characterId: 1, phase: 'cold', activity: 'shopping', simulation: { revision: 0 }, stats: {} };
const party = { phase: 'cold', ownerId: 'legacy_main', revision: 0, leaseId: null, hotAt: 0,
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
        Shopping.tick({}, { fetchId: () => 1 }); // Any ordinary tick work would need the absent actor/session fields.
        assert(Service.hasPreparation(1));
        Service.discard('pending-lifecycle'); assert(!Service.hasPreparation(1));
        console.log('PASS pending preparation gates native cold lifecycle, follow-up training/improvement and visible shopping');
    } finally { Service.reset(); Life.cachedState = originalCached; }
})().catch(error => { console.error(error); process.exitCode = 1; });
