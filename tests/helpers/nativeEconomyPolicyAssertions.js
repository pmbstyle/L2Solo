'use strict';

const assert = require('node:assert/strict');
const nativeDecision = require('./workerEconomyDecision');
const Decision = require('../../src/GameServer/Bot/Population/ColdEconomyDecision');
const Packet = require('../../src/GameServer/Bot/Economy/StatsPacket');

// Independent E3 oracle over the real worker packet: C(r) is the cumulative
// cost of wishes above r (a query naming no root reads the rows by ratio).
// This helper never creates or alters a money packet.
function expectedSpendable(state, { r = 0, escrow = 0, upperBound = false, free = false } = {}) {
    const packet = state.stats?.money;
    assert(Packet.hasMoney(packet), 'funding must use an actual native packet');
    const wallet = Math.max(0, Number(state.adena ?? state.inventory?.[57]?.amount) || 0) + escrow;
    if (upperBound) return Math.max(0, wallet - Packet.refillReserve(packet));
    if (free && Packet.firstUnfundedPrice(packet) !== 0) return 0;
    if (free) r = -Infinity;
    else if (r < Packet.moneyPrice(packet)) return 0;
    let higherCost = 0;
    for (let row = 0; row < Packet.fundedRows(packet); row++) {
        if (Packet.fundedRatio(packet, row) > r) higherCost = Math.max(higherCost, Packet.fundedCumulative(packet, row));
    }
    return Math.max(0, wallet - Packet.refillReserve(packet) - higherCost);
}

function assertFunding(state) {
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const packet = state.stats.money;
    assert(Packet.hourAdena(packet) > 0 && Packet.moneyPrice(packet) > 0, 'native hunting supplies a positive hour and money value');
    assert(packet.every(Number.isFinite), 'all native packet values are finite');
    assert([Packet.hourAdena(packet), Packet.refillReserve(packet), Packet.firstUnfundedPrice(packet)].every(Number.isSafeInteger));
    const rows = Packet.fundedRows(packet);
    assert(rows <= Packet.MONEY_ROWS, 'the actual funded list retains its eight-entry bound');
    let priorCost = 0;
    for (let row = 0; row < rows; row++) {
        const cumulative = Packet.fundedCumulative(packet, row);
        assert(cumulative >= priorCost && Number.isSafeInteger(cumulative));
        assert(Number.isSafeInteger(Packet.fundedRoot(packet, row)), 'each row names its root id (0: none)');
        priorCost = cumulative;
    }
    const missingBefore = Funding.summary().moneyPacketMissing;
    const price = Packet.moneyPrice(packet);
    const queries = [{ r: price / 2 }, { r: price }, { r: Infinity }, { free: true }, { upperBound: true }];
    for (const query of queries) assert.equal(Funding.spendable(state, 0, query), expectedSpendable(state, query),
        'actual native packet agrees with R/C(r)/moneyPrice ' + JSON.stringify(query));
    assert.equal(Funding.summary().moneyPacketMissing, missingBefore, 'native funding never falls back to a missing packet');
}

// Capture in the actual worker, then use the actual main acceptance/readers.
// The native selected activity is an observation; no shopping/selling leaf is supplied.
async function captureAndRead(state, { timestamp, context = {}, needsOptions = {}, nativeRoutes = false } = {}) {
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const decisions = Coordinator.economyDecisions;
    const before = structuredClone(state);
    const captured = await nativeDecision(state, { timestamp, context, nativeRoutes });
    assert.deepEqual(state, before, 'worker projection cannot mutate the supplied main fixture');
    const accepted = { ...state, stats: { ...state.stats, ...captured.statsPacket } };
    const native = Decision.compact(captured.decision);
    assert.equal(native.updatedAt, state.updatedAt);
    assert.deepEqual(native.echo, Decision.stateEcho({ ...state, stats: { ...state.stats, ...captured.statsPacket } }));
    assert.deepEqual(captured.forbiddenLoaded, []);
    assert.equal(Floor.forState(accepted, timestamp), null, 'this fixture reaches the voluntary decision reader');
    const originalFull = Economy.forState;
    decisions.forget(state.characterId);
    Economy.forState = function (value, ...args) {
        if (value?.phase === 'cold') throw Error('fixture forbids a main cold network build');
        return originalFull.call(this, value, ...args);
    };
    try {
        const options = { ...needsOptions, now: timestamp };
        assert.deepEqual(Needs.evaluate(state, options), [], 'without a worker decision the cold review defers');
        decisions.accept(state.characterId, captured.decision);
        const read = decisions.decided(accepted);
        assert(read, 'the genuine capture is accepted for exactly this state');
        assert.deepEqual(accepted.stats.money, captured.statsPacket.money, 'the whole native packet is retained');
        const leaf = read.activity;
        assert(leaf, 'authored native providers must select an activity for this fixture');
        const goals = Needs.evaluate(accepted, options);
        assert.equal(goals.length, 1, 'the accepted native choice maps to one voluntary goal');
        const goal = goals[0];
        assert.equal(goal.plan.wishKey, leaf.rootKey);
        assert.equal(goal.plan.economyActivity, leaf.activity);
        if (leaf.activity === 'shopping') {
            const item = invoke('GameServer/DataCache').items.find(row => Number(row.selfId) === leaf.itemId);
            assert(item, 'a native shopping item has an authored template');
            assert.equal(goal.type, Number(item.etc?.slot || 0) ? 'upgrade_gear' : 'buy_craft_material');
            assert.equal(goal.target.itemId, leaf.itemId);
            assert.equal(goal.target.amount, Math.max(1, Math.ceil(leaf.amount || read.wish?.[1] || 1)));
            assert.equal(goal.plan.estimatedCost, leaf.price);
        } else if (leaf.activity === 'selling') {
            assert.equal(goal.type, 'sell_inventory');
            assert.deepEqual(goal.target.itemIds, leaf.items || []);
            assert.equal(goal.target.itemCount, (leaf.items || []).length);
            for (const id of goal.target.itemIds) assert(state.inventory?.[id]?.amount > 0, 'native sale refers to an actual bag row');
        } else if (leaf.activity === 'hunting') {
            assert.equal(goal.type, leaf.funding ? 'earn_adena' : 'progress_level');
            if (leaf.funding) assert.equal(goal.target.adena, read.wish?.[2] || 0);
            else assert.equal(goal.target.level, state.level + 1);
        } else if (leaf.activity === 'improving') {
            assert.equal(goal.type, 'improving');
            assert.deepEqual(goal.target.improvement, leaf.improvement);
        } else assert.equal(goal.type, leaf.activity);
        assertFunding(accepted);
        assert.deepEqual(Needs.evaluate({ ...accepted, updatedAt: accepted.updatedAt + 1 }, options), [],
            'a later main timestamp cannot consume the previous decision');
        // A situation that woke the build (a new grade) waits for its decision: the card
        // holds only while its build is not woken.
        const Situations = invoke('GameServer/Bot/Situations');
        assert.deepEqual(Needs.evaluate({ ...accepted, level: accepted.level + 1, stats: Situations.raise({ ...accepted.stats, woken: 0 },
            'grade_changed', null, Situations.REST) }, options), [],
            'a woken build cannot consume the previous decision');
        console.log(JSON.stringify({ characterId: state.characterId, nativeActivity: leaf.activity,
            goalType: goal.type, money: accepted.stats.money, nativeQueue: captured.queue }));
        return { state: accepted, captured, activity: leaf, goal };
    } finally {
        Economy.forState = originalFull;
        decisions.forget(state.characterId);
    }
}

module.exports = { captureAndRead, assertFunding, expectedSpendable };
