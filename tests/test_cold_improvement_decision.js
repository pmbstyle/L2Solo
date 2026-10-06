// L25: the post-commit improvement review of a cold bot uses the worker's
// decision made on the committed state and builds no wish network on main;
// without a decision it builds the network as before.
const assert = require('node:assert/strict');
require('../src/Global');
const { capture, stateKey } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const Service = invoke('GameServer/Bot/Economy/BotImprovementService');

(async () => {
    const improvement = { kind: 'enchant', itemId: 4001, riskHours: 2 };
    const economy = { riskWeight: 1.5, network: { activity: { activity: 'improving', improvement, spotId: null, npcId: null } } };
    const decision = capture(economy, { characterId: 41, updatedAt: 500 });
    assert.deepEqual(decision, { updatedAt: 500, key: stateKey({ characterId: 41, updatedAt: 500 }), riskWeight: 1.5,
        activity: { activity: 'improving', spotId: null, npcId: null, improvement } });
    assert.equal(capture({ riskWeight: 1, network: { activity: { activity: 'hunting', improvement } } }, {}).activity.improvement,
        undefined, 'an improvement travels only when the bot is improving');

    const state = { characterId: 41, phase: 'cold', activity: 'hunting', updatedAt: 500, simulation: { ownerId: 'legacy_main' } };
    const writes = [];
    let builds = 0;
    const saved = { forState: Economy.forState, apply: Database.applyBotImprovement, cached: Life.cachedState, accept: Life.acceptLifecycleRow };
    Economy.forState = () => { builds += 1; return economy; };
    Database.applyBotImprovement = async (id, plan, options) => { writes.push({ id, plan, options }); return { coldLifeRow: { characterId: id } }; };
    Life.cachedState = () => state;
    Life.acceptLifecycleRow = () => state;
    try {
        await Service.reviewCold(state, { beforeWrite: 'w', decide: () => decision });
        assert.equal(builds, 0, 'the decided state builds no network on main');
        assert.deepEqual(writes[0].plan, { ...improvement, lossHours: 3 });
        assert.equal(writes[0].options.decide, undefined, 'the decision is not passed to the writer');
        assert.equal(writes[0].options.beforeWrite, 'w');

        await Service.reviewCold(state, { beforeWrite: 'w' });
        assert.equal(builds, 1, 'without a decision the network is built');
        assert.deepEqual(writes[1].plan, writes[0].plan, 'same improvement either way');
        console.log('test_cold_improvement_decision: ok');
    } finally {
        Economy.forState = saved.forState; Database.applyBotImprovement = saved.apply;
        Life.cachedState = saved.cached; Life.acceptLifecycleRow = saved.accept;
    }
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
