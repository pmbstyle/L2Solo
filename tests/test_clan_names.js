const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Catalog = invoke('GameServer/Clan/ClanNameCatalog');
const Rules = invoke('GameServer/Clan/ClanRules');
const ClanService = invoke('GameServer/Clan/ClanService');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-names-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
const query = (sql, args = []) => Database.execute([sql, args]);

async function character(id, username = 'bot_pop_names', clanId = 0) {
    await query(`INSERT INTO characters
        (id, username, name, clanId, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (?, ?, ?, ?, 4, 0, 40, 500, 250, 0, 0, 0, 0, 100, 100, 0)`,
    [id, username, `RenamedBot${id}`, clanId]);
}

const goal = { type: 'equipment', target: { memberId: 1, itemId: 78 }, status: 'active' };
async function clan(id, name, leaderId, mode = 'autonomous') {
    await query('INSERT INTO clans(id, name, leaderId, level, crestId, allyId, allyName) VALUES (?, ?, ?, 3, 7, 9, ?)',
        [id, name, leaderId, 'ExistingAlly']);
    if (mode) await query(`INSERT INTO clan_simulation_clans(clanId, mode, createdAt, updatedAt, stateJson)
        VALUES (?, ?, 123, 456, ?)`, [id, mode, JSON.stringify({ goal, warehouseRevision: 42, memberIds: [leaderId] })]);
}

async function snapshot() {
    const result = {};
    for (const table of ['clans', 'characters', 'clan_simulation_clans', 'clan_warehouse_items']) {
        result[table] = await query(`SELECT * FROM ${table} ORDER BY rowid`);
    }
    // Goal events live in the history file.
    result.clan_goal_events = await Database.readHistory(['SELECT * FROM clan_goal_events ORDER BY rowid']);
    return result;
}

