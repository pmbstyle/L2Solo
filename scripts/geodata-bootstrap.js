'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const extract = require('extract-zip');

const rootDir = path.resolve(__dirname, '..');
const MANIFEST_NAME = '.l2solo-geodata-manifest.json';
const MARKER_NAME = '.l2solo-geodata.json';
const defaultRelease = require('./geodata-release.json');

function defaultLogger(message) {
    console.info(`Geodata   :: ${message}`);
}

async function inspectDirectory(directory, options = {}) {
    let entries;

    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { valid: false, exists: false, fileCount: 0 };
        throw error;
    }

    const geodataFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.l2j'));
    // Explicit fixture/legacy validation remains available to callers. Normal
    // startup uses a complete manifest rather than a particular pack's sizes.
    if (options.minimumFileCount === undefined && options.requiredFiles === undefined) {
        return inspectManifest(directory, entries, geodataFiles.length, options);
    }
    const requiredFiles = options.requiredFiles || {};
    const minimumFileCount = Number(options.minimumFileCount ?? Object.keys(requiredFiles).length);
    if (geodataFiles.length < minimumFileCount) {
        return { valid: false, exists: true, fileCount: geodataFiles.length };
    }

    for (const [name, expectedSize] of Object.entries(requiredFiles)) {
        try {
            const stat = await fs.promises.stat(path.join(directory, name));
            if (!stat.isFile() || stat.size !== Number(expectedSize)) {
                return { valid: false, exists: true, fileCount: geodataFiles.length, invalidFile: name };
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { valid: false, exists: true, fileCount: geodataFiles.length, invalidFile: name };
            }
            throw error;
        }
    }

    return { valid: true, exists: true, fileCount: geodataFiles.length };
}

