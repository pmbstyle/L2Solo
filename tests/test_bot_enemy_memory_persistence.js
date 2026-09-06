const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Memory = invoke('GameServer/Bot/AI/BotEnemyMemory');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-enemies-'));
    const file = path.join(dir, 'test.sqlite');
    const db = new DatabaseSync(file);
    db.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    db.exec(`INSERT INTO accounts VALUES ('bot_memory_test', 'test');
        INSERT INTO characters (id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (1, 'bot_memory_test', 'MemoryBot', 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`);
    const saved = { execute: Database.execute, location: Database.updateCharacterLocation,
        experience: Database.updateCharacterExperience, vitals: Database.updateCharacterVitals,
        recover: Owner.recoverStartupLeases, dirty: Coordinator.markDirty };
    let writes = 0;
    try {
        Database.execute = async ([sql, params = []]) => {
            const statement = db.prepare(sql);
            if (statement.columns().length) return statement.all(...params.map(v => v ?? null));
            if (sql.includes("'$.pvpEnemies'")) writes++;
            const result = statement.run(...params.map(v => v ?? null));
            return { affectedRows: Number(result.changes) };
        };
        Database.updateCharacterLocation = Database.updateCharacterExperience = Database.updateCharacterVitals = async () => {};
        Owner.recoverStartupLeases = async () => ({ affectedRows: 0 });
        Coordinator.markDirty = () => {};
        assert(await Life.init());
        const state = await Life.upsertState({ characterId: 1, name: 'MemoryBot', accountName: 'bot_memory_test',
            level: 10, phase: 'hot', activity: 'hunting', stats: { sentinel: 'keep', classId: 0 }, inventory: {},
            loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } });
        assert(state);
        const actor = { effects: {}, fetchId: () => 1, fetchName: () => 'MemoryBot', fetchLevel: () => 10,
            fetchClassId: () => 0, fetchExp: () => 0, fetchSp: () => 0,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
            fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100 };
        const session = { actor, accountId: 'bot_memory_test', plan: 'hunting', coldLifeState: state };
        actor.session = session;
        const foe = { fetchId: () => 2, fetchName: () => 'RepeatedKiller' };
        for (let i = 0; i < 500; i++) Memory.record(actor, foe, false, 100000 + i);
        await Life.rememberEnemies(session);
        assert.strictEqual(writes, 1, '500 rapid hits must cause one compact database update');
        Memory.record(actor, foe, true, 101000);
        Memory.record(actor, foe, true, 102000);
        await Life.rememberEnemies(session);
        assert.strictEqual(writes, 2, 'queued deaths should coalesce without losing either kill');
        const read = () => JSON.parse(db.prepare('SELECT statsJson FROM bot_life_state WHERE characterId = 1').get().statsJson);
        assert.strictEqual(read().pvpEnemies[0].kills, 2);
        assert.strictEqual(read().sentinel, 'keep', 'enemy updates must preserve unrelated lifecycle metadata');

        const cold = await Life.markCold(session, 'test_enemy_handoff');
        assert.strictEqual(cold.stats.pvpEnemies[0].kills, 2, 'cooldown snapshots must carry enemy memory');
        const reader = new DatabaseSync(file, { readOnly: true });
        const persisted = JSON.parse(reader.prepare('SELECT statsJson FROM bot_life_state WHERE characterId = 1').get().statsJson);
        reader.close();
        const restarted = { actor, coldLifeState: { stats: persisted } };
        assert.strictEqual(Memory.entries(restarted)[0].kills, 2, 'a fresh session must recover memory from the database');
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        Database.execute = saved.execute; Database.updateCharacterLocation = saved.location;
        Database.updateCharacterExperience = saved.experience; Database.updateCharacterVitals = saved.vitals;
        Owner.recoverStartupLeases = saved.recover; Coordinator.markDirty = saved.dirty;
        db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('Bot enemy memory SQLite persistence checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
