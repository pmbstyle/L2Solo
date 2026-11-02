'use strict';

// Run with the development Electron binary and the built app's resources folder.
// Loading the controller from the real ASAR catches standalone Node helper paths.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { prepareWorld } = require('./world-fixture.cjs');
const resources = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-packaged-smoke-'));

app.whenReady().then(async () => {
    const { Controller } = require(path.join(resources, 'app.asar/main/controller.cjs'));
    const { RuntimeManager } = require(path.join(resources, 'app.asar/main/runtime.cjs'));
    const { LauncherUpdates } = require(path.join(resources, 'app.asar/main/launcher-updates.cjs'));
    assert.equal(typeof LauncherUpdates, 'function');
    const root = path.join(temporary, 'server');
    const put = (name, content) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
    put('package.json', '{"version":"0.1.0"}');
    put('config/default.ini', '[Database]\npath = tmp/world.sqlite\n[General]\nmaxLevel = 78\n');
    put('scripts/geodata-release.json', '{}');
    put('scripts/geodata-bootstrap.js', 'module.exports={async inspectDirectory(){return {valid:true,fileCount:1}},async ensureGeodata(){return {valid:true,fileCount:1}}};');
    put('scripts/run-server.js', "console.log('GameServer :: successful init');process.send({type:'launcher:population',bots:100,players:2,capacity:1700});process.on('message',m=>{if(m.type==='shutdown'){require('fs').writeFileSync('tmp/drained','yes');process.exit(0)}});process.on('disconnect',()=>process.exit(0));");
    const userData = path.join(temporary, 'profile');
    const runtimeManager = new RuntimeManager({ userData, bundledNode: path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') });
    const controller = new Controller({ userData, nodePath: await runtimeManager.ensure(), runtimeManager });
    assert.ok(controller.nodePath.startsWith(path.join(userData, 'runtimes')));
    put('config/local.ini', '');
    prepareWorld(root, controller.nodePath);
    try {
        await controller.choose(root);
        const id = require('node:crypto').randomUUID();
        const snapshot = await controller.helper('update-data.cjs', ['snapshot', JSON.stringify({ id, ...controller.worldOptions() })]);
        await controller.helper('update-data.cjs', ['restore', JSON.stringify({ id, ...snapshot })]);
        assert.equal(controller.state.geodata.valid, true);
        await controller.repair();
        await controller.backup('create', { name: 'Packaged backup' });
        const backup = controller.state.world.backups[0];
        await controller.wipe('bots', 'WIPE BOTS');
        assert.equal(controller.state.world.result.characters, 1);
        await controller.backup('load', { id: backup.id, confirmed: true });
        await controller.backup('delete', { id: backup.id, confirmed: true });
        assert.equal(controller.state.world.backups.length, 0);
        await controller.start();
        const deadline = Date.now() + 5000;
        while (controller.state.phase !== 'running' || !controller.state.population) {
            if (Date.now() > deadline) throw new Error('Packaged server did not become ready.');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(controller.state.population.total, 102);
        await controller.stop();
        assert.equal(controller.state.population, null);
        assert.equal(fs.readFileSync(path.join(root, 'tmp/drained'), 'utf8'), 'yes');
        console.log('Packaged application smoke passed: ASAR helpers, bundled Node, world backups, wipe, database lock, geodata, start/stop.');
    } finally { await controller.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
    app.quit();
}).catch(error => { console.error(error); app.exit(1); });
