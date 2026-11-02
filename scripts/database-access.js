'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function canonicalDatabasePath(file) {
    const absolute = path.resolve(file);
    try { return fs.realpathSync(absolute); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(absolute);
        if (parent === absolute) throw error;
        return path.join(canonicalDatabasePath(parent), path.basename(absolute));
    }
}

function verifyUpdateDatabasePaths(root, config, expected) {
    if (!Array.isArray(expected) || expected.length !== 2) throw new Error('Invalid launcher update database snapshot.');
    const world = path.resolve(root, config?.path || 'tmp/nodel2.sqlite');
    const paths = [world, config?.historyPath ? path.resolve(root, config.historyPath)
        : world.endsWith('.sqlite') ? `${world.slice(0, -7)}.history.sqlite` : `${world}.history.sqlite`];
    return paths.map((file, index) => {
        const snapshot = expected[index];
        const canonical = canonicalDatabasePath(file);
        if (snapshot?.path !== file || snapshot.canonicalPath !== canonical) throw new Error('Database paths changed before update startup. Restore the original world and history database paths.');
        const stat = fs.existsSync(canonical) ? fs.statSync(canonical, { bigint: true }) : null;
        if (snapshot.existed !== Boolean(stat) || snapshot.identity && (snapshot.identity.device !== String(stat?.dev) || snapshot.identity.inode !== String(stat?.ino))) {
            throw new Error('The world or history database was replaced before update startup.');
        }
        return canonical;
    });
}

function writeUpdatePhase(root, expected, phase) {
    if (!Array.isArray(expected)) return false;
    const file = path.join(root, '.l2solo/transaction.json');
    if (!fs.existsSync(file)) return false;
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.phase !== 'starting' || !expected.every((entry, index) => entry.path === journal.databaseBackup?.files?.[index]?.path)) return false;
    if (phase === 'migrating' && journal.startupProtocolVersion !== 2) return false;
    const temporary = `${file}.${phase}-${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify({ ...journal, phase }), { mode: 0o600 });
        const fd = fs.openSync(temporary, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return true;
}

function rejectUpdateBeforeMigrations(root, expected) {
    writeUpdatePhase(root, expected, 'rejected');
}

function beginUpdateMigrations(root, expected) {
    // This durable marker is written under the world access lock, before any
    // world database is opened. A crash before it must never restore old data.
    if (!writeUpdatePhase(root, expected, 'migrating')) throw new Error('The launcher has not authorized database migrations for this update.');
}

// A separate SQLite lock survives database replacement and is released by the OS
// even after a crash. Keep this file: unlinking it would split the lock domain.
function acquireDatabaseAccess(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const canonicalPath = fs.existsSync(databasePath)
        ? fs.realpathSync(databasePath)
        : path.join(fs.realpathSync(path.dirname(databasePath)), path.basename(databasePath));
    const lock = new DatabaseSync(`${canonicalPath}.access.sqlite`);
    try {
        lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    } catch (error) {
        lock.close();
        if (/locked|busy/i.test(error.message)) {
            throw Object.assign(new Error('The database is in use. Stop the server and wait for any database operation to finish.'), { statusCode: 409 });
        }
        throw error;
    }
    return () => lock.close();
}

module.exports = { acquireDatabaseAccess, verifyUpdateDatabasePaths, rejectUpdateBeforeMigrations, beginUpdateMigrations };
