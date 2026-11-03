'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stableVersionPattern } = require('../main/releases.cjs');

function prepare(root, sequence, sourceCommit) {
    if (!/^[1-9]\d*$/.test(String(sequence)) || !/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('A preview needs a positive build sequence and a full source commit.');
    const server = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const launcher = JSON.parse(fs.readFileSync(path.join(root, 'launcher/package.json'), 'utf8'));
    if (![server.version, launcher.version].every(version => stableVersionPattern.test(version))) throw new Error('Preview builds must start from stable base versions.');
    server.version += `-preview.${sequence}`;
    launcher.version += `-preview.${sequence}`;
    server.l2soloRelease = { ...server.l2soloRelease, minimumLauncherVersion: launcher.version, sourceCommit };
    launcher.releaseChannel = 'preview';
    launcher.releaseSourceCommit = sourceCommit;
    // Separate identity lets testers keep the stable application installed.
    launcher.name = 'l2solo-launcher-preview';
    launcher.build.appId = 'com.l2solo.launcher.preview';
    launcher.build.productName = 'L2Solo Launcher Preview';
    launcher.build.linux.executableName = 'l2solo-launcher-preview';
    for (const [directory, pkg] of [['', server], ['launcher', launcher]]) {
        const lockPath = path.join(root, directory, 'package-lock.json');
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        lock.version = pkg.version;
        lock.name = pkg.name;
        lock.packages[''].version = pkg.version;
        lock.packages[''].name = pkg.name;
        fs.writeFileSync(path.join(root, directory, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
    return { serverTag: `server-v${server.version}`, launcherTag: `launcher-v${launcher.version}`,
        serverVersion: server.version, launcherVersion: launcher.version, sourceCommit, runtime: server.l2soloRelease.runtimeVersion };
}

if (require.main === module) {
    try {
        const result = prepare(path.resolve(__dirname, '../..'), process.env.PREVIEW_SEQUENCE, process.env.RELEASE_SOURCE_SHA);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
        console.log(JSON.stringify(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
