'use strict';

const fs = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const { managedPath } = require('./files.cjs');

const repository = 'pmbstyle/L2Solo';
const tagPattern = /^v\d+\.\d+\.\d+$/;

async function json(url, fetcher = fetch) {
    if (new URL(url).protocol !== 'https:') throw new Error('Release requests require HTTPS.');
    const response = await fetcher(url, {
        headers: { 'User-Agent': 'L2Solo-Launcher', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        if (response.status === 404) throw new Error('No stable release is published yet. You can connect an existing server while the first release is being prepared.');
        if (response.status === 403 || response.status === 429) throw new Error('GitHub request limit reached. Try checking for updates later.');
        throw new Error(`Release request failed (HTTP ${response.status}).`);
    }
    const body = await response.text();
    if (body.length > 16 * 1024 * 1024) throw new Error('Release response is too large.');
    return JSON.parse(body);
}

function assetUrl(tag, filename) {
    if (!tagPattern.test(tag) || !/^[\w.-]+$/.test(filename)) throw new Error('Invalid release asset.');
    return `https://github.com/${repository}/releases/download/${tag}/${filename}`;
}

function validateManifest(manifest, tag) {
    if (manifest?.schemaVersion !== 1 || manifest.tag !== tag || !tagPattern.test(tag)
        || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000
        || !/^[a-f0-9]{64}$/.test(manifest.archive?.sha256)
        || !Number.isSafeInteger(manifest.archive?.bytes) || manifest.archive.bytes < 1 || manifest.archive.bytes > 1024 ** 3) {
        throw new Error('The release manifest is invalid or unsupported.');
    }
    assetUrl(tag, manifest.archive.name);
    if (manifest.archive.name !== `L2Solo-Server-${tag}.zip`
        || (manifest.minimumLauncherVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(manifest.minimumLauncherVersion))) throw new Error('Invalid release compatibility information.');
    const seen = new Set();
    for (const file of manifest.files) {
        managedPath(file.path);
        const folded = file.path.toLowerCase();
        if (seen.has(folded) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid release file manifest.');
        seen.add(folded);
    }
    for (const name of seen) {
        const segments = name.split('/');
        segments.pop();
        while (segments.length) {
            if (seen.has(segments.join('/'))) throw new Error('A release file conflicts with a directory.');
            segments.pop();
        }
    }
    for (const required of ['package.json', 'config/default.ini', 'scripts/run-server.js', 'scripts/geodata-release.json', 'scripts/geodata-bootstrap.js', 'src/NodeL2.js']) {
        if (!seen.has(required.toLowerCase())) throw new Error(`Release is missing ${required}.`);
    }
    if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 4 * 1024 ** 3) throw new Error('Expanded release is too large.');
    return manifest;
}

async function latestRelease(fetcher = fetch) {
    const release = await json(`https://api.github.com/repos/${repository}/releases/latest`, fetcher);
    if (release.draft || release.prerelease || !tagPattern.test(release.tag_name)) throw new Error('The latest release must have a stable vX.Y.Z tag.');
    const descriptor = release.assets?.find(asset => asset.name === 'l2solo-release.json');
    if (!descriptor || descriptor.browser_download_url !== assetUrl(release.tag_name, descriptor.name)) throw new Error('This release does not contain launcher installation files.');
    const manifest = validateManifest(await json(descriptor.browser_download_url, fetcher), release.tag_name);
    const archive = release.assets.find(asset => asset.name === manifest.archive.name);
    if (!archive || archive.browser_download_url !== assetUrl(manifest.tag, manifest.archive.name)
        || archive.size !== manifest.archive.bytes
        || (archive.digest && archive.digest !== `sha256:${manifest.archive.sha256}`)) throw new Error('The release archive does not match its manifest.');
    return {
        tag: manifest.tag, name: String(release.name || manifest.tag), notes: String(release.body || ''),
        publishedAt: release.published_at, url: `https://github.com/${repository}/releases/tag/${manifest.tag}`,
        manifest, archiveUrl: archive.browser_download_url
    };
}

async function download(url, file, expected, progress, fetcher = fetch) {
    if (new URL(url).protocol !== 'https:') throw new Error('Downloads require HTTPS.');
    const controller = new AbortController();
    let timer;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); };
    reset();
    try {
        const response = await fetcher(url, { signal: controller.signal, headers: { 'User-Agent': 'L2Solo-Launcher' } });
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const meter = new Transform({ transform(chunk, encoding, callback) {
            reset();
            bytes += chunk.length;
            if (bytes > expected.bytes) { callback(new Error('Download exceeds the expected size.')); return; }
            hash.update(chunk);
            progress?.(bytes / expected.bytes, bytes, expected.bytes);
            callback(null, chunk);
        } });
        await pipeline(response.body, meter, fs.createWriteStream(file, { flags: 'wx' }));
        if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('Download checksum mismatch. Please try again.');
    } finally { clearTimeout(timer); }
}

function newerVersion(candidate, current) {
    const next = candidate.split('.').map(Number), installed = current.split('.').map(Number);
    for (let index = 0; index < 3; index++) { if (next[index] !== installed[index]) return next[index] > installed[index]; }
    return false;
}

module.exports = { repository, tagPattern, assetUrl, validateManifest, latestRelease, download, newerVersion };
