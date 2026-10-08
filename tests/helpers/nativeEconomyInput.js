'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const archive = path.resolve(__dirname, '../..');
const nativeDecision = require(path.join(archive, 'tests/helpers/workerEconomyDecision'));
const Decision = require(path.join(archive, 'src/GameServer/Bot/Population/ColdEconomyDecision'));
const captures = [];

// The worker receives the native registered full tables (including the board
// and market-counter rows), authored catalogues and the current roster. The
// returned whole packet is carried into the existing main consumer; no wish,
// leaf, price, valuation or wallet value is supplied by this fixture.
module.exports = async function withNativeEconomyInput(state, consume, timestamp = Date.now()) {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const DB = invoke('Database');
    const Policy = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
    const channel = invoke('GameServer/Bot/Population/ColdTableChannel').shared;
    const tables = [...channel.tables.values()].filter(table => !table.streamed).map(table => channel.full(table));
    const contexts = async value => ({ knownShotRecipes: Policy.packKnown(
        (await DB.fetchCharacterRecipes(value.characterId)).map(row => Number(row.recipeId))) });
    const extraStates = [];
    for (const other of Life.everyState()) if (other.characterId !== state.characterId) {
        extraStates.push({ state: other, context: await contexts(other) });
    }
    const before = structuredClone(state);
    const context = await contexts(state);
    const tablePages = channel.pages(tables).map(page => page.payload);
    const captured = await nativeDecision(state, { timestamp, context, extraStates, tablePages });
    assert.deepEqual(state, before, 'the actual worker leaves the main input unchanged');
    const native = Decision.compact(captured.decision);
    assert.equal(native.updatedAt, Number(state.updatedAt || 0));
    assert.equal(native.key, Decision.stateKey(state));
    assert.deepEqual(captured.forbiddenLoaded, []);
    const accepted = { ...state, stats: { ...state.stats, ...captured.statsPacket } };
    assert.equal(accepted.adena, state.adena, 'packet publication retains the original wallet');
    assert.deepEqual(accepted.inventory, state.inventory, 'packet publication retains the original bag');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const decisions = Coordinator.economyDecisions;
    const previous = decisions.byId.get(state.characterId);
    decisions.accept(state.characterId, captured.decision);
    assert(decisions.decided(accepted), 'the capture belongs to this exact timestamp and state key');
    // Native command review holds the accepted decision across its physical
    // publications, then releases it. This service fixture uses that boundary.
    decisions.hold(state.characterId, captured.decision);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const originalFull = Economy.forState;
    Economy.forState = function (value, ...args) {
        if (value?.phase === 'cold') throw Error('fixture forbids a main cold wish-network build');
        return originalFull.call(this, value, ...args);
    };
    const record = { input: before, timestamp, tableVersions: tables.map(table => [table.name, table.to, table.rows.length]),
        nativeTables: structuredClone(tables), knownShotRecipes: context.knownShotRecipes, statsPacket: captured.statsPacket,
        decision: { ...native, data: Buffer.from(native.data).toString('base64') },
        activity: native.activity, queue: captured.queue, sourceKey: native.key,
        sourceUpdatedAt: native.updatedAt, publication: 'whole native packet + accepted command-held decision' };
    captures.push(record);
    try {
        const result = await consume(accepted, timestamp);
        record.result = result;
        return result;
    } catch (error) { record.error = error.stack; throw error; }
    finally {
        Economy.forState = originalFull;
        decisions.release(state.characterId);
        if (previous) decisions.byId.set(state.characterId, previous); else decisions.forget(state.characterId);
        if (process.env.NATIVE_PACKET_CAPTURE_OUTPUT) fs.writeFileSync(process.env.NATIVE_PACKET_CAPTURE_OUTPUT,
            JSON.stringify(captures, null, 2));
    }
};
