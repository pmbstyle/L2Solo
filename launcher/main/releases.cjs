'use strict';

const fs = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const { managedPath } = require('./files.cjs');

const repository = 'pmbstyle/L2Solo';
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;
const tagPattern = /^(?:server-)?v\d+\.\d+\.\d+(?:-preview\.\d+)?$/;
const launcherTagPattern = /^launcher-v\d+\.\d+\.\d+(?:-preview\.\d+)?$/;
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
const requiredServerFiles = ['package.json', 'config/default.ini', 'scripts/run-server.js', 'scripts/geodata-release.json',
    'scripts/geodata-bootstrap.js', 'src/NodeL2.js', 'src/Server.js', 'scripts/launcher-population.js'];
const versionOf = tag => String(tag).replace(/^(?:server-|launcher-)?v/, '');
const channelOf = version => versionOf(version).includes('-preview.') ? 'preview' : 'stable';

function validateChannel(manifest, tag) {
    const channel = channelOf(tag);
    if (manifest.channel !== undefined && manifest.channel !== channel
        || manifest.sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
        || channel === 'preview' && !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '')) throw new Error('Invalid release channel or source commit.');
}

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
    if (!(tagPattern.test(tag) || launcherTagPattern.test(tag)) || !/^[\w.-]+$/.test(filename)) throw new Error('Invalid release asset.');
    return `https://github.com/${repository}/releases/download/${tag}/${filename}`;
}

function validateManifest(manifest, tag) {
    if (![1, 2].includes(manifest?.schemaVersion) || manifest.tag !== tag || !tagPattern.test(tag)
        || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000
        || !/^[a-f0-9]{64}$/.test(manifest.archive?.sha256)
        || !Number.isSafeInteger(manifest.archive?.bytes) || manifest.archive.bytes < 1 || manifest.archive.bytes > 1024 ** 3) {
        throw new Error('The release manifest is invalid or unsupported.');
    }
    assetUrl(tag, manifest.archive.name);
    validateChannel(manifest, tag);
    if (manifest.schemaVersion === 2 && (manifest.component !== 'server' || manifest.version !== versionOf(tag)
        || !Number.isSafeInteger(manifest.databaseSchemaVersion) || manifest.databaseSchemaVersion < 1
        || !stableVersionPattern.test(manifest.runtime?.version) || Number(manifest.runtime.version.split('.')[0]) < 22
        || !versionPattern.test(manifest.minimumLauncherVersion))) throw new Error('Invalid server runtime or compatibility information.');
    if (manifest.startupProtocolVersion !== undefined && (manifest.schemaVersion !== 2 || ![1, 2].includes(manifest.startupProtocolVersion))) throw new Error('Unsupported server startup protocol. Update the launcher first.');
    if (manifest.archive.name !== `L2Solo-Server-v${versionOf(tag)}.zip`
        || (manifest.minimumLauncherVersion !== undefined && (!versionPattern.test(manifest.minimumLauncherVersion)
            || channelOf(tag) === 'stable' && channelOf(manifest.minimumLauncherVersion) !== 'stable'))) throw new Error('Invalid release compatibility information.');
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
    for (const required of manifest.schemaVersion === 2 ? requiredServerFiles : requiredServerFiles.slice(0, 6)) {
        if (!seen.has(required.toLowerCase())) throw new Error(`Release is missing ${required}.`);
    }
    if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 4 * 1024 ** 3) throw new Error('Expanded release is too large.');
    return manifest;
}

async function listReleases(fetcher = fetch) {
    const releases = [];
    // Inspect component tags, never the repository-wide latest pointer. Bound
    // pagination so offline/rate-limited checks cannot delay normal startup.
    for (let page = 1; page <= 10; page++) {
        const batch = await json(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, fetcher);
        if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid release list.');
        releases.push(...batch.filter(release => !release.draft));
        if (batch.length < 100) break;
    }
    return releases;
}

function selectRelease(releases, component, minimumVersion = '0.0.0', channel = 'stable') {
    if (!['stable', 'preview'].includes(channel)) throw new Error('Unknown update channel.');
    const pattern = component === 'launcher' ? launcherTagPattern : tagPattern;
    return releases.filter(release => !release.draft && Boolean(release.prerelease) === (channel === 'preview')
        && pattern.test(release.tag_name) && versionPattern.test(versionOf(release.tag_name)) && channelOf(release.tag_name) === channel
        && (component !== 'server' || release.tag_name.startsWith('server-') || release.assets?.some(asset => asset.name === 'l2solo-release.json'))
        && !newerVersion(minimumVersion, versionOf(release.tag_name)))
        .sort((a, b) => newerVersion(versionOf(a.tag_name), versionOf(b.tag_name)) ? -1
            : newerVersion(versionOf(b.tag_name), versionOf(a.tag_name)) ? 1 : Number(b.tag_name.startsWith('server-')) - Number(a.tag_name.startsWith('server-')))[0];
}