(async () => {
    assert(Catalog.entries.length >= 150 && Catalog.entries.length <= 300);
    assert.strictEqual(new Set(Catalog.entries.map((entry) => entry.name.toLowerCase())).size, Catalog.entries.length);
    for (const entry of Catalog.entries) {
        assert(Rules.validateClanName(entry.name).ok, `invalid C4 clan name: ${entry.name}`);
        assert(Catalog.sources[entry.source]?.url.startsWith('https://'), `missing source: ${entry.name}`);
    }
    const first = Catalog.select(42);
    assert(Contracts.isReasonCode('name_pool_exhausted'));
    assert.deepStrictEqual(Catalog.select(42), first);
    assert.notStrictEqual(Catalog.select(42, [first.name.toUpperCase()]).name, first.name);
    const occupied = [];
    for (let index = 0; index < Catalog.entries.length; index += 1) occupied.push(Catalog.select(42, occupied).name);
    assert.strictEqual(Catalog.select(42, occupied), null, 'exhaustion must never append counters or reuse a name');

    Database.init();
    await query("INSERT INTO accounts(username, password) VALUES ('bot_pop_names', 'test-only'), ('player', 'test-only')");
    for (let id = 1; id <= 5; id += 1) await character(id, id === 5 ? 'player' : 'bot_pop_names', id);
    await clan(1, 'EloraHeartPledge', 1);
    await clan(2, 'TaliaRowanPledge', 2);
    await clan(3, 'CustomBanner', 3);
    await clan(4, 'PlayerPledge', 4, 'player_managed');
    await clan(5, 'HumanPledge', 5);
    await clan(6, 'Legion', 5, null);
    await clan(7, Catalog.select(1).name.toLowerCase(), 5, null);
    await query(`INSERT INTO clan_warehouse_items(clanId, selfId, amount) VALUES (1, 1864, 123)`);
    await Database.recordHistory('clan_goal_event', { clanId: 1, goalType: 'equipment', eventType: 'created', occurredAt: 123 });
    const before = await snapshot();
    const preview = await Database.migrateAutonomousClanNames({ dryRun: true });
    assert.deepStrictEqual(preview.renamed.map((row) => row.clanId), [1, 2]);
    assert.notStrictEqual(preview.renamed[0].name.toLowerCase(), Catalog.select(1).name.toLowerCase());
    assert.deepStrictEqual(await snapshot(), before, 'preview must not mutate persistent state');

    await query(`CREATE TRIGGER fail_second_rename BEFORE UPDATE OF name ON clans
        WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'rename test failure'); END`);
    await assert.rejects(Database.migrateAutonomousClanNames(), /rename test failure/);
    assert.deepStrictEqual(await snapshot(), before, 'a failed migration rolls back earlier renames and metadata');
    await query('DROP TRIGGER fail_second_rename');

    const migrated = await Database.migrateAutonomousClanNames();
    assert.deepStrictEqual(migrated, preview);
    const after = await snapshot();
    for (const table of ['characters', 'clan_warehouse_items', 'clan_goal_events']) {
        assert.deepStrictEqual(after[table], before[table], `${table} must survive renaming unchanged`);
    }
    for (let index = 0; index < before.clans.length; index += 1) {
        assert.deepStrictEqual({ ...after.clans[index], name: before.clans[index].name }, before.clans[index],
            'IDs, leader, level, crests and alliance must not change');
        if (before.clans[index].id > 2) assert.deepStrictEqual(after.clans[index], before.clans[index]);
    }
    after.clan_simulation_clans.forEach((row, index) => {
        const old = before.clan_simulation_clans[index];
        const state = JSON.parse(row.stateJson);
        if (row.clanId <= 2) {
            assert.strictEqual(state.naming.version, Catalog.VERSION);
            assert.strictEqual(state.naming.previousName, before.clans[index].name);
            delete state.naming;
        }
        assert.deepStrictEqual(state, JSON.parse(old.stateJson), 'goals, membership and warehouse revisions survive');
        assert.deepStrictEqual({ ...row, stateJson: old.stateJson }, old);
    });
    assert.deepStrictEqual(await Database.migrateAutonomousClanNames(), { renamed: [] });
    await query("UPDATE characters SET name = 'NewLeaderNick' WHERE id = 1");
    assert.deepStrictEqual(await Database.migrateAutonomousClanNames(), { renamed: [] }, 'leader renames do not rename clans');
    await query("UPDATE clans SET name = 'ManualPledge' WHERE id = 1");
    assert.deepStrictEqual(await Database.migrateAutonomousClanNames(), { renamed: [] },
        'a versioned clan must not be migrated again even after a custom rename matching the old pattern');
    await query('UPDATE clans SET name = ? WHERE id = 1', [migrated.renamed[0].name]);
    await ClanService.init();
    assert.strictEqual(ClanService.findById(1).name, migrated.renamed[0].name, 'startup cache uses the new name');
    assert.strictEqual(ClanService.findById(6).name, 'Legion');

    for (let id = 100; id < 115; id += 1) await character(id);
    await clan(8, Catalog.select(100).name.toLowerCase(), 5, null);
    const create = (leaderId) => Database.createAutonomousClan({ leaderId,
        memberIds: Array.from({ length: 5 }, (_, index) => leaderId + index), maxBotMemberShare: 1 });
    const created = await Promise.all([create(100), create(105)]);
    assert(created.every((result) => result.ok), JSON.stringify(created));
    const newNames = await query('SELECT name FROM clans WHERE id IN (?, ?)', created.map((result) => result.clanId));
    assert.strictEqual(new Set(newNames.map((row) => row.name.toLowerCase())).size, 2);
    assert(newNames.every((row) => Catalog.entries.some((entry) => entry.name === row.name)));
    assert.notStrictEqual(newNames[0].name.toLowerCase(), Catalog.select(100).name.toLowerCase());
    for (const result of created) {
        const [row] = await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [result.clanId]);
        const naming = JSON.parse(row.stateJson).naming;
        assert.strictEqual(naming.version, Catalog.VERSION);
        assert(Catalog.sources[naming.source]);
    }

    for (const entry of Catalog.entries) await query('INSERT OR IGNORE INTO clans(name, leaderId) VALUES (?, 5)', [entry.name]);
    const full = await snapshot();
    assert.deepStrictEqual(await create(110), { ok: false, code: 'name_pool_exhausted' });
    assert.deepStrictEqual(await snapshot(), full, 'exhaustion must not reserve members or create a partial clan');
    await character(200, 'bot_pop_names', 9999);
    await clan(9999, 'LastPledge', 200);
    const exhausted = await snapshot();
    await assert.rejects(Database.migrateAutonomousClanNames(), /catalog exhausted/);
    assert.deepStrictEqual(await snapshot(), exhausted);
    await ClanService.init();
    assert.strictEqual(ClanService.findById(9999).name, 'LastPledge',
        'a deferred migration must not prevent loading existing clans');
    console.log('Clan naming: sourced catalog, collisions, atomic creation, migration rollback, preservation and idempotence passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
