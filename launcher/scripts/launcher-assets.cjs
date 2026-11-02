'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256, writeJson } = require('../main/files.cjs');
const { validateLauncherManifest, channelOf } = require('../main/releases.cjs');
const { validateFeed } = require('../main/launcher-updates.cjs');

const feeds = { 'darwin-arm64': 'latest-arm64-mac.yml', 'darwin-x64': 'latest-x64-mac.yml',
    'linux-x64': 'latest-x64-linux.yml', 'win32-x64': 'latest-x64.yml' };
const feedsForChannel = channel => Object.fromEntries(Object.entries(feeds).map(([target, file]) => [target, channel === 'preview' ? file.replace(/^latest-/, 'preview-') : file]));
async function readAssets(directory) {
    const assets = [];
    for (const name of (await fs.promises.readdir(directory)).sort()) {
        if (!/^(L2Solo-Launcher-[\w.-]+\.(?:exe|dmg|zip|AppImage|deb)(?:\.blockmap)?|(?:latest|preview)-[\w.-]+\.yml)$/.test(name)) continue;
        const file = path.join(directory, name);
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid launcher artifact: ${name}`);
        const hash = crypto.createHash('sha512');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        assets.push({ name, bytes: stat.size, sha256: await sha256(file), sha512: hash.digest('base64') });
    }
    return assets;
}

function installerNames(assets, version, target) {
    if (!Object.hasOwn(feeds, target)) throw new Error(`Unsupported launcher target: ${target}`);
    const [platform, arch] = target.split('-');
    // Electron Builder uses the package format's architecture in Linux names.
    // Retain x64 aliases for previously assembled artifacts without renaming
    // binaries or invalidating URLs/checksums already written into their feeds.
    const formats = platform === 'linux' ? [['linux-x86_64.AppImage', 'linux-x64.AppImage'], ['linux-amd64.deb', 'linux-x64.deb']]
        : platform === 'darwin' ? [[`mac-${arch}.dmg`], [`mac-${arch}.zip`]]
            : [[`windows-${arch}-Setup.exe`], [`windows-${arch}-Portable.exe`]];
    return formats.flatMap((suffixes, index) => {
        const names = suffixes.map(suffix => `L2Solo-Launcher-${version}-${suffix}`);
        const matches = names.filter(name => assets.some(asset => asset.name === name));
        if (matches.length > 1) throw new Error(`Ambiguous installer for ${target}: ${matches.join(', ')}`);
        if (!matches.length && (index === 0 || platform === 'darwin')) throw new Error(`Missing installer: ${names[0]}`);
        return matches;
    });
}

async function verifyTarget(directory, version, target, assets) {
    assets ||= await readAssets(directory);
    const installers = installerNames(assets, version, target);
    const channelFeeds = feedsForChannel(channelOf(version));
    const info = validateFeed(await fs.promises.readFile(path.join(directory, channelFeeds[target]), 'utf8'),
        { version, feeds: channelFeeds, assets }, target);
    const primary = installers.find(name => target.startsWith('darwin-') ? name.endsWith('.zip')
        : target.startsWith('win32-') ? name.endsWith('-Setup.exe') : name.endsWith('.AppImage'));
    if (!info.files.some(file => file.url === primary)) throw new Error(`Launcher ${target} update feed must reference ${primary}.`);
    return installers;
}

async function collect(directory, version, sourceCommit = process.env.RELEASE_SOURCE_SHA) {
    const channel = channelOf(version), channelFeeds = feedsForChannel(channel);
    const assets = await readAssets(directory), installers = {};
    for (const target of Object.keys(feeds)) {
        installers[target] = await verifyTarget(directory, version, target, assets);
    }
    const manifest = validateLauncherManifest({ schemaVersion: 1, component: 'launcher', version, tag: `launcher-v${version}`, channel,
        ...(sourceCommit ? { sourceCommit } : {}), feeds: channelFeeds, installers, assets }, `launcher-v${version}`);
    await writeJson(path.join(directory, 'launcher-release.json'), manifest);
    return manifest;
}
if (require.main === module) {
    const directory = path.resolve(process.env.RELEASE_ASSETS || 'dist'), version = require('../package.json').version;
    const target = process.argv[2]?.replace(/^--target=/, '');
    (target ? verifyTarget(directory, version, target) : collect(directory, version))
        .then(result => console.log(target ? `Verified launcher ${version} for ${target}: ${result.join(', ')}`
            : `Verified launcher ${result.version}: ${result.assets.length} release assets.`))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { collect, verifyTarget, feeds, feedsForChannel };