async function fileSha256(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

function manifestIdentity(manifest) {
    if (manifest?.schemaVersion !== 1 || manifest.format !== 'L2J' || !Array.isArray(manifest.regions)
        || !manifest.regions.length) return null;
    const seen = new Set();
    for (const row of manifest.regions) {
        if (!row || !/^\d{2}_\d{2}$/.test(row.region) || seen.has(row.region)
            || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
            || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) return null;
        seen.add(row.region);
    }
    const geometry = manifest.interactionGeometry;
    if (geometry && (geometry.file !== 'npc-interaction-geometry.json'
        || !Number.isSafeInteger(geometry.bytes) || geometry.bytes <= 0
        || typeof geometry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(geometry.sha256))) return null;
    const regions = manifest.regions.map(row => [row?.region, row?.bytes, row?.sha256]);
    regions.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify([manifest.schemaVersion, manifest.format, manifest.profile || null, regions,
        geometry ? [geometry.file, geometry.bytes, geometry.sha256] : null]);
}

async function inspectManifest(directory, entries, fileCount, options) {
    const invalid = (reason, invalidFile) => ({ valid: false, exists: true, fileCount, reason, invalidFile });
    const log = options.logger || (() => {});
    const expectedManifest = options.manifest;
    let manifest = expectedManifest, staleManifest = false;
    if (expectedManifest) {
        // The pinned manifest is the source of truth: the local copy may be missing or differ.
        staleManifest = manifestIdentity(await readJson(path.join(directory, MANIFEST_NAME))) !== manifestIdentity(expectedManifest);
    } else {
        try {
            manifest = JSON.parse(await fs.promises.readFile(path.join(directory, MANIFEST_NAME), 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return invalid(`missing ${MANIFEST_NAME}`);
            if (error instanceof SyntaxError) return invalid('invalid geodata manifest JSON');
            throw error;
        }
    }
    if (manifest?.schemaVersion !== 1 || manifest.format !== 'L2J'
        || !Array.isArray(manifest.regions) || !manifest.regions.length) {
        return invalid('unsupported geodata manifest');
    }
    const files = new Map();
    for (const row of manifest.regions) {
        if (!row || !/^\d{2}_\d{2}$/.test(row.region) || files.has(`${row.region}.l2j`)
            || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
            || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) {
            return invalid('invalid or duplicate manifest region');
        }
        files.set(`${row.region}.l2j`, row);
    }
    if (!manifestIdentity(manifest)) return invalid('invalid geodata manifest');
    // Presence and sizes first: a partial pack must not cost a full hash.
    const actual = entries.filter(entry => entry.name.endsWith('.l2j'));
    for (const [name, row] of files) {
        const entry = actual.find(candidate => candidate.name === name);
        if (!entry?.isFile()) return invalid('missing manifest region', name);
        if ((await fs.promises.stat(path.join(directory, name))).size !== row.bytes) return invalid('region size mismatch', name);
    }
    const geometry = manifest.interactionGeometry;
    if (geometry) {
        const entry = entries.find(candidate => candidate.name === geometry.file);
        if (!entry?.isFile()) return invalid('missing interaction geometry', geometry.file);
        if ((await fs.promises.stat(path.join(directory, geometry.file))).size !== geometry.bytes) {
            return invalid('interaction geometry checksum mismatch', geometry.file);
        }
    }
    const extra = actual.filter(entry => !files.has(entry.name)).map(entry => entry.name);
    if (extra.length) log(`warning: not in the geodata manifest, the server still loads them: ${extra.join(', ')}`);
    const valid = { valid: true, exists: true, fileCount, profile: manifest.profile || null };
    if (options.trustStamp && await stampMatches(directory, expectedManifest)) return { ...valid, stamped: true };
    log(`Verifying geodata (${files.size} regions)...`);
    for (const [name, row] of files) {
        if (await fileSha256(path.join(directory, name)) !== row.sha256) return invalid('region checksum mismatch', name);
    }
    if (geometry && await fileSha256(path.join(directory, geometry.file)) !== geometry.sha256) {
        return invalid('interaction geometry checksum mismatch', geometry.file);
    }
    log(`geodata verified: ${files.size} regions match`);
    return { ...valid, staleManifest };
}

// Everything the server reads from a pack: the pinned files and the manifest copy.
async function packStamp(directory, manifest) {
    const names = [...manifest.regions.map(row => `${row.region}.l2j`), MANIFEST_NAME];
    if (manifest.interactionGeometry) names.push(manifest.interactionGeometry.file);
    const files = [];
    for (const name of names) {
        const { size, mtimeMs } = await fs.promises.stat(path.join(directory, name));
        files.push({ name, size, mtimeMs });
    }
    return { identity: crypto.createHash('sha256').update(manifestIdentity(manifest)).digest('hex'), files };
}

async function stampMatches(directory, manifest) {
    const stored = (await readJson(path.join(directory, MARKER_NAME)))?.verified;
    if (!stored) return false;
    try { return JSON.stringify(stored) === JSON.stringify(await packStamp(directory, manifest)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// After a full verify: the pinned manifest in place, then the stamp over the files as they are now.
async function writeMarker(directory, marker, manifest, staleManifest) {
    if (manifest && staleManifest) {
        const temporary = path.join(directory, `${MANIFEST_NAME}.${process.pid}.tmp`);
        await fs.promises.writeFile(temporary, `${JSON.stringify(manifest)}\n`);
        await fs.promises.rename(temporary, path.join(directory, MANIFEST_NAME));
    }
    await fs.promises.writeFile(path.join(directory, MARKER_NAME), `${JSON.stringify({
        ...marker, verified: manifest ? await packStamp(directory, manifest) : undefined
    }, null, 2)}\n`);
}

function openDownload(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(parsed, {
            headers: { 'User-Agent': 'L2Solo-Geodata-Bootstrap/1.0' }
        }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                if (redirects <= 0) {
                    reject(new Error('Too many redirects while downloading geodata'));
                    return;
                }
                resolve(openDownload(new URL(response.headers.location, parsed).toString(), redirects - 1));
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Geodata download failed with HTTP ${response.statusCode}`));
                return;
            }

            response.setTimeout(30000, () => response.destroy(new Error('Geodata download stalled')));
            resolve(response);
        });
        request.on('error', reject);
        request.setTimeout(30000, () => request.destroy(new Error('Geodata download connection timed out')));
    });
}

async function downloadArchive(url, destination, logger) {
    const response = await openDownload(url);
    const expectedBytes = Number(response.headers['content-length'] || 0);
    const hash = crypto.createHash('sha256');
    let receivedBytes = 0;
    let lastReportedPercent = -10;

    logger(`downloading ${url}`);
    const meter = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            receivedBytes += chunk.length;
            if (expectedBytes > 0) {
                const percent = Math.floor(receivedBytes / expectedBytes * 100);
                if (percent >= lastReportedPercent + 10 || percent === 100) {
                    lastReportedPercent = percent;
                    logger(`download ${Math.min(percent, 100)}% (${receivedBytes}/${expectedBytes} bytes)`);
                }
            }
            callback(null, chunk);
        }
    });

    await pipeline(response, meter, fs.createWriteStream(destination, { flags: 'wx' }));
    return { bytes: receivedBytes, sha256: hash.digest('hex') };
}

function assertSafeArchiveEntry(entry) {
    const name = String(entry.fileName || '').replace(/\\/g, '/');
    const segments = name.split('/');
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || segments.includes('..')) {
        throw new Error(`Unsafe geodata archive entry: ${name || '<empty>'}`);
    }
}

function extractProgress(logger) {
    let entries = 0, lastReportedPercent = 0;
    return (entry, zipfile) => {
        assertSafeArchiveEntry(entry);
        const percent = Math.floor(++entries / zipfile.entryCount * 100);
        if (percent >= lastReportedPercent + 10) {
            lastReportedPercent = percent;
            logger(`extract ${percent}% (${entries}/${zipfile.entryCount} entries)`);
        }
    };
}

async function renameWithRetries(source, destination, options = {}) {
    const retries = Number(options.retries ?? 20);
    const retryDelay = Number(options.retryDelay ?? 250);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.promises.rename(source, destination);
            return 'renamed';
        } catch (error) {
            if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) && options.acceptDestination) {
                if (await options.acceptDestination()) return 'destination-ready';
                if (error.code !== 'EPERM') throw error;
            }
            const retryable = ['EBUSY', 'EPERM'].includes(error.code);
            if (!retryable || attempt >= retries) throw error;
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
    }
}

async function extractedGeodataRoot(stagingDirectory, validationOptions) {
    const direct = await inspectDirectory(stagingDirectory, validationOptions);
    if (direct.valid) return { directory: stagingDirectory, inspection: direct };

    const entries = await fs.promises.readdir(stagingDirectory, { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
        const candidate = path.join(stagingDirectory, entry.name);
        const inspection = await inspectDirectory(candidate, validationOptions);
        if (inspection.valid) return { directory: candidate, inspection };
    }

    throw new Error(`Downloaded geodata archive is incomplete: found ${direct.fileCount} .l2j files`);
}

function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

async function readJson(filename) {
    try { return JSON.parse(await fs.promises.readFile(filename, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}

async function writeOwner(directory, owner) {
    const temporary = path.join(directory, `owner-${owner.token}.tmp`);
    await fs.promises.writeFile(temporary, JSON.stringify(owner));
    await fs.promises.rename(temporary, path.join(directory, 'owner.json'));
}

async function acquireInstallLock(target, token, logger) {
    const directory = path.join(path.dirname(target), `.${path.basename(target)}.install-lock`);
    const owner = { pid: process.pid, token };
    const deadline = Date.now() + 30 * 60 * 1000;
    let waitingLogged = false;
    while (Date.now() < deadline) {
        try {
            await fs.promises.mkdir(directory);
            await writeOwner(directory, owner);
            return { directory, owner };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const previous = await readJson(path.join(directory, 'owner.json'));
        if (previous && !waitingLogged) {
            logger(`waiting for another geodata installer to finish (owner pid ${previous.pid})`);
            waitingLogged = true;
        }
        let stat;
        try { stat = await fs.promises.stat(directory); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!processAlive(previous?.pid) && (previous || Date.now() - stat.mtimeMs > 1000)) {
            // Adopt the existing lock through an exclusive recovery claim. The
            // lock directory stays in place until recovery and installation end.
            const claim = path.join(directory, 'recovery');
            let handle;
            try { handle = await fs.promises.open(claim, 'wx'); }
            catch (error) {
                if (error.code === 'ENOENT') continue;
                if (error.code !== 'EEXIST') throw error;
                const recovery = await readJson(claim);
                const currentOwner = await readJson(path.join(directory, 'owner.json'));
                let abandonedClaim = recovery && !processAlive(recovery.pid);
                if (!recovery) {
                    try { abandonedClaim = Date.now() - (await fs.promises.stat(claim)).mtimeMs > 30000; }
                    catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
                }
                if (abandonedClaim && !processAlive(currentOwner?.pid)) {
                    await fs.promises.rm(claim, { force: true });
                }
            }
            if (handle) {
                try { await handle.writeFile(JSON.stringify(owner)); }
                finally { await handle.close(); }
                const latest = await readJson(path.join(directory, 'owner.json'));
                if (processAlive(latest?.pid)) {
                    await fs.promises.rm(claim, { force: true });
                } else {
                    const recoveredOwner = { ...owner, backupPath: latest?.backupPath };
                    await writeOwner(directory, recoveredOwner);
                    await fs.promises.rm(claim, { force: true });
                    const backup = recoveredOwner.backupPath;
                    if (backup && path.dirname(backup) === path.dirname(target)
                        && backup.startsWith(`${target}.backup-`)
                        && !fs.existsSync(target) && fs.existsSync(backup)) {
                        await renameWithRetries(backup, target);
                    }
                    return { directory, owner: recoveredOwner };
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Another geodata installation is still active: ${directory}`);
}

async function activeUsers(target) {
    const directory = path.join(path.dirname(target), `.${path.basename(target)}.users`);
    let files;
    try { files = await fs.promises.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const users = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
        const filename = path.join(directory, file), user = await readJson(filename);
        if (processAlive(user?.pid)) users.push(user.pid);
        else await fs.promises.rm(filename, { force: true });
    }
    return users;
}

// Resolve every existing symlink, including a dangling final link during a
// directory swap. Locks and leases must identify the physical pack, not an alias.
async function canonicalGeodataDirectory(directory) {
    let absolute = path.resolve(directory);
    for (let hop = 0; hop < 40; hop++) {
        const root = path.parse(absolute).root;
        const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
        let resolved = root, redirected = false;
        for (let i = 0; i < parts.length; i++) {
            const next = path.join(resolved, parts[i]);
            let stat;
            try { stat = await fs.promises.lstat(next); }
            catch (error) {
                if (error.code === 'ENOENT') return path.join(next, ...parts.slice(i + 1));
                throw error;
            }
            if (stat.isSymbolicLink()) {
                absolute = path.resolve(resolved, await fs.promises.readlink(next), ...parts.slice(i + 1));
                redirected = true;
                break;
            }
            resolved = next;
        }
        if (!redirected) {
            try { return await fs.promises.realpath(resolved); }
            catch (error) { if (error.code === 'ENOENT') return resolved; throw error; }
        }
    }
    throw new Error('Too many geodata directory symlinks');
}

function releaseGeodataUsage(usageFile, ownerPid = process.pid) {
    if (!usageFile) return;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(usageFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (owner.pid !== ownerPid) return;
    fs.rmSync(usageFile, { force: true });
    // Keep the directory: another wrapper may already be registering its lease.
}

async function transferGeodataUsage(usageFile, childPid) {
    if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error('Invalid geodata child PID');
    const owner = await readJson(usageFile);
    if (owner?.pid !== process.pid) throw new Error('Geodata lease is no longer owned by this wrapper');
    const temporary = `${usageFile}.pending`;
    try {
        await fs.promises.writeFile(temporary, JSON.stringify({ pid: childPid }));
        await fs.promises.rename(temporary, usageFile);
    } finally { await fs.promises.rm(temporary, { force: true }); }
}

async function removeQuietly(filename, recursive, logger) {
    try { await fs.promises.rm(filename, { recursive, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { logger(`cleanup warning for ${filename}: ${error.message}`); }
}

// A killed run never reached its finally. Names carry the owner's pid: a live
// one is an install of another target sharing this directory.
async function removeLeftovers(directory, prefix, suffix, recursive, logger) {
    let names;
    try { names = await fs.promises.readdir(directory); }
    catch (error) {
        if (error.code !== 'ENOENT') logger(`cleanup warning for ${directory}: ${error.message}`);
        return;
    }
    for (const name of names) {
        const owner = Number.parseInt(name.slice(prefix.length), 10);
        if (!name.startsWith(prefix) || !name.endsWith(suffix)
            || !Number.isInteger(owner) || processAlive(owner)) continue;
        logger(`removing leftover ${name}`);
        await removeQuietly(path.join(directory, name), recursive, logger);
    }
}

async function ensureGeodata(options = {}) {
    const logger = options.logger || defaultLogger;
    const targetDirectory = await canonicalGeodataDirectory(options.targetDirectory
        || process.env.L2NODE_GEODATA_DIR || path.join(rootDir, 'data', 'Geodata'));
    const tempDirectory = path.resolve(options.tempDirectory || path.join(rootDir, 'tmp', 'geodata-bootstrap'));
    const legacyValidation = options.minimumFileCount !== undefined || options.requiredFiles !== undefined;
    const releaseFile = process.env.L2NODE_GEODATA_RELEASE;
    const release = options.release !== undefined ? options.release : legacyValidation ? null
        : releaseFile ? JSON.parse(await fs.promises.readFile(path.resolve(releaseFile), 'utf8')) : defaultRelease;
    if (release && (release.schemaVersion !== 1 || !manifestIdentity(release.manifest)
        || !release.manifest.regions.length)) throw new Error('Invalid geodata release descriptor');
    const url = options.url || process.env.L2NODE_GEODATA_URL || release?.url;
    const expectedSha256 = String(options.sha256 || process.env.L2NODE_GEODATA_SHA256 || release?.sha256 || '').toLowerCase();
    const validationOptions = {
        minimumFileCount: options.minimumFileCount, requiredFiles: options.requiredFiles,
        manifest: release?.manifest, logger
    };
    const pinnedManifest = legacyValidation ? null : release?.manifest;
    await fs.promises.mkdir(path.dirname(targetDirectory), { recursive: true });
    const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const lock = await acquireInstallLock(targetDirectory, token, logger);
    const archivePath = path.join(tempDirectory, `geodata-${token}.zip`);
    const stagingDirectory = path.join(path.dirname(targetDirectory), `.Geodata.installing-${token}`);
    let backupPath = null;
    try {
        await removeLeftovers(path.dirname(targetDirectory), '.Geodata.installing-', '', true, logger);
        await removeLeftovers(tempDirectory, 'geodata-', '.zip', false, logger);
        const existing = await inspectDirectory(targetDirectory, { ...validationOptions, trustStamp: !!pinnedManifest });
        let result;
        if (existing.valid) {
            if (pinnedManifest && !existing.stamped) {
                // A read-only pack still runs: it only verifies again next Start.
                try {
                    await writeMarker(targetDirectory, await readJson(path.join(targetDirectory, MARKER_NAME)),
                        pinnedManifest, existing.staleManifest);
                } catch (error) { logger(`stamp warning: ${error.message}`); }
            }
            logger(`ready: ${existing.fileCount} region files in ${targetDirectory}`);
            result = { downloaded: false, directory: targetDirectory, fileCount: existing.fileCount };
        } else {
            if ((await activeUsers(targetDirectory)).length) {
                throw new Error('Stop every server using this geodata directory before updating it');
            }
            if (!url || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
                throw new Error(`Install client-generated L2J geodata with ${MANIFEST_NAME}, or configure a verified geodata release archive`);
            }
            logger(`${existing.exists ? 'updating' : 'installing'} geodata${existing.reason ? `: ${existing.reason}` : ''}`);
            await fs.promises.mkdir(tempDirectory, { recursive: true });
            const downloaded = await downloadArchive(url, archivePath, logger);
            if (downloaded.sha256 !== expectedSha256) {
                throw new Error(`Geodata checksum mismatch: expected ${expectedSha256}, received ${downloaded.sha256}`);
            }
            logger(`checksum verified: ${downloaded.sha256}`);
            await fs.promises.mkdir(stagingDirectory);
            await extract(archivePath, { dir: stagingDirectory, onEntry: extractProgress(logger) });
            const extracted = await extractedGeodataRoot(stagingDirectory, validationOptions);
            await writeMarker(extracted.directory, {
                url, sha256: downloaded.sha256, archiveBytes: downloaded.bytes,
                fileCount: extracted.inspection.fileCount, installedAt: new Date().toISOString()
            }, pinnedManifest, extracted.inspection.staleManifest);
            // Preserve the entire previous pack only after the replacement has
            // passed archive, manifest and per-region checks. Never overlay it.
            if (existing.exists) {
                backupPath = `${targetDirectory}.backup-${token}`;
                lock.owner.backupPath = backupPath;
                await writeOwner(lock.directory, lock.owner);
                await renameWithRetries(targetDirectory, backupPath);
            }
            try {
                await renameWithRetries(extracted.directory, targetDirectory);
            } catch (error) {
                if (backupPath) await renameWithRetries(backupPath, targetDirectory);
                throw error;
            }
            logger(`installed ${extracted.inspection.fileCount} region files in ${targetDirectory}`);
            if (backupPath) logger(`previous geodata preserved in ${backupPath}`);
            result = { downloaded: true, directory: targetDirectory, fileCount: extracted.inspection.fileCount,
                sha256: downloaded.sha256, bytes: downloaded.bytes, backupPath };
        }
        if (options.acquireUsage) {
            const usersDirectory = path.join(path.dirname(targetDirectory), `.${path.basename(targetDirectory)}.users`);
            await fs.promises.mkdir(usersDirectory, { recursive: true });
            result.usageFile = path.join(usersDirectory, `${token}.json`);
            await fs.promises.writeFile(result.usageFile, JSON.stringify({ pid: process.pid }));
        }
        return result;
    } finally {
        await removeQuietly(archivePath, false, logger);
        await removeQuietly(stagingDirectory, true, logger);
        await fs.promises.rm(lock.directory, { recursive: true, force: true });
    }
}

module.exports = {
    MANIFEST_NAME,
    releaseGeodataUsage,
    transferGeodataUsage,
    ensureGeodata,
    inspectDirectory
};
