'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { acquireDatabaseAccess } = require('./database-access');
const HistoryStore = require('../src/HistoryStore');
const Restore = require('../src/DatabaseRestore');

// A save holds the world file and, next to it, the history file
// (src/HistoryStore.js). Saves made before the history file existed hold only
// the world; loading one lets the server move its history tables at start.
const WORLD_FILE = 'database.sqlite';
const HISTORY_FILE = 'history.sqlite';
const SAVE_FORMAT_VERSION = 2;

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
        const databaseFile = path.join(directory, WORLD_FILE);
        if (!fs.lstatSync(databaseFile).isFile()) fail('Invalid save database.');
        const metadataFile = path.join(directory, 'save.json');
        if (!fs.lstatSync(metadataFile).isFile()) fail('Invalid save metadata.');
        const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        validateMetadata(metadata, directory);
        return { id, name: metadata.name, createdAt: metadata.createdAt, sizeBytes: saveBytes(directory) };
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
            const file = await fs.promises.lstat(path.join(directory, WORLD_FILE));
            const metadataFile = path.join(directory, 'save.json');
            if (!file.isFile() || !(await fs.promises.lstat(metadataFile)).isFile()) continue;
            const metadata = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'));
            validateMetadata(metadata, directory);
            saves.push({ id: entry.name, name: metadata.name, createdAt: metadata.createdAt, sizeBytes: saveBytes(directory) });
        } catch (_) { /* Ignore incomplete saves and concurrently deleted entries. */ }
    }
    return saves.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function saveBytes(directory) {
    return [WORLD_FILE, HISTORY_FILE].reduce((sum, name) => {
        try { return sum + fs.statSync(path.join(directory, name)).size; } catch (_) { return sum; }
    }, 0);
}

function validateMetadata(metadata, directory) {
    if (typeof metadata.name !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) fail('Invalid save metadata.');
    if (metadata.formatVersion === undefined) return; // Earlier save metadata.
    if (metadata.formatVersion !== SAVE_FORMAT_VERSION || typeof metadata.hasHistory !== 'boolean') fail('Invalid save format.');
    if (metadata.hasHistory !== fs.existsSync(path.join(directory, HISTORY_FILE))) fail('The save history file is missing or unexpected.');
    const names = [WORLD_FILE, ...(metadata.hasHistory ? [HISTORY_FILE] : [])];
    if (!metadata.files || Object.keys(metadata.files).length !== names.length
        || names.some((name) => !/^[0-9a-f]{64}$/.test(metadata.files[name]))) fail('Invalid save file checksums.');
}

function digestFile(file) {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
        for (;;) {
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!bytes) break;
            hash.update(buffer.subarray(0, bytes));
        }
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

function validateCopies(metadata, worldFile, historyFile) {
    if (metadata.formatVersion === undefined) return;
    for (const [name, file] of [[WORLD_FILE, worldFile], ...(historyFile ? [[HISTORY_FILE, historyFile]] : [])]) {
        if (digestFile(file) !== metadata.files[name]) fail(`The save ${name} checksum does not match.`);
    }
}

