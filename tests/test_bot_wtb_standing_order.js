const assert = require('assert');

const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const nativeChoice = require('./helpers/nativeMarketChoice');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');

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

    // ARCH-NOTE: C1 reads one genuinely accepted leaf. The original 30%HP
    // does not create the E1 hard floor and its old order need is unfunded.
    let state = (await nativeChoice.capture(resting(PIECE_BONE_GAITERS), {}, 'original_hp30_order')).state;
    LifeState.snapshot = () => state;
    let result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(Funding.spendable(state, 37213, { itemId: PIECE_BONE_GAITERS }), 0, 'escrow is owned cash, not a funded gain');
    assert.deepStrictEqual(stops, [7], 'a resting label cannot invent a funded item need');
    assert.strictEqual(result.withdrawn, true);
    stops.length = 0;

    // Escrow is still owned cash. The original4%HP voluntary state uses
    // the real funded-gain packet, not the retired price+flatreserve rule.
    state = (await nativeChoice.capture({ ...resting(PIECE_BONE_GAITERS), vitals: { hp: 40, maxHp: 1000, mp: 100, maxMp: 500 } }, {}, 'original_hp4_order')).state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'the original 4%HP still follows its actual voluntary leaf');
    stops.length = 0;
    // A genuine zero-HP native floor defers judgement of the standing order.
    state = { ...resting(PIECE_BONE_GAITERS), vitals: { hp: 0, maxHp: 1000, mp: 100, maxMp: 500 } };
    assert.strictEqual(NeedsEvaluator.evaluate(state)[0]?.plan?.kind, 'revive');
    result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(stops.length, 0, 'a native revival floor retains the order');
    assert.strictEqual(result.changed, false);

    // The order stands for the need, not for the plan alone: once the target
    // is equipped the evaluation no longer asks to buy it.
    state = resting(PIECE_BONE_GAITERS);
    state.stats.equipment = [{ selfId: PIECE_BONE_GAITERS, slot: 11, rank: 'none', name: 'Piece Bone Gaiters' }];
    state.inventory = { [PIECE_BONE_GAITERS]: { selfId: PIECE_BONE_GAITERS, amount: 1, equippedCount: 1 } };
    state = (await nativeChoice.capture(state, {}, 'original_equipped_target')).state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'an order for an already equipped target is withdrawn');
    stops.length = 0;

    // A legacy craft material plan cannot manufacture the current leaf;
    // its original retry window remains an independent negative.
    const crafting = (stats = {}) => ({ ...resting(999), stats: { generatedCold: true, classId: 0, ...stats,
        equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 1, marketFallback: true,
            target: { selfId: 999, slot: 11 }, next: { itemId: PIECE_BONE_GAITERS, amount: 2 },
            materials: [{ selfId: PIECE_BONE_GAITERS, amount: 2, missing: 2 }] } } });
    state = (await nativeChoice.capture(crafting(), {}, 'original_craft_plan')).state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'a legacy material plan alone cannot bypass the actual native choice');
    stops.length = 0;
    state = (await nativeChoice.capture(crafting({ marketRetryAfter: Date.now() + 60000 }), {}, 'original_retry_window')).state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'a material under its market retry window does not hold an order');
    stops.length = 0;

    // Drop and craft plans are run by the resolver, not by a market goal: a
    // drop plan for the ordered item does not keep the order.
    state = resting(PIECE_BONE_GAITERS);
    state.stats.equipmentPlan = { ...state.stats.equipmentPlan, strategy: 'direct_drop' };
    state = (await nativeChoice.capture(state, {}, 'original_direct_drop')).state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'a drop plan for the item does not keep its order');
    stops.length = 0;

    // C1's already captured watch needs no second Main needs evaluation.
    // When the genuine floor is evaluated, it runs once for all order lines.
    let evaluations = 0;
    NeedsEvaluator.evaluate = (...args) => { evaluations += 1; return original.evaluate(...args); };
    order.lines = [{ id: 3, selfId: SHORT_GLOVES, name: 'Short Gloves', count: 1, price: 100 },
        { id: 4, selfId: 999, name: 'Item 999', count: 1, price: 100 }];
    state = (await nativeChoice.capture(resting(PIECE_BONE_GAITERS), {}, 'once_per_reconcile')).state;
    evaluations = 0;
    await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(evaluations, 0, 'the captured watch is reused without rebuilding needs for each line');
    evaluations = 0;
    stops.length = 0;
    state = { ...state, vitals: { ...state.vitals, hp: 0 } };
    await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(evaluations, 1, 'one genuine native-floor evaluation covers both original order lines');
    assert.strictEqual(stops.length, 0, 'floor judgement defers every original order line');
    // A goal review that just evaluated the needs hands them over: no second evaluation.
    evaluations = 0;
    stops.length = 0;
    order.lines = [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }];
    state = { ...resting(PIECE_BONE_GAITERS), vitals: { hp: 0, maxHp: 1000, mp: 100, maxMp: 500 } };
    const reviewed = original.evaluate(state);
    assert.strictEqual(reviewed[0]?.plan?.kind, 'revive', 'reused positive is the genuine native floor');
    result = await BotAfkMarket.reconcile(state, recover, reviewed);
    assert.strictEqual(evaluations, 0, 'the review\'s needs are reused');
    assert.strictEqual(stops.length, 0, 'and keep the order');
    result = await BotAfkMarket.reconcile(state, recover, reviewed.filter((need) => need.type !== 'recover'));
    assert.deepStrictEqual(stops, [7], 'the review\'s needs decide: no buy need, no order');
    stops.length = 0;
    NeedsEvaluator.evaluate = original.evaluate;
    order.lines = [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }];
    stops.length = 0;

    // Once the plan no longer wants the item, the order is withdrawn.
    state = (await nativeChoice.capture(resting(SHORT_GLOVES), {}, 'original_unrelated_target')).state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'an order the plan no longer wants is withdrawn');
    assert.strictEqual(result.withdrawn, true);
    stops.length = 0;

    state = (await nativeChoice.capture({ ...resting(PIECE_BONE_GAITERS), stats: { generatedCold: true, classId: 0 } }, {}, 'original_no_plan')).state;
    await BotAfkMarket.reconcile(state, recover);
    assert.deepStrictEqual(stops, [7], 'without any buy need there is nothing to wait for');
    stops.length = 0;

    // At40+ the unchanged class build still supplies candidate equipment.
    // The actual accepted one-leaf decision determines which order stands.
    const weapon = BotGear.planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 7);
    const chest = BotGear.planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 10);
    const buildGoalBot = {
        characterId: 7, phase: 'cold', activity: 'resting', level: 40, adena: 1000000, accountName: 'bot_pop_7',
        vitals: { hp: 600, maxHp: 1000, mp: 300, maxMp: 500 }, party: {},
        stats: { generatedCold: true, classId: 0, build: { grade: 'c', classId: 0, level: 40 },
            equipment: [{ selfId: weapon.selfId, slot: 7, rank: 'c', name: weapon.name }] },
        inventory: {}
    };
    const buildNative = await nativeChoice.capture(buildGoalBot, {}, 'original_build_driven_chest_order');
    assert.strictEqual(buildNative.goals.length, 1, 'one actual class-build leaf reaches the reader');
    assert.strictEqual(buildNative.goals[0].priority, 50);
    const expectedKeep = buildNative.read.activity.activity === 'shopping'
        && Number(buildNative.read.activity.itemId) === Number(chest.selfId)
        && buildNative.goals[0].plan?.sourceType !== 'npc';
    if (expectedKeep) assert(Funding.spendable(buildNative.state, 37213, { itemId: chest.selfId }) > 0,
        'a native selected chest has actual funding; the old class-build target alone is insufficient');
    order.lines = [{ id: 2, selfId: chest.selfId, name: chest.name, count: 1, price: 1000 }];
    state = buildNative.state;
    result = await BotAfkMarket.reconcile(state, recover);
    assert.strictEqual(stops.length, expectedKeep ? 0 : 1, 'the original chest order follows the actual accepted native leaf');
    assert.strictEqual(result.changed, !expectedKeep);
    console.log('Native original build-order choice:', JSON.stringify({ chestId: chest.selfId, weaponId: weapon.selfId,
        nativeLeaf: buildNative.read.activity, goals: buildNative.goals, expectedKeep, closed: stops.length }));
    // An order for an NPC-shop plan is withdrawn even during a rest: that
    // purchase is made at the NPC (E4).
    order.lines = [{ id: 1, selfId: PIECE_BONE_GAITERS, name: 'Piece Bone Gaiters', count: 1, price: 37213 }];
    stops.length = 0;
    state = (await nativeChoice.capture(resting(PIECE_BONE_GAITERS, 'npc', 25), {}, 'original_npc_order')).state;
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
        const reviewNative = await nativeChoice.capture(resting(PIECE_BONE_GAITERS), {}, 'goal_review_native_input');
        const snapshot = await GoalService.review(reviewNative.state);
        assert(Array.isArray(snapshot?.candidates) && snapshot.candidates.length > 0, 'the review hands back its needs');
        assert(snapshot.current?.type, 'and the chosen goal');
        const [batched] = await GoalService.reviewBatch([reviewNative.state]);
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
    assert.deepStrictEqual(Economy.summary().mainColdForState, {});
}

console.log('Bot standing WTB checks passed');
process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
