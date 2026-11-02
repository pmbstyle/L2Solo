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
async function collect(directory, version, sourceCommit = process.env.RELEASE_SOURCE_SHA) {
    const channel = channelOf(version), channelFeeds = feedsForChannel(channel);
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
    const installers = {};
    for (const target of Object.keys(feeds)) {
        const [platform, arch] = target.split('-');
        const os = { darwin: 'mac', win32: 'windows', linux: 'linux' }[platform];
        const prefix = `L2Solo-Launcher-${version}-${os}-${arch}`;
        const required = platform === 'darwin' ? [`${prefix}.dmg`, `${prefix}.zip`]
            : platform === 'win32' ? [`${prefix}-Setup.exe`] : [`${prefix}.AppImage`];
        for (const name of required) if (!assets.some(asset => asset.name === name)) throw new Error(`Missing installer: ${name}`);
        installers[target] = assets.filter(asset => asset.name.startsWith(prefix) && /\.(exe|dmg|zip|AppImage|deb)$/.test(asset.name)).map(asset => asset.name);
    }
    const manifest = validateLauncherManifest({ schemaVersion: 1, component: 'launcher', version, tag: `launcher-v${version}`, channel,
        ...(sourceCommit ? { sourceCommit } : {}), feeds: channelFeeds, installers, assets }, `launcher-v${version}`);
    for (const target of Object.keys(channelFeeds)) validateFeed(await fs.promises.readFile(path.join(directory, channelFeeds[target]), 'utf8'), manifest, target);
    await writeJson(path.join(directory, 'launcher-release.json'), manifest);
    return manifest;
}
if (require.main === module) collect(path.resolve(process.env.RELEASE_ASSETS || 'dist'), require('../package.json').version)
    .then(manifest => console.log(`Verified launcher ${manifest.version}: ${manifest.assets.length} release assets.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collect, feeds, feedsForChannel };
