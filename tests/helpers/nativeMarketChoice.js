'use strict';
// This fixture inspects build diagnostics; opt in explicitly.
require('../../src/GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nativeWorker = require('./workerEconomyDecision');
const Decision = require('../../src/GameServer/Bot/Population/ColdEconomyDecision');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Diagnostic of actual native inputs/selection. It never supplies a leaf,
// money packet, desired target, fabricated price or class/wealth/stock change.
async function capture(state, options = {}, label = '') {
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    const channel = require('../../src/GameServer/Bot/Population/ColdTableChannel').shared;
    const context = { buyOrderEscrow: invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId) };
    const timestamp = Number(options.now) || Date.now();
    const originalFull = Economy.forState;
    Economy.forState = function (value, ...args) {
        if (value?.phase === 'cold') throw Error('fixture forbids main cold wish build during capture/accept/read');
        return originalFull.call(this, value, ...args);
    };
    try {
    const before = structuredClone(state), inputHash = hash(state);
    const tables = ['board', 'market'].map(name => channel.tables.get(name)).filter(Boolean).map(table => channel.full(table));
    const tablePages = channel.pages(tables).map(page => page.payload);
    Coordinator.economyDecisions.forget(state.characterId);
    assert.equal(invoke('GameServer/Bot/Population/SurvivalFloor').forState(state, timestamp), null,
        'the original scenario reaches the voluntary decision reader');
    const miss = Needs.evaluate(state, { ...options, now: timestamp });
    assert.deepEqual(miss, [], 'a voluntary cold read without an accepted native decision must defer');
    // options.nativeRoutes: the worker prepares town routes before the wish
    // review, as its route cache does for a live bot (5e91bb1c).
    const captured = await nativeWorker(state, { timestamp, context, tablePages, nativeRoutes: options.nativeRoutes === true });
    assert.deepEqual(state, before, 'actual worker cannot mutate the original fixture input');
    assert.deepEqual(captured.forbiddenLoaded, []);
    const native = Decision.compact(captured.decision);
    assert.equal(native.updatedAt, Number(state.updatedAt || 0));
    assert.equal(native.key, Decision.stateKey(state));
    const accepted = { ...state, stats: { ...state.stats, ...captured.statsPacket } };
    Coordinator.economyDecisions.accept(state.characterId, captured.decision);
    const read = Coordinator.economyDecisions.decided(accepted);
    assert(read, 'genuine capture must be accepted for its exact original state key');
    assert.deepEqual(accepted.stats.money, captured.statsPacket.money);
    const packet = accepted.stats.money;
    assert(Array.isArray(packet) && packet.length >= 4 && packet.length <= 28 && (packet.length - 4) % 3 === 0);
    assert(packet.every(Number.isFinite), 'genuine stored money packet is numeric and finite');
    const wallet = Math.max(0, Number(state.adena ?? state.inventory?.[57]?.amount) || 0);
    const missingBefore = Funding.summary().moneyPacketMissing;
    const funding = [];
    for (const query of [{ r: packet[1] / 2 }, { r: packet[1] }, { r: Infinity }, { free: true }, { upperBound: true }]) {
        let expected = 0;
        if (query.upperBound) expected = Math.max(0, wallet - packet[2]);
        else if (!(query.free && packet[3] !== 0)) {
            const ratio = query.free ? -Infinity : query.r;
            if (query.free || ratio >= packet[1]) {
                let higher = 0;
                for (let at = 4; at + 2 < packet.length; at += 3) if (packet[at] > ratio) higher = packet[at + 1];
                expected = Math.max(0, wallet - packet[2] - higher);
            }
        }
        const actual = Funding.spendable(accepted, 0, query);
        assert.equal(actual, Math.min(wallet, expected), 'independent E3 packet R/C(r) comparison');
        funding.push({ query: { ...query, ...(query.r === Infinity ? { r: 'Infinity' } : {}) }, actual, expected });
    }
    assert.equal(Funding.summary().moneyPacketMissing, missingBefore);
    const goals = Needs.evaluate(accepted, { ...options, now: timestamp });
    const stale = Needs.evaluate({ ...accepted, updatedAt: Number(accepted.updatedAt || 0) + 1 }, { ...options, now: timestamp });
    assert.deepEqual(stale, [], 'a later main timestamp cannot consume the previous native decision');
    assert.deepEqual(Economy.summary().mainColdForState, {}, 'all main capture and consumption steps avoid a cold build');
    console.log('Native capture diagnostic:', JSON.stringify({ label, timestamp, inputHash,
        inputUnchanged: hash(state) === inputHash, actor: state.characterId, inputActivity: state.activity,
        inputLevel: state.level, inputClass: state.stats?.classId ?? state.classId, wallet, context,
        tableRows: Object.fromEntries(tables.map(table => [table.name, table.rows.length])),
        nativeActivity: read.activity, nativeWish: read.wish, packet, funding,
        miss, stale, goals, nativeQueue: captured.queue }));
    return { state: accepted, goals, captured, read, inputHash };
    } finally { Economy.forState = originalFull; }
}
async function evaluate(state, options, label) { return (await capture(state, options, label)).goals; }
module.exports = { capture, evaluate };
