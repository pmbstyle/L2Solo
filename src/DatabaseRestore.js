'use strict';

// A stopped save load replaces two files separately. Keep the previous pair
// until a durable marker confirms installation; startup rolls an interrupted
// installation back before opening either database. Rollback copies survive
// interrupted rollback too. This is recovery, not a transaction across files.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASES = new Set(['installing', 'committed', 'rolled_back']);

function flushFile(file) {
    const fd = fs.openSync(file, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function flushDirectory(directory) {
    // Windows does not expose directory fsync through this API.
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function markerPath(worldPath) {
    return `${worldPath}.restore.json`;
}

function files(file, id) {
    return { previous: `${file}.${id}.rollback`, next: `${file}.${id}.loading`, recovery: `${file}.${id}.recovering` };
}

function removeDatabaseFiles(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
}

function validateDatabase(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const rows = db.prepare('PRAGMA quick_check').all();
        if (rows.length !== 1 || rows[0].quick_check !== 'ok') throw new Error('Restore database integrity check failed.');
    } finally { db.close(); }
}

function readMarker(worldPath, historyPath) {
    const marker = JSON.parse(fs.readFileSync(markerPath(worldPath), 'utf8'));
    if (marker.version !== 1 || !OPERATION_ID.test(marker.id) || !PHASES.has(marker.phase)
        || marker.historyPath !== path.resolve(historyPath)
        || typeof marker.hadWorld !== 'boolean' || typeof marker.hadHistory !== 'boolean') {
        throw new Error('Invalid database restore marker or history path.');
    }
    return marker;
}

function publish(worldPath, marker) {
    const file = markerPath(worldPath);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(marker));
    flushFile(temporary);
    fs.renameSync(temporary, file);
    flushDirectory(path.dirname(file));
}

function cleanup(worldPath, marker) {
    for (const file of [worldPath, marker.historyPath]) {
        const paths = files(file, marker.id);
        for (const extra of Object.values(paths)) removeDatabaseFiles(extra);
        flushDirectory(path.dirname(file));
    }
    fs.rmSync(`${markerPath(worldPath)}.tmp`, { force: true });
    fs.rmSync(markerPath(worldPath), { force: true });
    flushDirectory(path.dirname(worldPath));
}

function restoreFile(file, id, existed) {
    const paths = files(file, id);
    if (existed) {
        // Copy instead of consuming the rollback file: every restart can
        // repeat restoration of both members of the pair.
        removeDatabaseFiles(paths.recovery);
        fs.copyFileSync(paths.previous, paths.recovery, fs.constants.COPYFILE_EXCL);
        flushFile(paths.recovery);
        fs.renameSync(paths.recovery, file);
        for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
    } else removeDatabaseFiles(file);
    flushDirectory(path.dirname(file));
}

function rollback(worldPath, marker) {
    // Check both rollback sources before changing either destination.
    for (const [file, existed] of [[worldPath, marker.hadWorld], [marker.historyPath, marker.hadHistory]]) {
        if (existed) validateDatabase(files(file, marker.id).previous);
    }
    // A failure while publishing committed may have renamed the marker but
    // not finished its directory flush. Persist rollback intent first.
    if (marker.phase !== 'installing') {
        marker = { ...marker, phase: 'installing' };
        publish(worldPath, marker);
    }
    restoreFile(worldPath, marker.id, marker.hadWorld);
    restoreFile(marker.historyPath, marker.id, marker.hadHistory);
    publish(worldPath, { ...marker, phase: 'rolled_back' });
    cleanup(worldPath, marker);
}

function recover(worldPath, historyPath) {
    worldPath = path.resolve(worldPath);
    historyPath = path.resolve(historyPath);
    if (!fs.existsSync(markerPath(worldPath))) return false;
    const marker = readMarker(worldPath, historyPath);
    if (marker.phase === 'installing') rollback(worldPath, marker);
    else cleanup(worldPath, marker);
    return true;
}

// Both current files have already been checkpointed and closed under the
// caller's shared access lock. Prepared replacements use the same operation id.
function install(worldPath, historyPath, id, hasHistory) {
    worldPath = path.resolve(worldPath);
    historyPath = path.resolve(historyPath);
    if (!OPERATION_ID.test(id) || worldPath === historyPath) throw new Error('Invalid database restore paths.');
    if (fs.existsSync(markerPath(worldPath))) throw new Error('An earlier database restore needs recovery.');
    let marker = { version: 1, id, historyPath, phase: 'installing',
        hadWorld: fs.existsSync(worldPath), hadHistory: fs.existsSync(historyPath) };
    let published = false;
    let committed = false;
    try {
        for (const [file, existed] of [[worldPath, marker.hadWorld], [historyPath, marker.hadHistory]]) {
            if (!existed) continue;
            const previous = files(file, id).previous;
            fs.copyFileSync(file, previous, fs.constants.COPYFILE_EXCL);
            flushFile(previous);
            flushDirectory(path.dirname(file));
        }
        publish(worldPath, marker);
        published = true;
        fs.renameSync(files(worldPath, id).next, worldPath);
        flushDirectory(path.dirname(worldPath));
        if (hasHistory) fs.renameSync(files(historyPath, id).next, historyPath);
        else removeDatabaseFiles(historyPath);
        flushDirectory(path.dirname(historyPath));
        marker = { ...marker, phase: 'committed' };
        publish(worldPath, marker);
        committed = true;
    } catch (error) {
        // Publishing installing may have succeeded before its directory
        // flush failed. Treat an existing marker as published too.
        if (published || fs.existsSync(markerPath(worldPath))) {
            try { rollback(worldPath, marker); } catch (recoveryError) {
                throw new Error(`Database restore failed (${error.message}); rollback needs recovery (${recoveryError.message}).`, { cause: error });
            }
        } else {
            for (const file of [worldPath, historyPath]) removeDatabaseFiles(files(file, id).previous);
            fs.rmSync(`${markerPath(worldPath)}.tmp`, { force: true });
        }
        throw error;
    } finally {
        // Once committed the new pair is complete. Cleanup failure leaves a
        // committed marker; startup retries cleanup without rolling it back.
        if (committed) {
            try { cleanup(worldPath, marker); } catch (_) { /* retained marker owns remaining recovery files */ }
        }
    }
}

module.exports = { files, flushDirectory, flushFile, install, markerPath, recover };
