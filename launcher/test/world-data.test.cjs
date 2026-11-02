'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Controller } = require('../main/controller.cjs');
const { prepareWorld, query } = require('./world-fixture.cjs');

test('desktop world tools share saves, restore the world/history pair, respect locks and apply all wipe scopes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-desktop-world-'));
    const root = path.join(directory, 'server');
    const put = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); };
    put('package.json', '{"version":"0.1.0"}');
    put('config/default.ini', '[Database]\npath = tmp/unused.sqlite\n');
    put('config/local.ini', '');
    put('scripts/run-server.js', "console.log('GameServer :: successful init');process.on('message',m=>{if(m.type==='shutdown')process.exit(0)});process.on('disconnect',()=>process.exit(0));");
    put('scripts/geodata-release.json', '{}');
    put('scripts/geodata-bootstrap.js', 'module.exports={async inspectDirectory(){return {valid:true}},async ensureGeodata(){return {valid:true}}};');
    prepareWorld(root, process.execPath);
    const controller = new Controller({ userData: path.join(directory, 'profile'), nodePath: process.execPath });
    const read = sql => query(root, process.execPath, sql);
    try {
        await controller.choose(root);
        assert.equal(controller.state.world.supported, true);
        assert.equal(controller.state.world.databaseExists, true);
        assert.deepEqual(controller.state.world.backups, []);
        await controller.backup('create', { name: 'Before wipe' });
        const saved = controller.state.world.backups[0];
        assert.equal(saved.name, 'Before wipe');
        const metadata = JSON.parse(fs.readFileSync(path.join(root, 'tmp/saves', saved.id, 'save.json')));
        assert.equal(metadata.hasHistory, true, 'custom history path must be backed up');
        read('UPDATE characters SET level = 70 RETURNING id');
        query(root, process.execPath, "UPDATE bot_life_events SET summary = 'changed' RETURNING id", true);
        await assert.rejects(controller.backup('load', { id: saved.id }), /Confirm/);
        assert.equal(read('SELECT level FROM characters LIMIT 1')[0].level, 70);
        await controller.backup('load', { id: saved.id, confirmed: true });
        assert.equal(read('SELECT level FROM characters LIMIT 1')[0].level, 1);
        assert.equal(query(root, process.execPath, 'SELECT summary FROM bot_life_events LIMIT 1', true)[0].summary, 'original');
        await assert.rejects(controller.backup('delete', { id: saved.id }), /Confirm/);
        await assert.rejects(controller.backup('load', { id: '../../escape', confirmed: true }), /Invalid save ID/);
        const unlock = await controller.guard();
        try {
            await assert.rejects(controller.backup('create'), /database is in use/);
            await assert.rejects(controller.backup('load', { id: saved.id, confirmed: true }), /database is in use/);
            await assert.rejects(controller.wipe('all', 'WIPE ALL'), /database is in use/);
        } finally { await unlock(); }
        await controller.start();
        try {
            await assert.rejects(controller.backup('create'), /Stop the server/);
            await assert.rejects(controller.backup('delete', { id: saved.id, confirmed: true }), /Stop the server/);
            await assert.rejects(controller.wipe('all', 'WIPE ALL'), /Stop the server/);
        } finally { await controller.stop(); }
        await assert.rejects(controller.wipe('all', 'WIPE BOTS'), /Type WIPE ALL/);
        assert.equal(read('SELECT COUNT(*) n FROM characters')[0].n, 2);
        for (const scope of ['bots', 'players', 'all']) {
            await controller.wipe(scope, `WIPE ${scope.toUpperCase()}`);
            assert.equal(controller.state.world.result.characters, scope === 'all' ? 2 : 1);
            const survivors = read('SELECT username FROM accounts');
            assert.deepEqual(survivors.map(row => row.username), scope === 'all' ? [] : [scope === 'bots' ? 'player_fixture' : 'bot_fixture']);
            assert.equal(query(root, process.execPath, 'SELECT COUNT(*) n FROM bot_life_events', true)[0].n, scope === 'all' ? 0 : 1);
            assert.equal(controller.state.world.backups.length, 1, 'wipe must keep backups');
            await controller.backup('load', { id: saved.id, confirmed: true });
        }
        await controller.backup('delete', { id: saved.id, confirmed: true });
        assert.equal(controller.state.world.backups.length, 0);
        assert.equal(read('SELECT COUNT(*) n FROM characters')[0].n, 2, 'deleting a backup must keep the current world');
        assert.equal(fs.existsSync(path.join(root, 'tmp/unused.sqlite')), false);
        await controller.saveSettings([{section: 'Database', key: 'path', value: 'tmp/new-world.sqlite'}]);
        assert.equal(controller.state.world.databaseExists, false, 'changing the database path must refresh world controls');
    } finally { await controller.stop(); fs.rmSync(directory, {recursive:true,force:true}); }
});