function hasTable(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// Older metadata did not describe the pair. Inspect the world too: missing
// history is only valid for a genuine world made before the split.
function validatePair(worldFile, historyFile) {
    const world = new DatabaseSync(worldFile, { readOnly: true });
    let history;
    try {
        const token = hasTable(world, 'world_meta')
            ? String(world.prepare("SELECT value FROM world_meta WHERE key='historyToken'").get()?.value || '') : '';
        const split = !!token || (hasTable(world, 'schema_migrations')
            && !!world.prepare('SELECT 1 FROM schema_migrations WHERE version=50').get());
        if (!split && !historyFile) return;
        if (!token) fail('The save world is missing its history identity.');
        if (!historyFile) fail('The migrated save requires its history file.');
        history = new DatabaseSync(historyFile, { readOnly: true });
        if (!hasTable(history, 'history_meta') || HistoryStore.meta(history, HistoryStore.WORLD_TOKEN_KEY) !== token) {
            fail('The save history belongs to another world.');
        }
        if ([...HistoryStore.MOVED_TABLES, 'clan_actions'].some((table) => !hasTable(history, table))) {
            fail('The save history schema is incomplete.');
        }
        const sequence = hasTable(world, 'sqlite_sequence')
            ? Number(world.prepare("SELECT MAX(seq) AS seq FROM sqlite_sequence WHERE name='history_outbox'").get()?.seq || 0) : 0;
        const cursor = HistoryStore.cursor(history);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > sequence) fail('The save history cursor is ahead of its world.');
        // The initial one-time move raises the outbox sequence above imported
        // AFK/clan event ids without producing outbox rows for those ids. Only
        // a cursor still at zero can have this pre-outbox allocation gap.
        let covered = cursor;
        if (cursor === 0) {
            for (const table of ['afk_trade_events', 'clan_goal_events']) {
                if (hasTable(history, table)) covered = Math.max(covered, Number(history.prepare(`SELECT MAX(id) AS id FROM ${table}`).get()?.id || 0));
            }
            if (covered > sequence) fail('The save history cursor is ahead of its world.');
        }
        const backlog = hasTable(world, 'history_outbox')
            ? Number(world.prepare('SELECT COUNT(*) AS n FROM history_outbox WHERE id>? AND id<=?').get(covered, sequence).n) : 0;
        if (backlog !== sequence - covered) fail('The save history is incomplete and its world outbox cannot replay the missing rows.');
    } finally { history?.close(); world.close(); }
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

function removeDatabaseFiles(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
}

function perform({ operation, databasePath, historyPath = HistoryStore.pathFor(databasePath), savesDir, name, id }) {
    databasePath = path.resolve(databasePath);
    historyPath = path.resolve(historyPath);
    if (databasePath === historyPath) fail('World and history paths must be different.');
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
        Restore.recover(databasePath, historyPath);
        const createdAt = new Date().toISOString();
        id = randomUUID();
        const directory = saveDirectory(savesDir, id);
        const pending = path.join(savesDir, `.${id}.pending`);
        const db = openStoppedDatabase(databasePath);
        let history;
        try {
            history = fs.existsSync(historyPath) ? openStoppedDatabase(historyPath) : null;
            fs.mkdirSync(pending, { recursive: true });
            const copies = [[databasePath, WORLD_FILE], ...(history ? [[historyPath, HISTORY_FILE]] : [])];
            copies.forEach(([source, target]) => {
                const file = path.join(pending, target);
                fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
                validateDatabase(file);
                Restore.flushFile(file);
            });
            validatePair(path.join(pending, WORLD_FILE), history ? path.join(pending, HISTORY_FILE) : null);
            fs.writeFileSync(path.join(pending, 'save.json'), JSON.stringify({
                name: trimmed || `Save — ${new Date(createdAt).toLocaleString('en-GB')}`,
                createdAt, formatVersion: SAVE_FORMAT_VERSION, hasHistory: !!history,
                files: Object.fromEntries(copies.map(([, target]) => [target, digestFile(path.join(pending, target))]))
            }, null, 2));
            Restore.flushFile(path.join(pending, 'save.json'));
            fs.renameSync(pending, directory);
            return readSave(savesDir, id);
        } finally {
            history?.close();
            db.close();
            fs.rmSync(pending, { recursive: true, force: true });
        }
    }
    if (operation === 'load') {
        const save = readSave(savesDir, id);
        const directory = saveDirectory(savesDir, id);
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'save.json'), 'utf8'));
        const savedHistory = path.join(directory, HISTORY_FILE);
        const hasHistory = fs.existsSync(savedHistory);
        const operationId = randomUUID();
        const pending = Restore.files(databasePath, operationId).next;
        const pendingHistory = Restore.files(historyPath, operationId).next;
        let installationStarted = false;
        try {
            fs.copyFileSync(path.join(directory, WORLD_FILE), pending, fs.constants.COPYFILE_EXCL);
            validateDatabase(pending);
            Restore.flushFile(pending);
            fs.mkdirSync(path.dirname(historyPath), { recursive: true });
            if (hasHistory) {
                fs.copyFileSync(savedHistory, pendingHistory, fs.constants.COPYFILE_EXCL);
                validateDatabase(pendingHistory);
                Restore.flushFile(pendingHistory);
            }
            validateCopies(metadata, pending, hasHistory ? pendingHistory : null);
            validatePair(pending, hasHistory ? pendingHistory : null);
            Restore.recover(databasePath, historyPath);
            for (const file of [databasePath, historyPath]) {
                if (!fs.existsSync(file) && (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-journal`))) {
                    fail('A current database is missing but its journal still exists. Restore the database file first.');
                }
            }
            for (const file of [databasePath, historyPath]) {
                if (!fs.existsSync(file)) continue;
                const db = openStoppedDatabase(file);
                db.close();
            }
            // The shared lock remains held after closing SQLite (required on
            // Windows). Startup can roll back an interrupted pair replacement.
            installationStarted = true;
            Restore.install(databasePath, historyPath, operationId, hasHistory);
            return save;
        } finally {
            // A pending marker owns these files until recovery completes.
            if (!installationStarted || !fs.existsSync(Restore.markerPath(databasePath))) {
                for (const file of [pending, pendingHistory]) removeDatabaseFiles(file);
            }
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
