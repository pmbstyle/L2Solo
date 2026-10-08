'use strict';
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Books = invoke('GameServer/Skills/SkillBookCatalog');
async function run() {
    const ids = Array.from({ length: 12 }, (_, index) => 719300 + index);
    const world = await createWorld(ids.map(id => ({ id, level: 10 })), 'cold-class-migration-queue');
    const interval = global.setInterval, clear = global.clearInterval;
    const handles = new Set();
    let checks = 0, attempted = 0;
    const needs = Books.needsTraining, execute = Database.execute;
    try {
        for (const [index, id] of ids.entries()) {
            const records = Profile.skillRecordsFromTree(0, 10);
            for (const skill of records) await Database.setSkill(skill, id);
            const snapshot = { ...Profile.legacySnapshot({ level: 10, stats: { classId: 0 } }, records, 1e12), skillSource: 'tree' };
            const stats = { classId: 0, classProgressionLevel: index < 7 ? 0 : 10,
                classProgressionClassId: 0, coldCombat: snapshot };
            await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,
                currentRegion,hp,maxHp,mp,maxMp,statsJson,inventorySummary,updatedAt)
                VALUES(?, 'quests', ?, 10, 'cold', 'hunting', 'Talking Island',187,187,74,74,?,'{}',?)`,
                [id, `Migration${id}`, JSON.stringify(stats), id]]);
        }
        Books.needsTraining = (...args) => { checks++; return needs(...args); };
        await Life.init();
        assert.equal(Life.pendingClassProgressionMigration(), 7);
        Database.execute = (...args) => {
            if (String(args[0]?.[0]).includes('SELECT id, classId, level, exp, sp FROM characters')) attempted++;
            return execute(...args);
        };
        global.setInterval = callback => { const handle = { callback, unref() {} }; handles.add(handle); return handle; };
        global.clearInterval = handle => handles.delete(handle);
        Population.started = true;
        Population.playerActivityProfile = () => ({ protected: false });
        Population.ensureClassProgressionMigrationTimer();
        assert.equal(handles.size, 1);
        const first = await Population.migrateLegacyClassProgression();
        assert.equal(first.length, 5); assert.equal(Life.pendingClassProgressionMigration(), 2);
        const second = await Population.migrateLegacyClassProgression();
        assert.equal(second.length, 2); assert.equal(attempted, 7);
        assert.equal(Life.pendingClassProgressionMigration(), 0); assert.equal(handles.size, 0);
        const doneChecks = checks;
        await Population.migrateLegacyClassProgression();
        assert.equal(checks, doneChecks, 'an idle call does not examine the 12 loaded states');
        assert.equal(attempted, 7);

        const unchangedId = ids[7];
        await Database.execute(["UPDATE bot_life_state SET phase='hot' WHERE characterId=?", [unchangedId]]);
        Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [unchangedId]]))[0]);
        await Database.execute(["UPDATE bot_life_state SET phase='cold',level=11 WHERE characterId=?", [unchangedId]]);
        Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [unchangedId]]))[0]);
        assert.equal(Life.pendingClassProgressionMigration(), 1, 'a later cold entry joins once');
        let settle;
        const blocker = Life.serializeClanLevelUp(unchangedId, () => new Promise(resolve => { settle = resolve; }));
        await Promise.resolve();
        const beforeBusy = attempted;
        assert.equal((await Life.migrateLegacyClassProgression()).length, 0);
        assert.equal(attempted, beforeBusy, 'busy candidates do not read the native row');
        assert.equal(Life.pendingClassProgressionMigration(), 1, 'busy candidates remain queued');
        settle(); await blocker; await Life.settleWrites([unchangedId]);
        assert.equal((await Life.migrateLegacyClassProgression()).length, 0, 'a candidate already trained is unchanged');
        assert.equal(Life.pendingClassProgressionMigration(), 0);
        const once = attempted;
        await Life.migrateLegacyClassProgression();
        assert.equal(attempted, once, 'unchanged candidates are never retried');

        const raisedId = ids[8];
        await Database.execute(['UPDATE characters SET level=11,sp=1000 WHERE id=?', [raisedId]]);
        await Database.execute(['UPDATE bot_life_state SET level=11,sp=1000 WHERE characterId=?', [raisedId]]);
        const raised = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [raisedId]]))[0]);
        assert.equal(Life.pendingClassProgressionMigration(), 0, 'ordinary cold commits are trained by their existing path');
        const trained = await Life.reviewTrainingAfterCommit(raised);
        assert.equal(trained.stats.classProgressionLevel, 11);
        console.log('test_cold_class_migration_queue: 7/12 in two batches, unchanged once, later cold entry and postcommit training passed');
    } finally {
        global.setInterval = interval; global.clearInterval = clear;
        Books.needsTraining = needs; Database.execute = execute;
        Population.started = false; Population.classProgressionMigrationTimer = null;
        await world.close();
    }
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
