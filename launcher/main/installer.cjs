'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const extract = require('extract-zip');
const { readJson, writeJson, sha256, safeDestination, managedPath } = require('./files.cjs');
const { download, validateManifest } = require('./releases.cjs');
const { readConfig } = require('./config.cjs');

const markerPath = root => path.join(root, '.l2solo', 'installation.json');
const journalPath = root => path.join(root, '.l2solo', 'transaction.json');

function needsDatabaseRollback(journal) {
    if (!journal?.databaseBackup || ['committed', 'rejected'].includes(journal.phase)) return false;
    return journal.startupProtocolVersion === 2 ? ['migrating', 'recovering'].includes(journal.phase) : true;
}

async function verifyLegacyRecovery(journal) {
    for (const file of journal.databaseBackup.files) {
        const filename = file.canonicalPath || file.path;
        let stat;
        try { stat = await fs.promises.stat(filename, { bigint: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (file.existed !== Boolean(stat) || file.identity && (file.identity.device !== String(stat?.dev) || file.identity.inode !== String(stat?.ino))
            || file.existed && !file.identity && await sha256(filename) !== file.sha256) {
            throw new Error('The databases changed outside the legacy update. Automatic recovery stopped without changing files; keep the current databases and pending snapshot.');
        }
    }
}

async function recover(root, log = () => {}, { restoreDatabases, keepPending = false } = {}) {
    const journal = await readJson(journalPath(root));
    if (!journal) return;
    if (!/^[a-f0-9-]{36}$/.test(journal.id) || !Array.isArray(journal.operations)) throw new Error('Invalid installation recovery journal.');
    if (journal.phase === 'committed') { await fs.promises.rm(journalPath(root)); return; }
    if (journal.phase === 'awaiting-start' && keepPending) return;
    const restoreWorld = needsDatabaseRollback(journal);
    if (restoreWorld && !restoreDatabases) throw new Error('Database recovery is required before this update can continue.');
    if (restoreWorld && journal.phase !== 'recovering') {
        if (journal.startupProtocolVersion !== 2) await verifyLegacyRecovery(journal);
        // Once recovery starts, replacement inodes belong to this rollback;
        // resuming a partially restored pair must repeat the same operation.
        await writeJson(journalPath(root), { ...journal, phase: 'recovering' });
    }
    const backup = path.join(root, '.l2solo', 'backups', journal.id);
    log('Recovering an interrupted server update…');
    for (const operation of journal.operations) {
        const destination = await safeDestination(root, operation.path);
        if (operation.existed) {
            const original = path.join(backup, operation.path);
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            await fs.promises.copyFile(original, destination);
        } else await fs.promises.rm(destination, { force: true });
    }
    if (restoreWorld) await restoreDatabases(journal);
    if (journal.previous) await writeJson(markerPath(root), journal.previous);
    else await fs.promises.rm(markerPath(root), { force: true });
    await fs.promises.rm(journalPath(root));
    log('Previous server files restored.');
}

async function commitRelease(root) {
    const journal = await readJson(journalPath(root));
    if (!journal) return;
    // Persist acceptance before opening the game ports to players. Recovery
    // must never restore an older world after new gameplay has been accepted.
    await writeJson(journalPath(root), { ...journal, phase: 'committed' });
    await fs.promises.rm(journalPath(root)).catch(() => {});
}

async function extractRelease(archive, stage, manifest) {
    const files = new Map(manifest.files.map(file => [file.path, file]));
    const seen = new Set();
    await extract(archive, {
        dir: stage,
        onEntry(entry) {
            const name = entry.fileName;
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Release archives must not contain symbolic links.');
            if (name.endsWith('/')) {
                const directory = name.slice(0, -1);
                managedPath(`${directory}/placeholder`);
                if (!manifest.files.some(file => file.path.startsWith(name))) throw new Error(`Unexpected archive directory: ${name}`);
                return;
            }
            const file = files.get(name);
            if (!file || seen.has(name) || entry.uncompressedSize !== file.bytes) throw new Error(`Unexpected archive file: ${name}`);
            seen.add(name);
        }
    });
    for (const file of manifest.files) {
        const filename = path.join(stage, file.path);
        if (!seen.has(file.path) || await sha256(filename) !== file.sha256) throw new Error(`Release file checksum mismatch: ${file.path}`);
    }
}

async function stageRelease(cache, release, progress = () => {}, fetcher = fetch) {
    validateManifest(release.manifest, release.tag);
    await fs.promises.mkdir(cache, { recursive: true });
    const complete = path.join(cache, release.manifest.archive.sha256);
    try {
        for (const file of release.manifest.files) {
            const filename = await safeDestination(complete, file.path);
            if ((await fs.promises.stat(filename)).size !== file.bytes || await sha256(filename) !== file.sha256) throw new Error('Cached server file checksum mismatch.');
        }
        return complete;
    } catch { /* An incomplete or damaged download is replaced, never applied. */ }
    const stage = await fs.promises.mkdtemp(path.join(cache, '.download-'));
    const archive = `${stage}.zip`;
    try {
        await download(release.archiveUrl, archive, release.manifest.archive, (ratio, bytes, total) =>
            progress({ label: 'Downloading server release', percent: ratio * 90, bytes, total }), fetcher);
        progress({ label: 'Verifying server download', percent: 92 });
        await extractRelease(archive, stage, release.manifest);
        await fs.promises.rm(complete, { recursive: true, force: true });
        await fs.promises.rename(stage, complete);
        progress({ label: 'Server update downloaded', percent: 100 });
        return complete;
    } finally {
        await fs.promises.rm(stage, { recursive: true, force: true });
        await fs.promises.rm(archive, { force: true });
    }
}

async function applyRelease(root, stage, manifest, progress = () => {}, options = {}) {
    validateManifest(manifest, manifest.tag);
    const previous = await readJson(markerPath(root));
    const config = fs.existsSync(path.join(root, 'config/default.ini')) ? readConfig(root) : readConfig(stage);
    const databasePath = path.resolve(root, config.Database?.path || 'tmp/nodel2.sqlite');
    if (previous) validateManifest(previous, previous.tag);
    const operations = [];
    const incoming = new Set(manifest.files.map(file => file.path));
    for (const file of manifest.files) {
        const destination = await safeDestination(root, file.path);
        let stat;
        try { stat = await fs.promises.stat(destination); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && !stat.isFile()) throw new Error(`A directory blocks a release file: ${file.path}`);
        if (stat?.size === file.bytes && await sha256(destination) === file.sha256) continue;
        operations.push({ path: file.path, existed: Boolean(stat), action: 'write' });
    }
    for (const file of previous?.files || []) {
        if (incoming.has(file.path)) continue;
        const destination = await safeDestination(root, file.path);
        // Remove obsolete unmodified release files; retain local additions and edits.
        try {
            if ((await fs.promises.stat(destination)).isFile() && await sha256(destination) === file.sha256) {
                operations.push({ path: file.path, existed: true, action: 'delete' });
            }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const id = crypto.randomUUID();
    const backup = path.join(root, '.l2solo', 'backups', id);
    for (const operation of operations.filter(operation => operation.existed)) {
        const target = path.join(backup, operation.path);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(path.join(root, operation.path), target);
    }
    // Persist the full rollback plan before the first modification. Recovery is
    // idempotent, including a process interruption during recovery itself.
    const databaseBackup = options.trial && operations.length ? await options.snapshotDatabases(id,
        { databasePath, historyPath: config.Database?.historyPath || '', maximumSchemaVersion: manifest.databaseSchemaVersion }) : null;
    await writeJson(journalPath(root), { id, previous, operations, databasePath, databaseBackup,
        startupProtocolVersion: manifest.startupProtocolVersion || 1, phase: 'applying' });
    try {
        let complete = 0;
        for (const operation of operations) {
            const destination = await safeDestination(root, operation.path);
            if (operation.action === 'delete') await fs.promises.rm(destination);
            else {
                await fs.promises.mkdir(path.dirname(destination), { recursive: true });
                await fs.promises.copyFile(path.join(stage, operation.path), destination);
            }
            progress(++complete / operations.length);
        }
        await writeJson(markerPath(root), { ...manifest, installedAt: new Date().toISOString() });
        if (options.trial && operations.length) {
            const journal = await readJson(journalPath(root));
            await writeJson(journalPath(root), { ...journal, phase: 'awaiting-start' });
        } else await commitRelease(root);
    } catch (error) {
        await recover(root, () => {}, options);
        throw error;
    }
    return { changedFiles: operations.length, backup: operations.some(operation => operation.existed) ? backup : null };
}

async function installRelease(root, release, progress, fetcher = fetch, options = {}) {
    const stage = path.join(root, '.l2solo', `staging-${crypto.randomUUID()}`);
    const archive = `${stage}.zip`;
    try {
        progress({ label: 'Checking installed server files', percent: 3 });
        let current = true;
        for (const file of release.manifest.files) {
            const destination = await safeDestination(root, file.path);
            try {
                if ((await fs.promises.stat(destination)).size !== file.bytes || await sha256(destination) !== file.sha256) { current = false; break; }
            } catch (error) { if (error.code === 'ENOENT') { current = false; break; } throw error; }
        }
        if (current) return await applyRelease(root, stage, release.manifest, () => {}, options);
        if (options.cacheDirectory) {
            const prepared = await stageRelease(options.cacheDirectory, release, value => progress({ ...value, percent: 4 + value.percent * 0.5 }), fetcher);
            return await applyRelease(root, prepared, release.manifest, ratio => progress({ label: 'Installing server files', percent: 62 + ratio * 12 }), options);
        }
        progress({ label: 'Downloading server release', percent: 4 });
        await download(release.archiveUrl, archive, release.manifest.archive, (ratio, bytes, total) => {
            progress({ label: 'Downloading server release', percent: 4 + ratio * 50, bytes, total });
        }, fetcher);
        progress({ label: 'Verifying server files', percent: 55 });
        await fs.promises.mkdir(stage);
        await extractRelease(archive, stage, release.manifest);
        progress({ label: 'Installing server files', percent: 62 });
        return await applyRelease(root, stage, release.manifest, ratio => progress({ label: 'Installing server files', percent: 62 + ratio * 12 }), options);
    } finally {
        await fs.promises.rm(stage, { recursive: true, force: true });
        await fs.promises.rm(archive, { force: true });
    }
}

module.exports = { markerPath, journalPath, recover, commitRelease, needsDatabaseRollback, applyRelease, extractRelease, stageRelease, installRelease };
