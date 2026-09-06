'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('worker_threads');
const SavedGames = require('../scripts/saved-games');
const { acquireDatabaseAccess } = require('../scripts/database-access');

const rootDir = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-saves-'));
const databasePath = path.join(temp, 'world.sqlite');
const savesDir = path.join(temp, 'saves');
const run = (operation, extra = {}) => SavedGames.run({ operation, databasePath, savesDir, ...extra });

function simulateCopyFailure(operation, id) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const fs = require('fs');
            fs.copyFileSync = (_source, target) => {
                fs.writeFileSync(target, 'partial copy');
                throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
            };
            require(require('worker_threads').workerData.modulePath);
        `, { eval: true, workerData: { operation, id, databasePath, savesDir, modulePath: require.resolve('../scripts/saved-games') } });
        let message;
        worker.on('message', (value) => { message = value; });
        worker.once('error', reject);
        worker.once('exit', () => resolve(message));
    });
}

function readWorld() {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
        return ['accounts', 'characters', 'items', 'bot_life_state'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    } finally { db.close(); }
}

async function testApi() {
    const net = require('net');
    const port = await new Promise((resolve) => {
        const socket = net.createServer();
        socket.listen(0, '127.0.0.1', () => {
            const value = socket.address().port;
            socket.close(() => resolve(value));
        });
    });
    const configFile = path.join(temp, 'instance.ini');
    const sharedFile = path.join(temp, 'shared.ini');
    fs.writeFileSync(sharedFile, `[Database]\npath = ${databasePath}\n[AI]\nenabled = false\n`);
    fs.writeFileSync(configFile, '[WorldObserver]\nport = 0\n');
    const child = spawn(process.execPath, ['scripts/start.js'], {
        cwd: rootDir,
        env: {
            ...process.env, L2NODE_LAUNCHER_PORT: String(port), L2NODE_NO_BROWSER: '1',
            L2NODE_SHARED_CONFIG_FILE: sharedFile, L2NODE_CONFIG_FILE: configFile,
            L2NODE_RUNTIME_DIR: temp
        },
        stdio: 'ignore'
    });
    const request = async (route, payload) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, payload === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        return { status: response.status, body: await response.json() };
    };
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { await request('/api/status'); ready = true; break; } catch (_) {
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
        }
        assert(ready, 'test launcher must become ready');
        const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
        assert(html.includes('Saved Games'));
        assert(html.includes('window.confirm(prompt)'));
        const created = await request('/api/saves/create', { name: 'API <save>' });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(created.body.save.name, 'API <save>');
        assert(fs.existsSync(path.join(savesDir, created.body.save.id, 'database.sqlite')), 'runtime directory and shared database config must be respected');
        const id = created.body.save.id;
        const count = (await request('/api/saves')).body.saves.length;
        assert.strictEqual((await request('/api/saves/load', { id })).status, 400);
        assert.strictEqual((await request('/api/saves/delete', { id })).status, 400);
        assert.strictEqual((await request('/api/saves/load', { id: '../world.sqlite', confirmed: true })).status, 400);
        assert.strictEqual((await request('/api/saves/create', { name: 'x'.repeat(121) })).status, 400);

        const release = acquireDatabaseAccess(databasePath);
        try {
            assert.strictEqual((await request('/api/saves/create', {})).status, 409);
            assert.strictEqual((await request('/api/saves/load', { id, confirmed: true })).status, 409);
            assert.strictEqual((await request('/api/saves/delete', { id, confirmed: true })).status, 409);
            assert.strictEqual((await request('/api/start', {})).status, 409);
            assert.strictEqual((await request('/api/wipe', { scope: 'all', confirmation: 'WIPE ALL' })).status, 409);
        } finally { release(); }

        assert.strictEqual((await request('/api/saves/load', { id, confirmed: true })).status, 200);
        assert.strictEqual((await request('/api/status')).body.phase, 'stopped');
        assert.strictEqual((await request('/api/saves')).body.saves.length, count, 'loading must never create an automatic save');
        assert.strictEqual((await request('/api/saves/delete', { id, confirmed: true })).status, 200);
        assert.strictEqual((await request('/api/saves')).body.saves.length, count - 1);
    } finally {
        if (child.exitCode === null) {
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill();
            await exited;
        }
    }
}

(async () => {
    try {
        assert.deepStrictEqual(await SavedGames.list(savesDir), []);
        await assert.rejects(run('create'), /No game database/);
        assert(!fs.existsSync(databasePath), 'saving a missing database must not create it');

        // Simulate an unclean process exit with committed data still in WAL.
        execFileSync(process.execPath, ['-e', `
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(process.argv[1]);
            db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
            for (const table of ['accounts', 'characters', 'items', 'bot_life_state']) {
                db.exec('CREATE TABLE ' + table + ' (id INTEGER PRIMARY KEY, value TEXT)');
                db.prepare('INSERT INTO ' + table + ' VALUES (1, ?)').run(table + '-original');
            }
            process.exit(0);
        `, databasePath], { stdio: 'ignore' });
        assert(fs.statSync(`${databasePath}-wal`).size > 0);
        const original = readWorld();
        const first = await run('create', { name: 'Before +16 / ../ 😀' });
        assert.strictEqual(first.name, 'Before +16 / ../ 😀');
        assert(first.sizeBytes > 0);
        const second = await run('create', { name: first.name });
        assert.notStrictEqual(first.id, second.id, 'duplicate names must be independent snapshots');
        const unnamed = await run('create', { name: '   ' });
        assert.match(unnamed.name, /^Save — /);
        assert.strictEqual((await SavedGames.list(savesDir))[0].id, unnamed.id);

        const db = new DatabaseSync(databasePath);
        db.exec("PRAGMA journal_mode = WAL; UPDATE characters SET value = 'changed'; DROP TABLE items;");
        db.close();
        await run('load', { id: first.id });
        assert.deepStrictEqual(readWorld(), original, 'all tables and original values must be restored');
        assert.strictEqual((await SavedGames.list(savesDir)).length, 3, 'restore creates no automatic snapshot');

        const currentBytes = fs.readFileSync(databasePath);
        fs.writeFileSync(path.join(savesDir, second.id, 'database.sqlite'), 'damaged save');
        await assert.rejects(run('load', { id: second.id }), /not a valid SQLite/);
        assert.deepStrictEqual(fs.readFileSync(databasePath), currentBytes, 'invalid saves must not touch the current database');
        await assert.rejects(run('delete', { id: '../../world.sqlite' }), /Invalid save ID/);
        await assert.rejects(run('load', { id: '11111111-1111-4111-8111-111111111111' }), /Save not found/);
        assert(!fs.readdirSync(temp).some((name) => name.endsWith('.loading')), 'failed loads must clean up temporary files');
        await run('delete', { id: second.id });

        const beforeFailure = fs.readFileSync(databasePath);
        assert.match((await simulateCopyFailure('create')).error, /No space left/);
        assert.match((await simulateCopyFailure('load', first.id)).error, /No space left/);
        assert.deepStrictEqual(fs.readFileSync(databasePath), beforeFailure, 'partial copies must not replace the current database');
        assert(!fs.readdirSync(savesDir).some((name) => name.endsWith('.pending')));
        assert(!fs.readdirSync(temp).some((name) => name.endsWith('.loading')));

        const busy = new DatabaseSync(databasePath);
        busy.exec('PRAGMA journal_mode = WAL;');
        busy.prepare('SELECT * FROM accounts').all();
        try {
            await assert.rejects(run('create'), /still in use/, 'an idle connection from an older server must block saves too');
            busy.exec('BEGIN IMMEDIATE;');
            await assert.rejects(run('create'), /still in use/);
            await assert.rejects(run('load', { id: first.id }), /still in use/);
        } finally { busy.close(); }
        const release = acquireDatabaseAccess(databasePath);
        try {
            await assert.rejects(run('create'), /database is in use/);
            const configFile = path.join(temp, 'locked.ini');
            fs.writeFileSync(configFile, `[Database]\npath = ${databasePath}\n`);
            assert.throws(() => execFileSync(process.execPath, ['src/NodeL2.js'], {
                cwd: rootDir, env: { ...process.env, L2NODE_CONFIG_FILE: configFile }, stdio: 'pipe'
            }), (error) => error.stderr.toString().includes('database is in use'), 'direct server startup must respect the save lock');
        } finally { release(); }

        execFileSync(process.execPath, ['-e', `
            require(process.argv[1]).acquireDatabaseAccess(process.argv[2]);
            process.exit(0);
        `, require.resolve('../scripts/database-access'), databasePath], { stdio: 'ignore' });
        acquireDatabaseAccess(databasePath)(); // Crash/exit cannot leave a stale lock.

        const otherDatabase = path.join(temp, 'other.sqlite');
        await assert.rejects(SavedGames.run({ operation: 'load', databasePath: otherDatabase, savesDir: path.join(temp, 'other-saves'), id: first.id }), /Save not found/);
        fs.unlinkSync(databasePath);
        await run('load', { id: first.id });
        assert.deepStrictEqual(readWorld(), original, 'a save can restore a missing database');
        await testApi();
        console.log('saved games: WAL recovery, full restore, manual-only saves, validation, locking and launcher API ok');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
