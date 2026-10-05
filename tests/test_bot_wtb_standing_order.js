const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

const PIECE_BONE_GAITERS = 32;
const SHORT_GLOVES = 48;

const original = {
    snapshot: LifeState.snapshot,
    findOwnerProjection: AfkTrade.findOwnerProjection,
    ownerRecords: AfkTrade.ownerRecords,
    closeBotRecord: AfkTrade.closeBotRecord,
    evaluate: NeedsEvaluator.evaluate
};

// The bot's buy order is a buy ad on the board (step 3.3); it has no shop.
const stops = [];
const order = { id: 95726, ownerId: 7, kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: 37213, revision: 1,
    lines: [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }] };
// A level 40 bot planning to buy from another bot (an NPC-shop plan never
// holds a WTB; checked at the end).
const resting = (planTarget, sourceType = 'afk_bot_store', level = 40) => ({
    characterId: 7, phase: 'cold', activity: 'resting', level, adena: 20000, accountName: 'bot_pop_7',
    vitals: { hp: 300, maxHp: 1000, mp: 100, maxMp: 500 },
    stats: { generatedCold: true, classId: 0, build: { grade: level >= 40 ? 'c' : 'd', classId: 0, level }, equipment: [],
        equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: planTarget, slot: 11 },
            market: { town: 'Gludio', price: 37213, reserve: 6250, sourceType } } },
    inventory: {}
});
const recover = { type: 'recover', status: 'active', priority: 90, target: { hpPct: 0.8, mpPct: 0.65 },
    plan: { kind: 'rest', expectedBenefit: 'restore_vitals' } };

