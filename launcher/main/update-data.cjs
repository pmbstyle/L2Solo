'use strict';

// Runs with standalone Node.js while the controller holds the world access lock.
// No server modules are loaded: recovery must also work with half-written code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
function digest(file) {
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
}
const flush = file => { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
function check(file) {
    const db = new DatabaseSync(file);
    try {
        if (Number(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy || 0)) throw new Error('Database is busy.');
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Database integrity check failed.');
    } finally { db.close(); }
}
function checkPair(worldPath, historyPath, maximumSchemaVersion) {
    if (!fs.existsSync(worldPath)) return;
    const world = new DatabaseSync(worldPath, { readOnly: true });
    let token;
    try {
        if (Number.isSafeInteger(maximumSchemaVersion) && world.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get()) {
            const current = Number(world.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version || 0);
            if (current > maximumSchemaVersion) throw new Error(`World database schema ${current} requires a newer server (this release supports ${maximumSchemaVersion}).`);
        }
        if (world.prepare("SELECT 1 FROM sqlite_master WHERE name='world_meta'").get()) token = world.prepare("SELECT value FROM world_meta WHERE key='historyToken'").get()?.value;
    } finally { world.close(); }
    if (!token) return; // Legacy worlds may still contain their own history.
    if (!fs.existsSync(historyPath)) throw new Error('The world is missing its matching history database.');
    const history = new DatabaseSync(historyPath, { readOnly: true });
    try {
        const exists = history.prepare("SELECT 1 FROM sqlite_master WHERE name='history_meta'").get();
        if (!exists || history.prepare("SELECT value FROM history_meta WHERE key='worldToken'").get()?.value !== token) throw new Error('World and history databases do not belong to the same world.');
    } finally { history.close(); }
}
function main() {
    const root = path.resolve(process.argv[2]);
    const action = process.argv[3];
    const options = JSON.parse(process.argv[4]);
    if (!/^[a-f0-9-]{36}$/.test(options.id)) throw new Error('Invalid update backup identifier.');
    const directory = path.join(root, '.l2solo/backups', options.id, 'databases');
    if (action === 'snapshot') {
        fs.mkdirSync(directory, { recursive: true });
        const world = path.resolve(options.databasePath);
        const history = options.historyPath ? path.resolve(root, options.historyPath)
            : world.endsWith('.sqlite') ? `${world.slice(0, -7)}.history.sqlite` : `${world}.history.sqlite`;
        if (world === history) throw new Error('World and history must use different database files.');
        if (fs.existsSync(`${world}.restore.json`)) throw new Error('Start the existing server to recover its interrupted backup restoration before updating.');
        const files = [world, history].map((file, index) => {
            const existed = fs.existsSync(file);
            if (!existed && ['-wal', '-journal'].some(suffix => fs.existsSync(`${file}${suffix}`))) throw new Error('A database is missing but its journal still exists.');
            if (existed) check(file);
            const stat = existed ? fs.statSync(file, { bigint: true }) : null;
            return { path: file, existed, name: index ? 'history.sqlite' : 'world.sqlite',
                identity: stat ? { device: String(stat.dev), inode: String(stat.ino) } : null };
        });
        checkPair(world, history, options.maximumSchemaVersion);
        for (const file of files.filter(file => file.existed)) {
            const target = path.join(directory, file.name);
            fs.copyFileSync(file.path, target, fs.constants.COPYFILE_EXCL);
            check(target); flush(target); file.sha256 = digest(target);
        }
        return { files };
    }
    if (action !== 'restore' || !Array.isArray(options.files) || options.files.length !== 2) throw new Error('Invalid update recovery request.');
    options.files = options.files.map(file => ({ ...file, path: file.canonicalPath || file.path }));
    for (const [index, file] of options.files.entries()) {
        if (!path.isAbsolute(file.path) || file.name !== (index ? 'history.sqlite' : 'world.sqlite')) throw new Error('Invalid database backup path.');
        if (file.existed) {
            const backup = path.join(directory, file.name);
            if (digest(backup) !== file.sha256) throw new Error('Update database backup checksum mismatch.');
            check(backup);
        }
    }
    const restoreMarker = `${options.files[0].path}.restore.json`;
    if (fs.existsSync(restoreMarker)) fs.renameSync(restoreMarker, path.join(directory, 'failed-restore.json'));
    // The file transaction journal remains until both replacements finish.
    // Repeating this action after an interruption restores the same pair.
    for (const file of options.files) {
        for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${file.path}${suffix}`, { force: true });
        if (!file.existed) { fs.rmSync(file.path, { force: true }); continue; }
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        const pending = `${file.path}.launcher-restore`;
        fs.copyFileSync(path.join(directory, file.name), pending);
        flush(pending);
        fs.renameSync(pending, file.path);
    }
    return { restored: true };
}
try { process.send({ type: 'result', result: main() }); }
catch (error) { process.send({ type: 'error', message: error.message }); process.exitCode = 1; }
finally { process.disconnect?.(); }
