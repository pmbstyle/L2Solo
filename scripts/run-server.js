'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureGeodata, releaseGeodataUsage, transferGeodataUsage } = require('./geodata-bootstrap');

const rootDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
let serverChild = null;
let shuttingDown = false;
let geodataUsage = null;

function log(message) {
    console.info(`Startup    :: ${message}`);
}

function stopServer(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (!serverChild || serverChild.killed) {
        process.exit(0);
        return;
    }

    serverChild.once('exit', () => process.exit(0));
    if (serverChild.connected) serverChild.send({ type: 'shutdown', reason: signal || 'wrapper_stop' });
    else serverChild.kill(signal || 'SIGTERM');
    setTimeout(() => {
        if (serverChild && serverChild.exitCode === null && serverChild.signalCode === null) serverChild.kill('SIGKILL');
    }, 18000).unref();
}

async function startServer(directory) {
    log('starting NodeL2 with embedded SQLite');
    serverChild = spawn(process.execPath, ['--openssl-legacy-provider', 'scripts/run-game-server.js'], {
        cwd: rootDir,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, L2NODE_GEODATA_DIR: directory, L2NODE_GEODATA_USAGE_FILE: geodataUsage },
        windowsHide: isWindows
    });

    const child = serverChild;
    child.on('message', message => {
        if (['launcher:population', 'launcher:listening', 'launcher:initialized'].includes(message?.type)
            && process.connected && !shuttingDown) process.send(message, () => {});
    });
    child.on('exit', (code, signal) => {
        releaseGeodataUsage(geodataUsage, child.pid);
        serverChild = null;
        if (shuttingDown) {
            process.exit(0);
            return;
        }
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code || 0);
    });
    await transferGeodataUsage(geodataUsage, child.pid);
    if (!shuttingDown && child.connected) child.send({ type: 'geodata_ready' });
}

async function main() {
    const transaction = path.join(rootDir, '.l2solo/transaction.json');
    if (fs.existsSync(transaction) && JSON.parse(fs.readFileSync(transaction, 'utf8')).phase !== 'committed'
        && process.env.L2NODE_UPDATE_TRIAL !== '1') throw new Error('Finish verifying this server update in the desktop launcher before starting it directly.');
    const geodata = await ensureGeodata({ logger: log, acquireUsage: true });
    geodataUsage = geodata.usageFile;
    await startServer(geodata.directory);
}

process.on('exit', () => releaseGeodataUsage(geodataUsage));
process.on('SIGINT', () => stopServer('SIGINT'));
process.on('SIGTERM', () => stopServer('SIGTERM'));
// A desktop launcher can disappear without sending a signal (crash/OS quit).
// Retain the normal database drain rather than orphaning the server tree.
process.on('disconnect', () => stopServer('SIGTERM'));
process.on('message', (message) => {
    if (message?.type === 'shutdown') stopServer(message.reason || 'launcher_stop');
    if (message?.type === 'launcher:update-commit' && process.env.L2NODE_UPDATE_TRIAL === '1' && serverChild?.connected && !shuttingDown) {
        serverChild.send(message, () => {});
    }
});
main().catch((error) => {
    console.error(`Startup    :: geodata bootstrap failed: ${error.message}`);
    process.exit(1);
});