(async () => {
try {
    AfkTrade.findOwnerProjection = () => null;
    AfkTrade.ownerRecords = () => [order];
    AfkTrade.closeBotRecord = (ownerId) => { stops.push(ownerId); return Promise.resolve({ closed: true }); };

    // Resting makes recovery the current goal between two hunts. The buy
    // order posted for the plan's target must survive it, as a sell shop does.
    let state = resting(PIECE_BONE_GAITERS);
    LifeState.snapshot = () => state;
    let result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(stops.length, 0, 'a rest does not withdraw the standing WTB');
    assert.strictEqual(result.changed, false);

    // The wallet alone (20,000) does not cover price + reserve (43,463): the
    // order's escrow keeps the need funded through the rest.
    // Near death the evaluation asks only to recover: the order waits.
    state = { ...resting(PIECE_BONE_GAITERS), vitals: { hp: 40, maxHp: 1000, mp: 100, maxMp: 500 } };
    result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(stops.length, 0, 'a bot near death keeps its order');

    // The order stands for the need, not for the plan alone: once the target
    // is equipped the evaluation no longer asks to buy it.
    state = resting(PIECE_BONE_GAITERS);
    state.stats.equipment = [{ selfId: PIECE_BONE_GAITERS, slot: 11, rank: 'none', name: 'Piece Bone Gaiters' }];
    state.inventory = { [PIECE_BONE_GAITERS]: { selfId: PIECE_BONE_GAITERS, amount: 1, equippedCount: 1 } };
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'an order for an already equipped target is withdrawn');
    stops.length = 0;

    // A craft material stands only while the needs evaluation still asks to
    // buy it, so its retry window keeps applying.
    const crafting = (stats = {}) => ({ ...resting(999), stats: { generatedCold: true, classId: 0, ...stats,
        equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 1, marketFallback: true,
            target: { selfId: 999, slot: 11 }, next: { itemId: PIECE_BONE_GAITERS, amount: 2 },
            materials: [{ selfId: PIECE_BONE_GAITERS, amount: 2, missing: 2 }] } } });
    state = crafting();
    result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(stops.length, 0, 'a material the evaluation still buys keeps its order');
    state = crafting({ marketRetryAfter: Date.now() + 60000 });
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'a material under its market retry window does not hold an order');
    stops.length = 0;

    // Drop and craft plans are run by the resolver, not by a market goal: a
    // drop plan for the ordered item does not keep the order.
    state = resting(PIECE_BONE_GAITERS);
    state.stats.equipmentPlan = { ...state.stats.equipmentPlan, strategy: 'direct_drop' };
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'a drop plan for the item does not keep its order');
    stops.length = 0;

    // The needs evaluation runs once per reconcile, not once per order line.
    let evaluations = 0;
    NeedsEvaluator.evaluate = (...args) => { evaluations += 1; return original.evaluate(...args); };
    order.lines = [{ id: 3, selfId: SHORT_GLOVES, name: 'Short Gloves', count: 1, price: 100 },
        { id: 4, selfId: 999, name: 'Item 999', count: 1, price: 100 }];
    state = resting(PIECE_BONE_GAITERS);
    await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(evaluations, 1, 'one evaluation covers every order line');
    // A goal review that just evaluated the needs hands them over: no second evaluation.
    evaluations = 0;
    stops.length = 0;
    order.lines = [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }];
    state = resting(PIECE_BONE_GAITERS);
    const reviewed = original.evaluate(state);
    result = await BotAfkMarket.reconcile(state, recover, reviewed);
    assert.strictEqual(evaluations, 0, 'the review\'s needs are reused');
    assert.strictEqual(stops.length, 0, 'and keep the order');
    result = await BotAfkMarket.reconcile(state, recover, reviewed.filter((need) => need.type !== 'upgrade_gear'));
    assert.deepStrictEqual(stops, [7], 'the review\'s needs decide: no buy need, no order');
    stops.length = 0;
    NeedsEvaluator.evaluate = original.evaluate;
    order.lines = [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }];
    stops.length = 0;

    // Once the plan no longer wants the item, the order is withdrawn.
    state = resting(SHORT_GLOVES);
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'an order the plan no longer wants is withdrawn');
    assert.strictEqual(result.withdrawn, true);
    stops.length = 0;

    state = { ...resting(PIECE_BONE_GAITERS), stats: { generatedCold: true, classId: 0 } };
    await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'without any buy need there is nothing to wait for');
    stops.length = 0;

    // At 40+ a gear goal can come from the class build without an
    // acquisition plan; its order must survive a rest as well.
    const weapon = BotGear.planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 7);
    const chest = BotGear.planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 10);
    const buildGoalBot = {
        characterId: 7, phase: 'cold', activity: 'resting', level: 40, adena: 1000000, accountName: 'bot_pop_7',
        vitals: { hp: 600, maxHp: 1000, mp: 300, maxMp: 500 }, party: {},
        stats: { generatedCold: true, classId: 0, build: { grade: 'c', classId: 0, level: 40 },
            equipment: [{ selfId: weapon.selfId, slot: 7, rank: 'c', name: weapon.name }] },
        inventory: {}
    };
    const need = NeedsEvaluator.evaluate(buildGoalBot).find((candidate) => candidate.type === 'upgrade_gear');
    assert.strictEqual(Number(need?.target?.itemId), Number(chest.selfId), 'fixture: the class build asks for a chest');
    order.lines = [{ id: 2, selfId: chest.selfId, name: chest.name, count: 1, price: 1000 }];
    state = buildGoalBot;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(stops.length, 0, 'a build-driven gear order survives a rest');
    assert.strictEqual(result.changed, false);
    // An order for an NPC-shop plan is withdrawn even during a rest: that
    // purchase is made at the NPC (E4).
    order.lines = [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }];
    stops.length = 0;
    state = resting(PIECE_BONE_GAITERS, 'npc', 25);
    LifeState.snapshot = () => state;
    await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'an NPC-shop plan holds no WTB through a rest');
    stops.length = 0;

    // A goal review returns the needs it evaluated, for the reconcile after it.
    const GoalService = invoke('GameServer/Bot/Goals/GoalService');
    const GoalState = invoke('GameServer/Bot/Goals/GoalState');
    const savedGoalState = { snapshot: GoalState.snapshot, set: GoalState.set, setBatch: GoalState.setBatch };
    try {
        GoalState.snapshot = () => ({ characterId: 7, current: { ...recover, nextReviewAt: Date.now() + 60000 } });
        GoalState.set = (characterId, goal) => Promise.resolve({ characterId, current: goal });
        GoalState.setBatch = (rows) => Promise.resolve(rows.map((row) => ({ characterId: row.characterId, current: row.goal })));
        const snapshot = await GoalService.review(resting(PIECE_BONE_GAITERS));
        assert(Array.isArray(snapshot?.candidates) && snapshot.candidates.length > 0, 'the review hands back its needs');
        assert(snapshot.current?.type, 'and the chosen goal');
        const [batched] = await GoalService.reviewBatch([resting(PIECE_BONE_GAITERS)]);
        assert(Array.isArray(batched?.candidates) && batched.candidates.length > 0, 'a batch review hands back its needs too');
    } finally {
        GoalState.snapshot = savedGoalState.snapshot;
        GoalState.set = savedGoalState.set;
        GoalState.setBatch = savedGoalState.setBatch;
    }
} finally {
    LifeState.snapshot = original.snapshot;
    AfkTrade.findOwnerProjection = original.findOwnerProjection;
    AfkTrade.ownerRecords = original.ownerRecords;
    AfkTrade.closeBotRecord = original.closeBotRecord;
    NeedsEvaluator.evaluate = original.evaluate;
    BotAfkMarket._resetForTests();
}

console.log('Bot standing WTB checks passed');
process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
