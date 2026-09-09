const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-interaction-memory-'));
const file = path.join(dir, 'test.sqlite');
options.default.Database.path = file;
const event = (key, sourceId = 1, targetId = 2, at = Date.now()) => ({ key, sourceId, targetId, type: 'attacked', at });

async function run() {
    try {
        Database.init();
        for (const id of [1, 2]) {
            await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)', [`bot_memory_${id}`, 'test']]);
            await Database.execute([`INSERT INTO characters(id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
                VALUES (?, ?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`, [id, `bot_memory_${id}`, `Memory${id}`]]);
        }
        const main = new Memory(Repository);
        const batch = [event('fight:1:a'), event('fight:1:b', 2, 1)];
        const first = await main.recordBatch(batch);
        assert(first.ok);
        assert.deepStrictEqual((await main.recordBatch(batch)).statuses, ['duplicate', 'duplicate']);
        assert.strictEqual(main.snapshot(1).revision, 1);
        const before = await Repository.load(1);
        const failed = await main.recordBatch([event('valid'), event('expired', 2, 1, Date.now() - Policy.ACCEPT_WINDOW_MS - 1000)]);
        assert.strictEqual(failed.ok, false);
        assert.deepStrictEqual(await Repository.load(1), before, 'rejected batch leaves no partial directed memory');
        await assert.rejects(main.recordBatch([event('fk-valid'), event('fk-fail', 999, 1)]), /FOREIGN KEY/);
        assert.deepStrictEqual(await Repository.load(1), before, 'SQL failure rolls back earlier owners too');
        await Promise.all([main.recordBatch([event('concurrent:1')]), main.recordBatch([event('concurrent:2')])]);
        assert.strictEqual(main.snapshot(1).revision, 3, 'serialized updates preserve both incidents');

        const timestamp = Date.now();
        await Database.execute([`INSERT INTO bot_life_state(characterId, accountName, characterName, phase, activity, updatedAt,
            simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil, statsJson)
            VALUES (1, 'bot_memory_1', 'Memory1', 'cold', 'hunting', ?, 'cold_simulation_owner', 0, 'memory-lease', ?, '{}')`,
        [timestamp, timestamp + 60000]]);
        const request = { characterId: 1, expectedRevision: 0, ownerId: 'cold_simulation_owner', leaseId: 'memory-lease',
            timestamp, leaseUntil: timestamp + 60000, patch: { hp: 73 }, memoryEvents: [event('cold:accepted')] };
        const committed = await Database.commitColdSimulationLease(request);
        assert.strictEqual(committed.ok, true);
        assert.strictEqual(committed.row.hp, 73);
        assert.strictEqual(committed.memorySnapshots[0].revision, 4);
        const stale = await Database.commitColdSimulationLease({ ...request, memoryEvents: [event('cold:stale')] });
        assert.strictEqual(stale.ok, false);
        assert.strictEqual((await Repository.load(1)).revision, 4, 'rejected lifecycle proposal creates no social event');
        await assert.rejects(Database.commitColdSimulationLease({ ...request, expectedRevision: 1, patch: { hp: 1 },
            memoryEvents: [event('cold:expired', 1, 2, timestamp - Policy.ACCEPT_WINDOW_MS - 1000)] }), /expired_event/);
        assert.strictEqual((await Database.execute(['SELECT hp FROM bot_life_state WHERE characterId = 1', []]))[0].hp, 73,
            'social admission failure rolls back the physical outcome');
        await assert.rejects(Database.commitColdSimulationLease({ ...request, expectedRevision: 1, memoryEvents: {} }), /invalid cold batch/);
        await Database.execute([`INSERT INTO bot_life_state(characterId, accountName, characterName, phase, activity, updatedAt,
            simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil, statsJson)
            VALUES (2, 'bot_memory_2', 'Memory2', 'cold', 'hunting', ?, 'cold_simulation_owner', 0, 'memory-lease-2', ?, '{}')`,
        [timestamp, timestamp + 60000]]);
        const atomicGroup = { id: 'encounter:1', memberIds: [1, 2] };
        const group = [
            { ...request, expectedRevision: 1, atomicGroup, memoryEvents: [event('group:1')] },
            { ...request, characterId: 2, leaseId: 'memory-lease-2', atomicGroup, memoryEvents: [event('group:2', 2, 1)] }
        ];
        const queuedChange = Database.execute(['UPDATE bot_life_state SET simulationRevision = 1 WHERE characterId = 2', []]);
        const raced = Database.commitAndReleaseColdSimulationLeases(group);
        await queuedChange;
        assert((await raced).every(result => !result.ok), 'group preflight must see earlier queued ownership changes');
        assert.strictEqual((await Repository.load(1)).revision, 4, 'no half-encounter memory after a queued ownership race');
        assert.strictEqual((await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = 1', []]))[0].simulationRevision, 1);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision = 0 WHERE characterId = 2', []]);
        await assert.rejects(Database.commitAndReleaseColdSimulationLeases([
            group[0], { ...group[1], memoryEvents: [event('group:expired', 2, 1, timestamp - Policy.ACCEPT_WINDOW_MS - 1000)] }
        ]), /expired_event/);
        assert.strictEqual((await Repository.load(1)).revision, 4, 'failure in second participant rolls back first participant memory');
        assert.strictEqual((await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = 1', []]))[0].simulationRevision, 1);
        const groupResult = await Database.commitAndReleaseColdSimulationLeases(group);
        assert(groupResult.every(result => result.ok && result.memorySnapshots.length === 1));
        assert.strictEqual((await Repository.load(1)).revision, 5);
        assert.strictEqual((await Repository.load(2)).revision, 2);
        const repeatedGroup = await Database.commitAndReleaseColdSimulationLeases(group);
        assert(repeatedGroup.every(result => !result.ok));
        assert.strictEqual((await Repository.load(1)).revision, 5);
        assert.strictEqual((await Database.execute(['SELECT version FROM schema_migrations WHERE version = 37', []])).length, 1);
        // Actual hot callback -> queued SQLite write -> cold snapshot -> ACK.
        const runtime = invoke('GameServer/Social/InteractionMemoryRuntime');
        await runtime.ensureMany([1, 2]);
        const Competition = invoke('GameServer/Bot/AI/BotMobCompetition');
        const actor = id => {
            const value = { fetchId: () => id, fetchLocX: () => 0, fetchLocY: () => 0,
                fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false };
            value.session = { actor: value, accountId: `bot_memory_${id}`, plan: 'hunting',
                currentTargetId: 999, pvpDefense: {} };
            return value;
        };
        const a = actor(1), b = actor(2);
        const mob = { fetchId: () => 999, fetchKind: () => 'Monster', fetchHp: () => 100 };
        Competition.record(a, mob);
        for (let i = 0; i < 100; i++) Competition.record(b, mob);
        assert.strictEqual(runtime.events.snapshot().pending, 1, 'one hot episode despite 100 hit callbacks');
        await runtime.events.flush();
        assert.strictEqual((await Repository.load(1)).revision, 6);
        const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
        const kernel = new ColdSimulationKernel({ resolveSolo: () => ({}) });
        const coordinator = new ColdSimulationCoordinator();
        coordinator.contextIndex = () => ({ spots: new Map(), parties: new Map() });
        coordinator.routeFor = () => null;
        const coldState = { characterId: 1, phase: 'cold', activity: 'hunting', stats: {},
            simulation: { revision: 5 }, timing: { nextResolveAt: Date.now() + 60000 } };
        const oldPage = coordinator.snapshotEntry(coldState);
        kernel.upsert(oldPage);
        assert.deepStrictEqual(kernel.interactionMemory.assess({ id: 1 }, { id: 2 }, {}, timestamp),
            runtime.assess({ id: 1 }, { id: 2 }, {}, timestamp));
        assert(!kernel.states.get(1).context.interactionMemory, 'worker stores one indexed view, not an extra context copy');
        await runtime.recordBatch([event('ack:memory')]);
        coordinator.postCollections = (type, payload) => {
            assert.strictEqual(type, 'commit_ack');
            kernel.onCommitAck(payload);
        };
        await coordinator.handleCommitResults([{ ok: true, characterId: 1, nextState: coldState }]);
        kernel.upsert(oldPage);
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'late catalog pages cannot overwrite ACK memory');
        kernel.upsert({ state: { ...coldState, phase: 'hot', simulation: { revision: 6 } } });
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'phase changes do not erase memory');
        kernel.remove(1);
        assert.strictEqual(kernel.interactionMemory.inspect(1).ready, false);
        kernel.upsert(coordinator.snapshotEntry(coldState));
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'a returning cold bot is rehydrated');
        const saved = await Repository.load(1);
        await Database.close();
        Database.init();
        assert.deepStrictEqual(await Repository.load(1), saved, 'real close/reopen preserves bounded memory and replay ledger');
        const restarted = new Memory(Repository);
        await restarted.load(1);
        const worker = new Memory();
        worker.accept(restarted.snapshot(1));
        assert.deepStrictEqual(worker.assess({ id: 1 }, { id: 2 }, {}, timestamp), restarted.assess({ id: 1 }, { id: 2 }, {}, timestamp));
        assert.strictEqual((await restarted.recordBatch([batch[0]])).statuses[0], 'duplicate');
        assert.strictEqual((await Database.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
        await Database.execute(['DELETE FROM characters WHERE id = 1', []]);
        assert.strictEqual((await Repository.load(1)).revision, 0, 'character deletion removes its memory');
        console.log('Interaction memory SQLite restart, atomicity and cold commit checks passed');
    } finally {
        await Database.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
        fs.rmdirSync(dir);
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
