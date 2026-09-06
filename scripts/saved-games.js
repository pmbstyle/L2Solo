'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { acquireDatabaseAccess } = require('./database-access');

function fail(message, statusCode = 400) {
    throw Object.assign(new Error(message), { statusCode });
}

function saveDirectory(savesDir, id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(id))) {
        fail('Invalid save ID.');
    }
    return path.join(savesDir, id);
}

function readSave(savesDir, id) {
    const directory = saveDirectory(savesDir, id);
    try {
        if (!fs.lstatSync(directory).isDirectory()) fail('Invalid save directory.');
        const databaseFile = path.join(directory, 'database.sqlite');
        if (!fs.lstatSync(databaseFile).isFile()) fail('Invalid save database.');
        const metadataFile = path.join(directory, 'save.json');
        if (!fs.lstatSync(metadataFile).isFile()) fail('Invalid save metadata.');
        const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        if (typeof metadata.name !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) fail('Invalid save metadata.');
        return { id, name: metadata.name, createdAt: metadata.createdAt, sizeBytes: fs.statSync(databaseFile).size };
    } catch (error) {
        if (error.code === 'ENOENT') fail('Save not found.', 404);
        throw error;
    }
}

async function list(savesDir) {
    let entries;
    try { entries = await fs.promises.readdir(savesDir, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const saves = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
            const directory = saveDirectory(savesDir, entry.name);
            const file = await fs.promises.lstat(path.join(directory, 'database.sqlite'));
            const metadataFile = path.join(directory, 'save.json');
            if (!file.isFile() || !(await fs.promises.lstat(metadataFile)).isFile()) continue;
            const metadata = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'));
            if (typeof metadata.name !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) continue;
            saves.push({ id: entry.name, name: metadata.name, createdAt: metadata.createdAt, sizeBytes: file.size });
        } catch (_) { /* Ignore incomplete saves and concurrently deleted entries. */ }
    }
    return saves.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function validateDatabase(file) {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (header.toString() !== 'SQLite format 3\u0000') fail('The save is not a valid SQLite database.');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const rows = db.prepare('PRAGMA quick_check').all();
        if (rows.length !== 1 || rows[0].quick_check !== 'ok') fail('Database integrity check failed.');
    } finally { db.close(); }
}

function flushFile(file) {
    const fd = fs.openSync(file, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function openStoppedDatabase(file) {
    if (!fs.existsSync(file)) fail('No game database yet. Start and stop the server before saving.', 404);
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA busy_timeout = 0;');
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy) fail('The database is still in use. Stop the server before continuing.', 409);
        // Switching out of WAL also rejects open WAL connections from older
        // servers that do not yet participate in the shared access lock.
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
        return db;
    } catch (error) {
        db.close();
        if (/locked|busy/i.test(error.message)) fail('The database is still in use. Stop the server before continuing.', 409);
        throw error;
    }
}

function perform({ operation, databasePath, savesDir, name, id }) {
    if (operation === 'delete') {
        // A damaged snapshot should still be removable.
        const directory = saveDirectory(savesDir, id);
        if (!fs.existsSync(directory)) fail('Save not found.', 404);
        fs.rmSync(directory, { recursive: true });
        return { id };
    }
    if (operation === 'create') {
        if (name !== undefined && typeof name !== 'string') fail('Save name must be text.');
        const trimmed = (name || '').trim();
        if (trimmed.length > 120) fail('Save name must be 120 characters or fewer.');
        const createdAt = new Date().toISOString();
        id = randomUUID();
        const directory = saveDirectory(savesDir, id);
        const pending = path.join(savesDir, `.${id}.pending`);
        const db = openStoppedDatabase(databasePath);
        try {
            fs.mkdirSync(pending, { recursive: true });
            const file = path.join(pending, 'database.sqlite');
            fs.copyFileSync(databasePath, file, fs.constants.COPYFILE_EXCL);
            validateDatabase(file);
            flushFile(file);
            fs.writeFileSync(path.join(pending, 'save.json'), JSON.stringify({
                name: trimmed || `Save — ${new Date(createdAt).toLocaleString('en-GB')}`,
                createdAt
            }, null, 2));
            flushFile(path.join(pending, 'save.json'));
            fs.renameSync(pending, directory);
            return readSave(savesDir, id);
        } finally {
            db.close();
            fs.rmSync(pending, { recursive: true, force: true });
        }
    }
    if (operation === 'load') {
        const save = readSave(savesDir, id);
        const pending = `${databasePath}.${randomUUID()}.loading`;
        try {
            fs.copyFileSync(path.join(saveDirectory(savesDir, id), 'database.sqlite'), pending, fs.constants.COPYFILE_EXCL);
            validateDatabase(pending);
            flushFile(pending);
            if (fs.existsSync(databasePath)) {
                const db = openStoppedDatabase(databasePath);
                db.close();
            } else if (fs.existsSync(`${databasePath}-wal`) || fs.existsSync(`${databasePath}-journal`)) {
                fail('The current database is missing but its journal still exists. Restore the database file first.');
            }
            // The shared lock remains held after closing SQLite (required on
            // Windows). Rename replaces the database only once the copy is ready.
            fs.renameSync(pending, databasePath);
            return save;
        } finally {
            fs.rmSync(pending, { force: true });
            fs.rmSync(`${pending}-wal`, { force: true });
            fs.rmSync(`${pending}-shm`, { force: true });
        }
    }
    fail('Unknown save operation.');
}

function run(options) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: options });
        let result;
        worker.once('message', (message) => { result = message; });
        worker.once('error', reject);
        worker.once('exit', (code) => {
            if (code !== 0 || !result) reject(new Error('Save operation interrupted.'));
            else if (result.error) reject(Object.assign(new Error(result.error), { statusCode: result.statusCode }));
            else resolve(result.value);
        });
    });
}

if (!isMainThread) {
    let release;
    try {
        release = acquireDatabaseAccess(workerData.databasePath);
        parentPort.postMessage({ value: perform(workerData) });
    } catch (error) {
        parentPort.postMessage({ error: error.message, statusCode: error.statusCode || 500 });
    } finally { release?.(); }
}

module.exports = { list, run };
