const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-crest-assets.sqlite');
const Database = invoke('Database');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO clans(id, name, leaderId, level) VALUES (?, ?, ?, ?)').run(6000001, 'CrestAlpha', 1, 3);
    seed.prepare('INSERT INTO clans(id, name, leaderId, level) VALUES (?, ?, ?, ?)').run(6000002, 'CrestBravo', 2, 0);
    const state = JSON.stringify({ level: 0, memberIds: [], goal: null });
    seed.prepare(`INSERT INTO clan_simulation_clans(clanId, version, createdAt, updatedAt, stateJson)
        VALUES (?, 1, 1, 1, ?)` ).run(6000001, state);
    seed.prepare(`INSERT INTO clan_simulation_clans(clanId, version, createdAt, updatedAt, stateJson)
        VALUES (?, 1, 1, 1, ?)` ).run(6000002, state);
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    ClanCrestService.reset();

    try {
        const clanAssets = ClanCrestService.assets('clan');
        const allyAssets = ClanCrestService.assets('ally');
        assert(clanAssets.length >= 200, 'the local clan pack should have enough distinct crests');
        assert(allyAssets.length >= 200, 'the local alliance pack should have enough distinct crests');
        assert(clanAssets.every((asset) => asset.width === 16 && asset.height === 12 && asset.bitsPerPixel === 8));
        assert(allyAssets.every((asset) => asset.width === 8 && asset.height === 12 && asset.bitsPerPixel === 8));
        assert.strictEqual(new Set(clanAssets.map((asset) => fs.readFileSync(path.resolve(rootDir, asset.file)).toString('hex'))).size, clanAssets.length);

        const first = await ClanCrestService.ensureAutonomousClans();
        assert.strictEqual(first.assigned, 1);
        assert.strictEqual(first.cleared, 0);
        const rows = await Database.execute(['SELECT id, crestId FROM clans ORDER BY id', []]);
        assert(Number(rows[0].crestId) > 0, 'level 3 autonomous clan should receive a crest');
        assert.strictEqual(Number(rows[1].crestId), 0, 'clans below level 3 must not receive a crest');

        await Database.execute(['UPDATE clans SET level = 3 WHERE id = ?', [6000002]]);
        const promoted = await ClanCrestService.ensureAutonomousClans();
        assert.strictEqual(promoted.assigned, 1, 'promotion to level 3 should assign a crest');
        const promotedRows = await Database.execute(['SELECT id, crestId FROM clans ORDER BY id', []]);
        assert(promotedRows.every((row) => Number(row.crestId) > 0), 'both level 3 clans should have crests');
        assert.notStrictEqual(Number(promotedRows[0].crestId), Number(promotedRows[1].crestId));

        const second = await ClanCrestService.ensureAutonomousClans();
        assert.strictEqual(second.assigned, 0, 'crest assignment must be restart-safe and idempotent');
        const [crest] = await Database.execute(['SELECT data FROM clan_crests WHERE clanId = ? LIMIT 1', [6000001]]);
        const crestData = Buffer.from(crest.data);
        assert(crestData.length > 54);
        assert.strictEqual(crestData.toString('ascii', 0, 2), 'BM');
        const clientData = ClanCrestService.clientCrestData(crestData, 'clan');
        assert.strictEqual(clientData.length, 16 * 12, 'C4 must receive the raw 16x12 clan crest payload');
        assert.notStrictEqual(clientData.toString('ascii', 0, 2), 'BM', 'C4 payload must not include the BMP header');
        const requested = await ClanService.findSmallCrest(Number(promotedRows[0].crestId));
        assert.strictEqual(requested.data.length, 16 * 12, 'crest request path must normalize legacy BMP rows');
        const packet = ServerResponse.pledgeCrest(requested.id, requested.data);
        assert.strictEqual(packet.readInt32LE(1), requested.id);
        assert.strictEqual(packet.readInt32LE(5), 16 * 12);
        console.log('Clan crest asset checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
