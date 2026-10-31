'use strict';

// Run with the development Electron binary and the built app's resources folder.
// Loading the controller from the real ASAR catches standalone Node helper paths.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const resources = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-packaged-smoke-'));

app.whenReady().then(async () => {
    const { Controller } = require(path.join(resources, 'app.asar/main/controller.cjs'));
    const root = path.join(temporary, 'server');
    const put = (name, content) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
    put('package.json', '{"version":"0.1.0"}');
    put('config/default.ini', '[Database]\npath = tmp/world.sqlite\n[General]\nmaxLevel = 78\n');
    put('scripts/geodata-release.json', '{}');
    put('scripts/geodata-bootstrap.js', 'module.exports={async inspectDirectory(){return {valid:true,fileCount:1}},async ensureGeodata(){return {valid:true,fileCount:1}}};');
    put('scripts/run-server.js', "console.log('GameServer :: successful init');process.on('message',m=>{if(m.type==='shutdown'){require('fs').writeFileSync('tmp/drained','yes');process.exit(0)}});process.on('disconnect',()=>process.exit(0));");
    const controller = new Controller({ userData: path.join(temporary, 'profile'), nodePath: path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') });
    try {
        await controller.choose(root);
        assert.equal(controller.state.geodata.valid, true);
        await controller.repair();
        await controller.start();
        const deadline = Date.now() + 5000;
        while (controller.state.phase !== 'running') {
            if (Date.now() > deadline) throw new Error('Packaged server did not become ready.');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        await controller.stop();
        assert.equal(fs.readFileSync(path.join(root, 'tmp/drained'), 'utf8'), 'yes');
        console.log('Packaged application smoke passed: ASAR helpers, bundled Node, database lock, geodata, start/stop.');
    } finally { await controller.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
    app.quit();
}).catch(error => { console.error(error); app.exit(1); });
