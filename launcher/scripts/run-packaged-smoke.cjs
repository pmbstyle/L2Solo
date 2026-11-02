'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
let resources;
for (const entry of fs.readdirSync(dist, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const candidate of [path.join(dist, entry.name, 'resources'), path.join(dist, entry.name, `${require('../package.json').build.productName}.app/Contents/Resources`)]) {
        const metadata = path.join(candidate, 'runtime/runtime.json');
        if (!fs.existsSync(metadata) || !fs.existsSync(path.join(candidate, 'app.asar'))) continue;
        const runtime = JSON.parse(fs.readFileSync(metadata, 'utf8'));
        if (runtime.platform === process.platform && runtime.arch === process.arch) resources = candidate;
    }
}
if (!resources) throw new Error('Build the native application with npm run pack or npm run dist first.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(root, 'test/packaged-smoke.cjs'), resources], { cwd: root, env, stdio: 'inherit', timeout: 30000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
