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
const DEFAULT_URL = 'https://l2solo.com/files/geodata.zip';
const DEFAULT_SHA256 = '044e5507c3f0f55785a4698fec3ebd5e0e69bc9cce5bd5b669b8758c4a43f26d';
const DEFAULT_FILE_COUNT = 203;
const DEFAULT_REQUIRED_FILES = {
    '21_22.l2j': 5478234,
    '22_20.l2j': 5295298,
    '23_20.l2j': 3530634
};

function defaultLogger(message) {
    console.info(`Geodata   :: ${message}`);
}

async function inspectDirectory(directory, options = {}) {
    const minimumFileCount = Number(options.minimumFileCount ?? DEFAULT_FILE_COUNT);
    const requiredFiles = options.requiredFiles || DEFAULT_REQUIRED_FILES;
    let entries;

    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { valid: false, exists: false, fileCount: 0 };
        throw error;
    }

    const geodataFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.l2j'));
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

async function renameWithRetries(source, destination, options = {}) {
    const retries = Number(options.retries ?? 20);
    const retryDelay = Number(options.retryDelay ?? 250);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.promises.rename(source, destination);
            return;
        } catch (error) {
            const retryable = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code);
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

async function ensureGeodata(options = {}) {
    const logger = options.logger || defaultLogger;
    const targetDirectory = path.resolve(options.targetDirectory
        || process.env.L2NODE_GEODATA_DIR
        || path.join(rootDir, 'data', 'Geodata'));
    const tempDirectory = path.resolve(options.tempDirectory || path.join(rootDir, 'tmp', 'geodata-bootstrap'));
    const url = options.url || process.env.L2NODE_GEODATA_URL || DEFAULT_URL;
    const expectedSha256 = String(options.sha256
        || process.env.L2NODE_GEODATA_SHA256
        || DEFAULT_SHA256).toLowerCase();
    const validationOptions = {
        minimumFileCount: options.minimumFileCount,
        requiredFiles: options.requiredFiles
    };
    const existing = await inspectDirectory(targetDirectory, validationOptions);

    if (existing.valid) {
        logger(`ready: ${existing.fileCount} region files in ${targetDirectory}`);
        return { downloaded: false, directory: targetDirectory, fileCount: existing.fileCount };
    }
    if (existing.exists) {
        const entries = await fs.promises.readdir(targetDirectory);
        if (entries.length > 0) {
            throw new Error(`Geodata directory is incomplete (${existing.fileCount} region files): ${targetDirectory}`);
        }
        await fs.promises.rmdir(targetDirectory);
    }

    await fs.promises.mkdir(path.dirname(targetDirectory), { recursive: true });
    await fs.promises.mkdir(tempDirectory, { recursive: true });
    const token = `${process.pid}-${Date.now()}`;
    const archivePath = path.join(tempDirectory, `geodata-${token}.zip`);
    const stagingDirectory = path.join(path.dirname(targetDirectory), `.Geodata.installing-${token}`);
    let installRoot = null;
    let operationError = null;
    let cleanupError = null;
    let result = null;

    try {
        const downloaded = await downloadArchive(url, archivePath, logger);
        if (downloaded.sha256 !== expectedSha256) {
            throw new Error(`Geodata checksum mismatch: expected ${expectedSha256}, received ${downloaded.sha256}`);
        }
        logger(`checksum verified: ${downloaded.sha256}`);

        await fs.promises.mkdir(stagingDirectory);
        logger('extracting archive');
        await extract(archivePath, {
            dir: stagingDirectory,
            onEntry: assertSafeArchiveEntry
        });
        const extracted = await extractedGeodataRoot(stagingDirectory, validationOptions);
        installRoot = extracted.directory;
        await fs.promises.writeFile(path.join(installRoot, '.l2solo-geodata.json'), `${JSON.stringify({
            url,
            sha256: downloaded.sha256,
            archiveBytes: downloaded.bytes,
            fileCount: extracted.inspection.fileCount,
            installedAt: new Date().toISOString()
        }, null, 2)}\n`);

        await renameWithRetries(installRoot, targetDirectory);
        installRoot = null;
        logger(`installed ${extracted.inspection.fileCount} region files in ${targetDirectory}`);
        result = {
            downloaded: true,
            directory: targetDirectory,
            fileCount: extracted.inspection.fileCount,
            sha256: downloaded.sha256,
            bytes: downloaded.bytes
        };
    } catch (error) {
        operationError = error;
    } finally {
        const cleanupTargets = [
            [archivePath, false],
            [stagingDirectory, true]
        ];
        for (const [cleanupPath, recursive] of cleanupTargets) {
            try {
                await fs.promises.rm(cleanupPath, {
                    recursive,
                    force: true,
                    maxRetries: 10,
                    retryDelay: 100
                });
            } catch (error) {
                if (operationError) {
                    logger(`cleanup warning for ${cleanupPath}: ${error.message}`);
                } else if (!cleanupError) {
                    cleanupError = error;
                }
            }
        }
    }

    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
    return result;
}

module.exports = {
    DEFAULT_FILE_COUNT,
    DEFAULT_REQUIRED_FILES,
    DEFAULT_SHA256,
    DEFAULT_URL,
    ensureGeodata,
    inspectDirectory
};
