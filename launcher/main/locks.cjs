'use strict';

const { spawn } = require('node:child_process');
const { helperPath } = require('./helper-path.cjs');

function holdLock(database, nodePath, busyMessage) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(nodePath, [helperPath('db-guard.cjs'), database], {
            env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        });
        let ready = false, stderr = '', closed = false;
        const timer = setTimeout(() => { child.kill(); reject(new Error('Installation lock timed out.')); }, 10000);
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('message', message => {
            clearTimeout(timer);
            if (message.type === 'error') reject(new Error(busyMessage && /world is in use/.test(message.message) ? busyMessage : message.message));
            if (message.type === 'ready') {
                ready = true;
                resolve(() => new Promise(done => {
                    if (closed) { done(); return; }
                    child.once('close', done);
                    if (child.connected) child.send({ type: 'release' });
                }));
            }
        });
        child.on('close', () => { closed = true; clearTimeout(timer); if (!ready) reject(new Error(stderr || 'Could not lock this installation.')); });
    });
}

module.exports = { holdLock };