async function latestRelease(fetcher = fetch, releases, channel = 'stable') {
    const release = selectRelease(releases || await listReleases(fetcher), 'server', '0.0.0', channel);
    if (!release) throw new Error(`No ${channel} server release is published yet. You can connect an existing server while the first release is being prepared.`);
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

function validateLauncherManifest(manifest, tag) {
    if (manifest?.schemaVersion !== 1 || manifest.component !== 'launcher' || manifest.tag !== tag
        || !launcherTagPattern.test(tag) || manifest.version !== versionOf(tag) || !versionPattern.test(manifest.version)
        || !Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > 100) throw new Error('Invalid launcher release manifest.');
    validateChannel(manifest, tag);
    const names = new Set();
    for (const asset of manifest.assets) {
        assetUrl(tag, asset.name);
        if (!asset.name.startsWith(`L2Solo-Launcher-${manifest.version}-`) && !new RegExp(`^${channelOf(tag) === 'preview' ? 'preview' : 'latest'}-[\\w.-]+\\.yml$`).test(asset.name)) throw new Error('Launcher artifact version does not match its release.');
        if (names.has(asset.name.toLowerCase()) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 2 * 1024 ** 3
            || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512)) throw new Error('Invalid launcher release asset.');
        names.add(asset.name.toLowerCase());
    }
    for (const target of platforms) {
        const feed = manifest.feeds?.[target];
        if (!names.has(String(feed).toLowerCase()) || !/^[\w.-]+\.yml$/.test(feed)) throw new Error(`Missing launcher update feed: ${target}`);
        const installers = manifest.installers?.[target];
        if (!Array.isArray(installers) || !installers.length || installers.some(name => !names.has(String(name).toLowerCase())
            || !/\.(exe|dmg|zip|AppImage|deb)$/.test(name))) throw new Error(`Missing launcher installers: ${target}`);
    }
    return manifest;
}

async function launcherRelease(fetcher = fetch, releases, minimumVersion = '0.0.0', channel = 'stable') {
    const release = selectRelease(releases || await listReleases(fetcher), 'launcher', minimumVersion, channel);
    if (!release) throw new Error(`No compatible ${channel} launcher release is published yet.`);
    const tag = release.tag_name;
    const descriptor = release.assets?.find(asset => asset.name === 'launcher-release.json');
    if (descriptor?.browser_download_url !== assetUrl(tag, 'launcher-release.json')) throw new Error('The launcher release is incomplete.');
    const manifest = validateLauncherManifest(await json(descriptor.browser_download_url, fetcher), tag);
    for (const expected of manifest.assets) {
        const asset = release.assets.find(asset => asset.name === expected.name);
        if (!asset || asset.browser_download_url !== assetUrl(tag, expected.name) || asset.size !== expected.bytes
            || (asset.digest && asset.digest !== `sha256:${expected.sha256}`)) throw new Error('The launcher release assets do not match their manifest.');
    }
    return { tag, version: manifest.version, notes: String(release.body || ''), publishedAt: release.published_at,
        url: `https://github.com/${repository}/releases/tag/${tag}`, manifest };
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
    if (!versionPattern.test(candidate) || !versionPattern.test(current)) throw new Error('Invalid version comparison.');
    const [nextCore, nextPreview] = candidate.split('-preview.'), [installedCore, installedPreview] = current.split('-preview.');
    const next = nextCore.split('.').map(BigInt), installed = installedCore.split('.').map(BigInt);
    for (let index = 0; index < 3; index++) { if (next[index] !== installed[index]) return next[index] > installed[index]; }
    if (nextPreview === undefined || installedPreview === undefined) return nextPreview === undefined && installedPreview !== undefined;
    return BigInt(nextPreview) > BigInt(installedPreview);
}

module.exports = { repository, tagPattern, launcherTagPattern, versionPattern, stableVersionPattern, versionOf, channelOf, platforms, requiredServerFiles, assetUrl, validateManifest,
    validateLauncherManifest, listReleases, selectRelease, launcherRelease, latestRelease, download, newerVersion };
