'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const id = 745601;
const fields = ['activityStartedAt', 'nextResolveAt', 'lastResolvedAt', 'lastHotAt'];

(async () => {
    const world = await createWorld([{ id, level: 20 }], 'cold-integer-timing');
    try {
        const at = Date.now();
        await Database.createAccount('bot_integer_timing', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_integer_timing', id]]);
        // A saved recovery deadline from before this fix, as on the live stalled bot.
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,
            phase,activity,activityStartedAt,nextResolveAt,lastResolvedAt,lastHotAt,updatedAt,
            adena,inventorySummary,statsJson,hp,maxHp,mp,maxMp)
            VALUES (?,?,'IntegerTiming',20,'cold','hunting',?,?,?,?,?,500,?, ?,100,100,100,100)`,
        [id, 'bot_integer_timing', at - 60000 + .125, at + 60000 + .25, at - 30000 + .5,
            at - 120000 + .75, at,
            JSON.stringify({ 57: { selfId: 57, amount: 500 } }), JSON.stringify({ classId: 0, generatedCold: true })]]);
        assert.equal(await Life.init(), true);
        const loaded = Life.cachedState(id);
        assert(Protocol.commandCheckpoint(loaded), 'startup repairs a legacy row before worker publication');
        const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
        for (const field of fields) {
            assert(Number.isSafeInteger(row[field]), `startup persists integer ${field}`);
            assert.equal(row[field], loaded.timing[field], 'native authority and published checkpoint agree');
        }
        assert.equal(loaded.adena, 500, 'clock repair preserves the wallet');
        assert.equal(loaded.inventory[57].amount, 500);

        const projected = await Life.prepareResolve({ ...loaded, timing: {
            ...loaded.timing, activityStartedAt: at - 60000 + .125, lastHotAt: at - 120000 + .75
        } }, {
            patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: at + 90000 + .125
        }, { persist: false, projectClassProgression: true, timestamp: at + .25, writtenAt: at + .5 });
        assert.equal(projected.timing.lastResolvedAt, at + 1, 'a simulated round publishes whole milliseconds');
        assert.equal(projected.timing.nextResolveAt, at + 90001, 'the next step never starts before its deadline');
        assert.equal(projected.updatedAt, at + 1);
        assert.equal(projected.timing.activityStartedAt, at - 59999);
        assert.equal(projected.timing.lastHotAt, at - 119999);
        assert(Protocol.commandCheckpoint(projected), 'the projected row can receive the following native command');
        const pricing = Pricing.lineState(1867, { characterId: id, timestamp: at + .125 },
            { price: 100, count: 1, sigma: .2 });
        assert.equal(pricing.seenAt, at + 1, 'line observations satisfy the native integer pricing contract');

        const saved = await Life.upsertState({ ...projected, timing: Object.fromEntries(
            fields.map((field, index) => [field, at + index + .375])) }, 'fractional_native_transition');
        assert(Protocol.commandCheckpoint(saved), 'native lifecycle saves also publish valid command authority');
        for (const field of fields) assert(Number.isSafeInteger(saved.timing[field]));

        const kernel = new ColdSimulationKernel({ resolveSolo: async () => null, now: () => at + 100000 });
        kernel.upsert({ state: saved });
        kernel.buyerWakeups.add(id);
        kernel.dueCandidates();
        assert(kernel.commanding.has(id), 'a buyer wake on the repaired bot acquires a command instead of losing its schedule');
        await kernel.resolveChain;
        await kernel.shutdown();

        const invalid = { ...saved, timing: { ...saved.timing, nextResolveAt: at + .125 } };
        assert.equal(Protocol.commandCheckpoint(invalid), null, 'wire validation still rejects malformed checkpoints');
        const retry = new ColdSimulationKernel({ resolveSolo: async () => null, now: () => at + 100000 });
        retry.upsert({ state: invalid });
        retry.buyerWakeups.add(id);
        retry.dueCandidates();
        assert.equal(retry.commanding.has(id), false, 'an invalid checkpoint never gains command authority');
        assert.equal(retry.scheduleTokens.get(id)?.dueAt, at + 101000,
            'a command that cannot start retains a bounded retry instead of dropping its owner');
        await retry.shutdown();
        console.log('PASS legacy timing repair, integer projection, native save and buyer wake scheduling');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
