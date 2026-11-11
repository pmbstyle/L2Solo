'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
const originals = { decided: decisions.decided, forState: Economy.forState };
const bot = { characterId: 2004384, name: 'Baran', phase: 'cold', activity: 'shopping', level: 31,
    adena: 33749393, currentRegion: 'Giran', inventory: {},
    vitals: { hp: 978, maxHp: 978, mp: 263, maxMp: 344 },
    stats: { classId: 56, clanId: 6000050, money: [468794, 2.14e-6, 7650, 0, 7.13e-5, 11880, 736] } };
let decision = { inputHash: 12, activity: { activity: 'shopping', sourceType: 'npc', town: 'Giran',
    rootKey: 'stock:scrolls', itemId: 736, amount: 10, heldAtDecision: 0, price: 11880, unitPrice: 1188, r: 7.13e-5 } };
// On arrival the goal is read from the held card on the arriving state: the
// worker's selected step, not what the bot left the field for; main builds no
// income forecast for it.
(async () => {
    try {
        decisions.decided = () => decision;
        Economy.forState = () => { throw Error('arrival must not rebuild the income forecast on main'); };
        const fresh = Needs.goal(bot);
        assert.equal(fresh.type, 'buy_craft_material');
        assert.equal(fresh.target.itemId, 736, 'arrival uses the selected scroll refill');
        assert.equal(fresh.target.amount, 10);
        assert.equal(fresh.plan.valueRate, 7.13e-5, 'the selected card retains its native funding terms');
        // Part of the refill reached the bag since the decision: the goal asks for the rest.
        assert.equal(Needs.goal({ ...bot, inventory: { 736: { selfId: 736, amount: 4 } } }).target.amount, 6);
        decision = { inputHash: 13, activity: { ...decision.activity, rootKey: 'power:166:7',
            itemId: 166, amount: 1, price: 1223467, unitPrice: 1223467, r: 1.6e-5 } };
        const gear = Needs.goal({ ...bot, inventory: { 736: { selfId: 736, amount: 10 } } });
        assert.equal(gear.type, 'upgrade_gear');
        assert.equal(gear.target.itemId, 166, 'the next town pass can buy the selected weapon after refill');
        assert.equal(Needs.goal({ ...bot, phase: 'hot' }), null, 'a body near a player reads no far goal');
        console.log('PASS market arrival: the goal read from the worker card, its rest after a partial fill, refill then gear, no main income calculation');
    } finally {
        decisions.decided = originals.decided; Economy.forState = originals.forState;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
