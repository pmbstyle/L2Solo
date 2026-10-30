'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ensureGeodata, inspectDirectory, MANIFEST_NAME, releaseGeodataUsage } = require('../scripts/geodata-bootstrap');

const rootDir = path.resolve(__dirname, '..');
const testRoot = path.join(rootDir, 'tmp', `test-geodata-bootstrap-${process.pid}-${Date.now()}`);

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const [name, value] of Object.entries(files)) {
        const filename = Buffer.from(name.replace(/\\/g, '/'));
        const contents = Buffer.from(value);
        const checksum = crc32(contents);
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(contents.length, 18);
        localHeader.writeUInt32LE(contents.length, 22);
        localHeader.writeUInt16LE(filename.length, 26);
        localParts.push(localHeader, filename, contents);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(contents.length, 20);
        centralHeader.writeUInt32LE(contents.length, 24);
        centralHeader.writeUInt16LE(filename.length, 28);
        centralHeader.writeUInt32LE(offset, 42);
        centralParts.push(centralHeader, filename);
        offset += localHeader.length + filename.length + contents.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralDirectory, end]);
}

async function main() {
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const files = { '20_22.l2j': 'alpha', '22_22.l2j': 'bravo!' };
    const manifestFor = (files, profile = 'fixture') => ({ schemaVersion: 1, format: 'L2J', profile,
        regions: Object.entries(files).map(([file, value]) => ({ region: file.slice(0, -4),
            bytes: Buffer.byteLength(value), sha256: hash(value) })) });
    const manifest = manifestFor(files);
    const archiveFor = (files, manifest) => createStoredZip({
        ...Object.fromEntries(Object.entries(files).map(([key, value]) => [`Geodata/${key}`, value])),
        [`Geodata/${MANIFEST_NAME}`]: JSON.stringify(manifest)
    });
    const archive = archiveFor(files, manifest);
    const served = { '/pack.zip': archive };
    let requests = 0;
    const server = http.createServer((request, response) => {
        requests++;
        if (!served[request.url]) { response.writeHead(503); response.end(); return; }
        response.end(served[request.url]);
    });
    await fs.promises.mkdir(testRoot, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const release = { schemaVersion: 1, manifest, url: `${url}/pack.zip`, sha256: hash(archive) };
    const options = { release, tempDirectory: path.join(testRoot, 'downloads'), logger: () => {} };
    const install = (targetDirectory, extra = {}) => ensureGeodata({ ...options, targetDirectory, ...extra });
    async function writePack(directory, contents = files, metadata = manifest) {
        await fs.promises.mkdir(directory, { recursive: true });
        for (const [file, value] of Object.entries(contents)) await fs.promises.writeFile(path.join(directory, file), value);
        if (metadata) await fs.promises.writeFile(path.join(directory, MANIFEST_NAME), JSON.stringify(metadata));
    }
    async function assertPack(directory, contents = files) {
        for (const [file, value] of Object.entries(contents)) {
            assert.strictEqual(await fs.promises.readFile(path.join(directory, file), 'utf8'), value);
        }
    }
    const backups = async target => (await fs.promises.readdir(path.dirname(target)))
        .filter(name => name.startsWith(path.basename(target) + '.backup-'));
    try {
        const current = path.join(testRoot, 'current');
        await writePack(current);
        assert.strictEqual((await install(current)).downloaded, false);
        assert.strictEqual(requests, 0, 'current verified data must not contact the mirror');

        const fresh = path.join(testRoot, 'fresh');
        assert((await install(fresh)).downloaded);
        await assertPack(fresh);
        assert.strictEqual((await readMarker(fresh)).sha256, release.sha256);

        const oldFiles = { '20_22.l2j': 'ALPHA', '11_23.l2j': 'retired', 'notes.txt': 'preserve me' };
        const legacy = path.join(testRoot, 'legacy');
        await writePack(legacy, oldFiles, null);
        const updated = await install(legacy);
        assert(updated.downloaded && updated.backupPath);
        await assertPack(updated.backupPath, oldFiles);
        assert(!fs.existsSync(path.join(legacy, '11_23.l2j')), 'removed regions must not leak into the new pack');
        await assertPack(legacy);
        assert.deepStrictEqual(await backups(legacy), [path.basename(updated.backupPath)]);

        const oldManifestFiles = { '20_22.l2j': 'ALPHA', '22_22.l2j': 'bravo!' };
        const oldManifest = manifestFor(oldManifestFiles); // Same profile/count/sizes, different version.
        const old = path.join(testRoot, 'old-manifest');
        await writePack(old, oldManifestFiles, oldManifest);
        assert((await inspectDirectory(old)).valid, 'the old pack is internally consistent');
        const replaced = await install(old);
        assert(replaced.downloaded, 'a self-consistent old manifest must still update to the pinned release');
        await assertPack(replaced.backupPath, oldManifestFiles);
        await assertPack(old);
        const beforeRequests = requests;
        assert(!(await install(old)).downloaded);
        assert.strictEqual(requests, beforeRequests, 'a second start must not download again');

        await fs.promises.writeFile(path.join(old, '20_22.l2j'), 'Alpha');
        assert.strictEqual((await inspectDirectory(old)).reason, 'region checksum mismatch');
        assert((await install(old)).downloaded, 'same-size corruption must repair from the pinned release');
        await assertPack(old);

        // A failed replacement must leave the whole prior directory untouched.
        served['/broken.zip'] = Buffer.from('not a ZIP');
        served['/old.zip'] = archiveFor(oldManifestFiles, oldManifest);
        for (const [label, override] of [
            ['checksum', { sha256: '0'.repeat(64) }],
            ['network', { url: `${url}/offline.zip` }],
            ['archive', { url: `${url}/broken.zip`, sha256: hash(served['/broken.zip']) }],
            ['outdated-archive', { url: `${url}/old.zip`, sha256: hash(served['/old.zip']) }]
        ]) {
            const target = path.join(testRoot, `failed-${label}`);
            await writePack(target, oldFiles, null);
            await assert.rejects(() => install(target, override));
            await assertPack(target, oldFiles);
            assert.deepStrictEqual(await backups(target), [], `${label}: do not move the old pack before verification`);
        }
        assert.deepStrictEqual(await fs.promises.readdir(options.tempDirectory), []);

        const withAsset = { ...manifest, interactionGeometry: { file: 'npc-interaction-geometry.json', bytes: 3, sha256: hash('ray') } };
        served['/geometry.zip'] = createStoredZip({ ...files, [MANIFEST_NAME]: JSON.stringify(withAsset), 'npc-interaction-geometry.json': 'ray' });
        const geometryTarget = path.join(testRoot, 'geometry-asset');
        const geometryRelease = { ...release, manifest: withAsset, url: `${url}/geometry.zip`, sha256: hash(served['/geometry.zip']) };
        await install(geometryTarget, { release: geometryRelease });
        await fs.promises.writeFile(path.join(geometryTarget, 'npc-interaction-geometry.json'), 'Ray');
        assert.strictEqual((await inspectDirectory(geometryTarget)).reason, 'interaction geometry checksum mismatch');
        assert((await install(geometryTarget, { release: geometryRelease })).downloaded);
        served['/geometry-missing.zip'] = archiveFor(files, withAsset);
        const missingGeometry = path.join(testRoot, 'missing-geometry');
        await writePack(missingGeometry, oldFiles, null);
        await assert.rejects(() => install(missingGeometry, { release: { ...geometryRelease,
            url: `${url}/geometry-missing.zip`, sha256: hash(served['/geometry-missing.zip']) } }));
        await assertPack(missingGeometry, oldFiles);


        const rollbackTarget = path.join(testRoot, 'failed-publish');
        await writePack(rollbackTarget, oldFiles, null);
        const rename = fs.promises.rename;
        fs.promises.rename = async (source, destination) => {
            if (destination === rollbackTarget && String(source).includes('.Geodata.installing-')) {
                throw Object.assign(new Error('fixture publication failed'), { code: 'EIO' });
            }
            return rename(source, destination);
        };
        try { await assert.rejects(() => install(rollbackTarget), /fixture publication failed/); }
        finally { fs.promises.rename = rename; }
        await assertPack(rollbackTarget, oldFiles);
        assert.deepStrictEqual(await backups(rollbackTarget), [], 'failed publication must restore the old directory');

        const concurrentTarget = path.join(testRoot, 'concurrent');
        await writePack(concurrentTarget, oldFiles, null);
        const requestCount = requests;
        const concurrent = await Promise.all([install(concurrentTarget), install(concurrentTarget)]);
        assert.strictEqual(concurrent.filter(result => result.downloaded).length, 1);
        assert.strictEqual(requests - requestCount, 1, 'concurrent starts share one verified installation');
        assert.strictEqual((await backups(concurrentTarget)).length, 1);
        await assertPack(concurrentTarget);

        const used = path.join(testRoot, 'in-use');
        await writePack(used, oldManifestFiles, oldManifest);
        const manualRelease = { schemaVersion: 1, manifest: oldManifest };
        const lease = await install(used, { release: manualRelease, acquireUsage: true });
        try {
            const second = await install(used, { release: manualRelease, acquireUsage: true });
            releaseGeodataUsage(second.usageFile);
            await assert.rejects(() => install(used), /Stop every server/);
            await assertPack(used, oldManifestFiles);
        } finally { releaseGeodataUsage(lease.usageFile); }
        assert((await install(used)).downloaded, 'upgrade may proceed once every server has stopped');

        const physical = path.join(testRoot, 'physical'), alias = path.join(testRoot, 'alias');
        await writePack(physical, oldManifestFiles, oldManifest);
        await fs.promises.symlink(physical, alias, 'junction');
        const aliasedLease = await install(alias, { release: manualRelease, acquireUsage: true });
        try {
            assert.strictEqual(aliasedLease.directory, await fs.promises.realpath(physical));
            await assert.rejects(() => install(physical), /Stop every server/);
            await assertPack(alias, oldManifestFiles);
        } finally { releaseGeodataUsage(aliasedLease.usageFile); }
        assert((await install(physical)).downloaded);
        assert((await fs.promises.lstat(alias)).isSymbolicLink(), 'upgrading the physical pack must preserve its alias');
        await assertPack(alias);
        const missingPhysical = path.join(testRoot, 'missing-physical'), dangling = path.join(testRoot, 'dangling');
        await fs.promises.symlink(missingPhysical, dangling, 'junction');
        assert.strictEqual((await install(dangling)).directory, missingPhysical);
        await assertPack(missingPhysical);

        const overlap = path.join(testRoot, 'lease-overlap');
        await writePack(overlap);
        const ending = await install(overlap, { acquireUsage: true });
        const mkdir = fs.promises.mkdir;
        let next;
        fs.promises.mkdir = async (directory, opts) => {
            const result = await mkdir(directory, opts);
            if (directory === path.join(testRoot, '.lease-overlap.users')) releaseGeodataUsage(ending.usageFile);
            return result;
        };
        try { next = await install(overlap, { acquireUsage: true }); }
        finally { fs.promises.mkdir = mkdir; releaseGeodataUsage(ending.usageFile); }
        assert(fs.existsSync(next.usageFile), 'the last exiting user must not remove the next registration directory');
        releaseGeodataUsage(next.usageFile);


        const interrupted = path.join(testRoot, 'interrupted');
        const saved = interrupted + '.backup-interrupted';
        await writePack(saved);
        const lock = path.join(testRoot, '.interrupted.install-lock');
        await fs.promises.mkdir(lock);
        await fs.promises.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, backupPath: saved }));
        await fs.promises.writeFile(path.join(lock, 'recovery'), JSON.stringify({ pid: 2147483647, token: 'interrupted-recovery' }));
        assert(!(await install(interrupted)).downloaded, 'recover the previous directory after an interrupted swap');
        await assertPack(interrupted);
        assert(!fs.existsSync(lock));
        await fs.promises.rename(interrupted, saved);
        await fs.promises.mkdir(lock);
        await fs.promises.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, backupPath: saved }));
        const emptyClaim = path.join(lock, 'recovery');
        await fs.promises.writeFile(emptyClaim, '');
        await fs.promises.utimes(emptyClaim, new Date(0), new Date(0));
        assert(!(await install(interrupted)).downloaded, 'a crash before writing a recovery claim must not wedge startup');
        await assertPack(interrupted);

        const duringSwap = path.join(testRoot, 'canonical-swap');
        await writePack(duringSwap);
        const realpath = fs.promises.realpath;
        let movedDuringResolve = false;
        fs.promises.realpath = async value => {
            if (value === duringSwap && !movedDuringResolve) {
                movedDuringResolve = true;
                const saved = duringSwap + '.backup-interrupted';
                await fs.promises.rename(duringSwap, saved);
                const lock = path.join(testRoot, '.canonical-swap.install-lock');
                await fs.promises.mkdir(lock);
                await fs.promises.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, backupPath: saved }));
            }
            return realpath(value);
        };
        try { assert(!(await install(duringSwap)).downloaded); }
        finally { fs.promises.realpath = realpath; }
        assert(movedDuringResolve, 'fixture must remove the directory between canonical path inspection and realpath');
        await assertPack(duringSwap);

        for (const invalidManifest of [null, {}, { ...manifest, regions: [manifest.regions[0], manifest.regions[0]] },
            { ...manifest, regions: [{ ...manifest.regions[0], region: '../20_22' }] }]) {
            await fs.promises.writeFile(path.join(current, MANIFEST_NAME), JSON.stringify(invalidManifest));
            assert(!(await inspectDirectory(current)).valid);
        }
        await fs.promises.writeFile(path.join(current, MANIFEST_NAME), '{broken');
        assert(!(await inspectDirectory(current)).valid);
        await assert.rejects(() => install(path.join(testRoot, 'no-source'), { release: { schemaVersion: 1, manifest } }),
            /configure a verified geodata release archive/);

        // Run the real pre-server wrapper in a disposable checkout. Its child
        // must only start after the old pack has been replaced and leased.
        const project = path.join(testRoot, 'wrapper');
        await fs.promises.mkdir(path.join(project, 'scripts'), { recursive: true });
        await fs.promises.mkdir(path.join(project, 'src'));
        for (const filename of ['run-server.js', 'run-game-server.js', 'geodata-bootstrap.js']) {
            await fs.promises.copyFile(path.join(rootDir, 'scripts', filename), path.join(project, 'scripts', filename));
        }
        await fs.promises.symlink(path.join(rootDir, 'node_modules'), path.join(project, 'node_modules'), 'junction');
        await fs.promises.writeFile(path.join(project, 'scripts/geodata-release.json'), JSON.stringify(release));
        await writePack(path.join(project, 'data/Geodata'), oldFiles, null);
        await fs.promises.writeFile(path.join(project, 'src/NodeL2.js'), `
            const assert = require('assert'), fs = require('fs');
            assert.strictEqual(fs.readFileSync('data/Geodata/20_22.l2j', 'utf8'), 'alpha');
            assert(!fs.existsSync('data/Geodata/11_23.l2j'));
            assert(fs.readdirSync('data/.Geodata.users').some(name => JSON.parse(fs.readFileSync('data/.Geodata.users/' + name)).pid === process.pid));
            console.log('fixture server started after verified geodata upgrade');
        `);
        const env = { ...process.env };
        for (const key of ['L2NODE_GEODATA_RELEASE', 'L2NODE_GEODATA_DIR', 'L2NODE_GEODATA_URL', 'L2NODE_GEODATA_SHA256']) delete env[key];
        const runWrapper = () => new Promise((resolve, reject) => require('child_process').execFile(process.execPath,
            ['scripts/run-server.js'], { cwd: project, env, timeout: 20000 }, (error, stdout, stderr) =>
                error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
        const wrapperRequests = requests;
        const outputs = await Promise.all([runWrapper(), runWrapper()]);
        assert(outputs.every(output => output.includes('fixture server started after verified geodata upgrade')));
        assert.strictEqual(requests - wrapperRequests, 1, 'two wrapper processes must share one upgrade');
        assert.deepStrictEqual(fs.readdirSync(path.join(project, 'data/.Geodata.users')), [], 'server exit releases its own geodata lease');
        // A killed wrapper must not make a still-running child look unleased.
        const { spawn } = require('child_process');
        const pidFile = path.join(project, 'fixture-server.pid');
        await fs.promises.writeFile(path.join(project, 'src/NodeL2.js'), `
            require('fs').writeFileSync('fixture-server.pid', String(process.pid));
            setInterval(() => {}, 1000);
        `);
        let wrapper, childPid;
        const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
        try {
            wrapper = spawn(process.execPath, ['scripts/run-server.js'], { cwd: project, env, stdio: 'ignore' });
            const stopped = new Promise(resolve => wrapper.once('exit', resolve));
            for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
            childPid = Number(await fs.promises.readFile(pidFile, 'utf8'));
            wrapper.kill('SIGKILL');
            await stopped;
            assert(alive(childPid), 'fixture must exercise a child surviving its wrapper');
            const leaseFiles = fs.readdirSync(path.join(project, 'data/.Geodata.users'));
            assert(leaseFiles.some(name => JSON.parse(fs.readFileSync(path.join(project, 'data/.Geodata.users', name))).pid === childPid));
            await assert.rejects(() => install(path.join(project, 'data/Geodata'), {
                release: { ...release, manifest: { ...manifest, profile: 'replacement' } }
            }), /Stop every server/);
            await assertPack(path.join(project, 'data/Geodata'));
        } finally {
            if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
            if (wrapper && !wrapper.killed && wrapper.exitCode === null) wrapper.kill('SIGKILL');
        }
        console.log('Geodata bootstrap, upgrade, rollback, concurrency and server-wrapper checks passed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
}

async function readMarker(directory) {
    return JSON.parse(await fs.promises.readFile(path.join(directory, '.l2solo-geodata.json'), 'utf8'));
}

main().catch((error) => { console.error(error); process.exit(1); });
