'use strict';

const fs = require('node:fs');
const { versionPattern, stableVersionPattern, channelOf } = require('../main/releases.cjs');
function plan(tag, server = require('../../package.json'), launcher = require('../package.json')) {
    const component = tag?.startsWith('server-v') ? 'server' : tag?.startsWith('launcher-v') ? 'launcher' : null;
    const version = tag?.replace(/^(server|launcher)-v/, '');
    if (!component || !versionPattern.test(version) || version !== (component === 'server' ? server.version : launcher.version)) throw new Error('Release tag must match its component package version (server-vX.Y.Z or launcher-vX.Y.Z, optionally -preview.N).');
    if (!versionPattern.test(server.l2soloRelease?.minimumLauncherVersion) || !stableVersionPattern.test(server.l2soloRelease?.runtimeVersion)
        || !stableVersionPattern.test(launcher.serverRuntimeVersion)) throw new Error('Set explicit launcher compatibility and tested Node.js runtime versions.');
    const channel = channelOf(version);
    if (channel === 'preview' && (launcher.releaseChannel !== 'preview' || !/^[a-f0-9]{40}$/.test(launcher.releaseSourceCommit || '')
        || server.l2soloRelease.sourceCommit !== launcher.releaseSourceCommit)) throw new Error('Prepare matching preview packages from one source commit before releasing.');
    return { component, version, channel, runtime: component === 'server' ? server.l2soloRelease.runtimeVersion : launcher.serverRuntimeVersion };
}
if (require.main === module) {
    try {
        const result = plan(process.env.RELEASE_TAG);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
        console.log(JSON.stringify(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { plan };
