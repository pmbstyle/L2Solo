'use strict';

const path = require('node:path');
const root = process.argv[2];
const check = process.argv[3] === 'check';
const { ensureGeodata, inspectDirectory } = require(path.join(root, 'scripts/geodata-bootstrap.js'));
const release = require(path.join(root, 'scripts/geodata-release.json'));
const report = message => { if (process.connected) process.send(message); };

(async () => {
    const directory = path.join(root, 'data/Geodata');
    if (check) report({ type: 'result', result: await inspectDirectory(directory, { manifest: release.manifest }) });
    else {
        const result = await ensureGeodata({
            targetDirectory: directory, tempDirectory: path.join(root, 'tmp/geodata-bootstrap'), release,
            logger: message => report({ type: 'log', message }),
            onProgress: progress => report({ type: 'progress', ...progress })
        });
        report({ type: 'result', result: { valid: true, ...result } });
    }
})().then(() => process.disconnect?.()).catch(error => {
    report({ type: 'error', message: error.message });
    process.exitCode = 1;
    process.disconnect?.();
});
