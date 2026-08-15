'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { ensureGeodata } = require('./geodata-bootstrap');

const rootDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
let serverChild = null;
let shuttingDown = false;

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

function startServer() {
    log('starting NodeL2 with embedded SQLite');
    serverChild = spawn(process.execPath, ['--openssl-legacy-provider', 'src/NodeL2'], {
        cwd: rootDir,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: process.env,
        windowsHide: isWindows
    });

    serverChild.on('exit', (code, signal) => {
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
}

async function main() {
    await ensureGeodata({ logger: log });
    startServer();
}

process.on('SIGINT', () => stopServer('SIGINT'));
process.on('SIGTERM', () => stopServer('SIGTERM'));
process.on('message', (message) => {
    if (message?.type === 'shutdown') stopServer(message.reason || 'launcher_stop');
});
main().catch((error) => {
    console.error(`Startup    :: geodata bootstrap failed: ${error.message}`);
    process.exit(1);
});
