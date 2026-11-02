'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const net = require('node:net');
const archiver = require('archiver');
const { Controller } = require('../main/controller.cjs');
const { RuntimeManager, prepareRuntime, targetFor } = require('../main/runtime.cjs');
const { ReleaseCatalog } = require('../main/release-catalog.cjs');
const { LauncherUpdates, validateFeed } = require('../main/launcher-updates.cjs');
const { assetUrl, listReleases, selectRelease, latestRelease, launcherRelease, validateManifest, validateLauncherManifest, channelOf, newerVersion } = require('../main/releases.cjs');
const { applyRelease, markerPath, journalPath, recover } = require('../main/installer.cjs');
const { writeJson, readJson, sha256, canonicalPath } = require('../main/files.cjs');
const { collect, feeds, feedsForChannel } = require('../scripts/launcher-assets.cjs');
const { publish: publishRelease, serverInstallers } = require('../scripts/publish-release.cjs');
const { plan } = require('../scripts/release-plan.cjs');
const { prepare: preparePreview } = require('../scripts/prepare-preview.cjs');
const { prepareWorld, query } = require('./world-fixture.cjs');
const { rejectUpdateBeforeMigrations } = require('../../scripts/database-access.js');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-updates-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10 }));
const directory = name => fs.mkdtempSync(path.join(temporary, `${name}-`));
const put = (root, name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
async function waitFor(condition) {
    const deadline = Date.now() + 10000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out waiting for launcher state.'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function launcherFixture(version = '1.3.0', sourceCommit = 'a'.repeat(40)) {
    const root = directory('launcher-assets');
    const artifacts = ['mac-arm64.dmg', 'mac-arm64.zip', 'mac-x64.dmg', 'mac-x64.zip', 'linux-x64.AppImage', 'linux-x64.deb', 'windows-x64-Setup.exe', 'windows-x64-Portable.exe'];
    for (const suffix of artifacts) put(root, `L2Solo-Launcher-${version}-${suffix}`, `original signed installer ${version} ${suffix}`);
    for (const [target, filename] of Object.entries(feedsForChannel(channelOf(version)))) {
        const suffix = { 'darwin-arm64': 'mac-arm64.zip', 'darwin-x64': 'mac-x64.zip', 'linux-x64': 'linux-x64.AppImage', 'win32-x64': 'windows-x64-Setup.exe' }[target];
        const name = `L2Solo-Launcher-${version}-${suffix}`;
        const bytes = fs.readFileSync(path.join(root, name));
        put(root, filename, JSON.stringify({ version, files: [{ url: name, size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') }] }));
    }
    const manifest = await collect(root, version, sourceCommit);
    const release = { tag_name: manifest.tag, draft: false, prerelease: channelOf(version) === 'preview', assets: [
        { name: 'launcher-release.json', browser_download_url: assetUrl(manifest.tag, 'launcher-release.json') },
        ...manifest.assets.map(asset => ({ ...asset, size: asset.bytes, browser_download_url: assetUrl(manifest.tag, asset.name) }))
    ] };
    return { root, manifest, release, fetcher: async url => url.includes('api.github.com') ? Response.json([release])
        : new Response(fs.readFileSync(path.join(root, new URL(url).pathname.split('/').pop()))) };
}

test('component discovery ignores repository Latest, drafts and prereleases and compares versions numerically', async () => {
    const items = [
        { tag_name: 'server-v1.9.0' }, { tag_name: 'launcher-v2.1.0' }, { tag_name: 'server-v1.10.0' },
        { tag_name: 'server-v9.0.0', draft: true }, { tag_name: 'server-v8.0.0', prerelease: true }, { tag_name: 'geodata-v99.0.0' },
        { tag_name: 'v2026.10.30', assets: [] }
    ];
    assert.equal(selectRelease(items, 'server').tag_name, 'server-v1.10.0');
    assert.equal(selectRelease(items, 'launcher').tag_name, 'launcher-v2.1.0');
    assert.equal(selectRelease(items, 'launcher', '3.0.0'), undefined);
    const urls = [];
    const fetched = await listReleases(async url => { urls.push(url); return Response.json(items); });
    assert.equal(selectRelease(fetched, 'server').tag_name, 'server-v1.10.0');
    assert.ok(urls.every(url => !url.endsWith('/latest')));
    const pkg = { version: '1.10.0', l2soloRelease: { minimumLauncherVersion: '0.2.0', runtimeVersion: '22.23.0' } };
    const app = { version: '2.1.0', serverRuntimeVersion: '22.23.0' };
    assert.equal(plan('server-v1.10.0', pkg, app).component, 'server');
    assert.equal(plan('launcher-v2.1.0', pkg, app).component, 'launcher');
    assert.equal(plan('server-v1.10.0', { ...pkg, l2soloRelease: { ...pkg.l2soloRelease, runtimeVersion: '24.0.0' } }, app).runtime, '24.0.0');
    assert.throws(() => plan('server-v2.1.0', pkg, app), /tag must match/);
});

test('release catalog shares concurrent checks, persists its cache and refreshes on request', async () => {
    const userData = directory('catalog');
    let calls = 0;
    const fetcher = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return Response.json([{ tag_name: 'server-v1.0.0' }]); };
    const catalog = new ReleaseCatalog({ userData, fetcher });
    await Promise.all([catalog.releases(true), catalog.releases(true)]);
    assert.equal(calls, 1);
    const offline = new ReleaseCatalog({ userData, fetcher: async () => { throw new Error('offline'); } });
    assert.equal((await offline.releases())[0].tag_name, 'server-v1.0.0');
    await assert.rejects(offline.releases(true), /offline/);
    assert.equal((await offline.releases())[0].tag_name, 'server-v1.0.0');
});

test('stable and preview discovery stay separate and preview build numbers compare numerically', async () => {
    const items = [
        { tag_name: 'server-v9.0.0' }, { tag_name: 'launcher-v9.0.0' },
        { tag_name: 'server-v0.1.0-preview.9', prerelease: true }, { tag_name: 'server-v0.1.0-preview.10', prerelease: true },
        { tag_name: 'server-v0.1.0-preview.99', prerelease: false }, { tag_name: 'server-v0.1.0-preview.100', prerelease: true, draft: true },
        { tag_name: 'launcher-v0.2.0-preview.10', prerelease: true }
    ];
    const fetched = await listReleases(async () => Response.json(items));
    assert.equal(selectRelease(fetched, 'server').tag_name, 'server-v9.0.0');
    assert.equal(selectRelease(fetched, 'server', '0.0.0', 'preview').tag_name, 'server-v0.1.0-preview.10');
    assert.equal(selectRelease(fetched, 'launcher', '0.0.0', 'preview').tag_name, 'launcher-v0.2.0-preview.10');
    assert.equal(newerVersion('0.2.0-preview.10', '0.2.0-preview.9'), true);
    assert.equal(newerVersion('0.2.0', '0.2.0-preview.999'), true);
    assert.equal(newerVersion('0.2.0-preview.10', '0.2.0'), false);
    assert.equal(newerVersion('0.3.0-preview.1', '0.2.0'), true);
});

function previewPackages(sequence = 10, sourceCommit = 'a'.repeat(40)) {
    const root = directory('preview-packages');
    for (const name of ['package.json', 'package-lock.json', 'launcher/package.json', 'launcher/package-lock.json',
        'release-notes/launcher.md', 'release-notes/server.md']) put(root, name, fs.readFileSync(path.resolve(__dirname, '../..', name)));
    const result = preparePreview(root, sequence, sourceCommit);
    return { root, ...result };
}

test('preview preparation stamps both component locks and isolated application identity from one source', async () => {
    const item = previewPackages();
    const server = await readJson(path.join(item.root, 'package.json')), launcher = await readJson(path.join(item.root, 'launcher/package.json'));
    assert.equal(plan(item.serverTag, server, launcher).channel, 'preview');
    assert.equal(plan(item.launcherTag, server, launcher).channel, 'preview');
    assert.equal(server.l2soloRelease.minimumLauncherVersion, launcher.version);
    assert.equal(launcher.build.appId, 'com.l2solo.launcher.preview');
    assert.equal(launcher.build.productName, 'L2Solo Launcher Preview');
    assert.equal(launcher.name, 'l2solo-launcher-preview');
    assert.equal(launcher.build.linux.executableName, 'l2solo-launcher-preview');
    assert.equal(launcher.releaseChannel, 'preview');
    for (const [directory, version] of [['', server.version], ['launcher', launcher.version]]) {
        const lock = await readJson(path.join(item.root, directory, 'package-lock.json'));
        assert.equal(lock.version, version); assert.equal(lock.packages[''].version, version);
        assert.equal(lock.name, directory ? launcher.name : server.name);
        assert.equal(lock.packages[''].name, lock.name);
    }
    assert.throws(() => preparePreview(item.root, 11, 'invalid'), /full source commit/);
    assert.throws(() => preparePreview(item.root, 11, 'a'.repeat(40)), /stable base versions/);
});

test('preview feeds and installer reuse require the matching preview launcher and source commit', async () => {
    const item = await launcherFixture('0.2.0-preview.10');
    const manifest = { tag: 'server-v0.1.0-preview.10', minimumLauncherVersion: '0.2.0-preview.10', sourceCommit: 'a'.repeat(40) };
    assert.equal(await serverInstallers(directory('paired-preview'), manifest, item.fetcher), '0.2.0-preview.10');
    assert.ok(Object.values(item.manifest.feeds).every(name => name.startsWith('preview-')));
    await assert.rejects(launcherRelease(item.fetcher), /No compatible stable/);
    await assert.rejects(serverInstallers(directory('wrong-preview-source'), { ...manifest, sourceCommit: 'b'.repeat(40) }, item.fetcher), /same source commit/);
    const newer = await launcherFixture('0.2.0-preview.11');
    await assert.rejects(serverInstallers(directory('wrong-preview-build'), manifest, newer.fetcher), /No compatible preview/);
    assert.equal(await serverInstallers(directory('retry-older-preview'), manifest, item.fetcher, [newer.release, item.release]), '0.2.0-preview.10');
    const broken = { ...item.manifest, channel: 'stable' };
    assert.throws(() => validateLauncherManifest(broken, broken.tag), /channel or source/);
    assert.throws(() => validateLauncherManifest({ ...item.manifest, sourceCommit: undefined }, item.manifest.tag), /channel or source/);
});

test('preview application updater uses only its preview feed and previous preview blockmap', async () => {
    const item = await launcherFixture('0.2.0-preview.10');
    for (const platform of ['win32', 'linux']) {
        const updater = new EventEmitter();
        updater.checkForUpdates = async () => ({ updateInfo: { version: item.manifest.version } });
        updater.downloadUpdate = async () => {};
        const controller = { state: {}, publish() {} };
        const service = new LauncherUpdates({ controller, catalog: { releases: async () => [item.release, { tag_name: 'launcher-v9.0.0' }] },
            currentVersion: '0.2.0-preview.9', channel: 'preview', packaged: true, platform, arch: 'x64', appImage: true,
            fetcher: item.fetcher, createUpdater: options => { assert.equal(options.channel, 'preview-x64'); return updater; } });
        await service.check(); await service.download(); await service.downloadPromise;
        assert.equal(service.state.status, 'downloaded');
        assert.equal(updater.allowPrerelease, true); assert.equal(updater.allowDowngrade, false);
        assert.equal(updater.previousBlockmapBaseUrlOverride, assetUrl('launcher-v0.2.0-preview.9', 'placeholder').replace(/[^/]+$/, ''));
    }
});

test('preview publication targets the tested commit and never changes the stable Latest release', async () => {
    const packages = previewPackages(), item = await launcherFixture(packages.launcherVersion);
    let draft = false; const calls = [], uploaded = [];
    const ghClient = args => {
        calls.push(args);
        if (args[1] === 'view') {
            if (!draft) throw new Error('release not found');
            return JSON.stringify(args.at(-1) === 'assets' ? { assets: uploaded } : { isDraft: true, targetCommitish: packages.sourceCommit });
        }
        if (args[1] === 'create') draft = true;
        if (args[1] === 'upload') uploaded.push({ name: path.basename(args[3]), size: fs.statSync(args[3]).size });
        return '';
    };
    await publishRelease({ tag: packages.launcherTag, directory: item.root, packageRoot: packages.root, ghClient,
        sourceCommit: packages.sourceCommit, fetcher: async () => Response.json([]) });
    const create = calls.find(args => args[1] === 'create'), edit = calls.at(-1);
    assert.ok(create.includes('--prerelease')); assert.ok(create.includes('--latest=false'));
    assert.equal(create[create.indexOf('--target') + 1], packages.sourceCommit);
    assert.ok(!create.includes('--verify-tag'));
    assert.ok(edit.includes('--prerelease=true')); assert.ok(edit.includes('--latest=false'));
    assert.match(fs.readFileSync(edit[edit.indexOf('--notes-file') + 1], 'utf8'), /Preview build from develop/);
    await publishRelease({ tag: packages.launcherTag, directory: item.root, packageRoot: packages.root,
        sourceCommit: packages.sourceCommit, fetcher: item.fetcher, ghClient: args => {
            assert.equal(args[1], 'view', 'Retry must never replace a published preview launcher');
            return JSON.stringify({ isDraft: false, isPrerelease: true, targetCommitish: packages.sourceCommit });
        } });
    await assert.rejects(publishRelease({ tag: packages.launcherTag, directory: item.root, packageRoot: packages.root,
        sourceCommit: packages.sourceCommit, fetcher: item.fetcher, ghClient: () => JSON.stringify({ isDraft: false, isPrerelease: true, targetCommitish: 'b'.repeat(40) }) }), /source commit/);
});

test('server release reuses the exact compatible installers and leaves launcher update metadata canonical', async () => {
    const item = await launcherFixture();
    const root = directory('server-publish');
    const manifest = { minimumLauncherVersion: '1.2.0' };
    assert.equal(await serverInstallers(root, manifest, item.fetcher), '1.3.0');
    for (const name of Object.values(item.manifest.installers).flat()) assert.equal(await sha256(path.join(root, name)), await sha256(path.join(item.root, name)));
    assert.deepEqual(manifest.launcher, { version: '1.3.0', tag: 'launcher-v1.3.0' });
    assert.equal(fs.existsSync(path.join(root, 'latest-x64.yml')), false);
    await assert.rejects(serverInstallers(directory('incompatible'), { minimumLauncherVersion: '2.0.0' }, item.fetcher), /No compatible/);
    put(root, item.manifest.installers['win32-x64'][0], 'corrupt');
    await assert.rejects(serverInstallers(root, manifest, item.fetcher), /checksum mismatch/);
});

test('launcher manifest and feeds reject missing platforms, foreign URLs and mismatched file hashes', async () => {
    const item = await launcherFixture();
    const selected = await launcherRelease(item.fetcher);
    assert.equal(selected.version, '1.3.0');
    const broken = structuredClone(item.manifest); delete broken.feeds['darwin-arm64'];
    assert.throws(() => validateLauncherManifest(broken, broken.tag), /Missing launcher update feed/);
    const target = 'win32-x64', name = item.manifest.feeds[target];
    const info = JSON.parse(fs.readFileSync(path.join(item.root, name), 'utf8'));
    info.files[0].url = 'https://example.com/foreign.exe';
    const text = JSON.stringify(info), manifest = structuredClone(item.manifest);
    Object.assign(manifest.assets.find(asset => asset.name === name), { bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') });
    assert.throws(() => validateFeed(text, manifest, target), /does not match/);
    const invalid = structuredClone(item.manifest); invalid.assets[0].sha256 = 'wrong';
    assert.throws(() => validateLauncherManifest(invalid, invalid.tag), /Invalid launcher release asset/);
});

test('release publisher exposes a complete draft only after every asset is uploaded and verified', async () => {
    const item = await launcherFixture('0.2.0');
    const calls = [], uploaded = [];
    let draft = false;
    const ghClient = args => {
        calls.push(args);
        if (args[1] === 'create') { draft = true; return ''; }
        if (args[1] === 'upload') { uploaded.push({ name: path.basename(args[3]), size: fs.statSync(args[3]).size }); return ''; }
        if (args[1] === 'view') {
            if (!draft) throw new Error('release not found');
            return JSON.stringify(args.at(-1) === 'assets' ? { assets: uploaded } : { body: 'Generated component notes', isDraft: true });
        }
        assert.equal(args[1], 'edit');
        assert.equal(uploaded.length, item.manifest.assets.length + 1);
        assert.ok(args.includes('--draft=false')); assert.ok(args.includes('--latest=false'));
        return '';
    };
    await publishRelease({ tag: 'launcher-v0.2.0', directory: item.root, ghClient,
        fetcher: async () => Response.json([{ tag_name: 'server-v9.0.0' }, { tag_name: 'launcher-v0.1.0' }]) });
    const create = calls.find(args => args[1] === 'create');
    assert.ok(create.includes('--notes-file'));
    assert.ok(!create.includes('--generate-notes'));
    assert.match(fs.readFileSync(create[create.indexOf('--notes-file') + 1], 'utf8'), /Manage your local L2Solo server/);
    assert.equal(calls.at(-1)[1], 'edit');
    await assert.rejects(publishRelease({ tag: 'launcher-v0.2.0', directory: item.root,
        ghClient: () => JSON.stringify({ isDraft: false }), fetcher: async () => { throw new Error('Must not fetch a published version'); } }), /already published/);
    draft = true;
    await assert.rejects(publishRelease({ tag: 'launcher-v0.2.0', directory: item.root,
        fetcher: async () => Response.json([]), ghClient: args => {
            if (args[1] === 'edit') throw new Error('Must not publish an incomplete draft');
            return args.at(-1) === 'assets' ? JSON.stringify({ assets: [] }) : JSON.stringify({ isDraft: true });
        } }), /missing or unexpected assets/);
});

test('Node runtime targets use official platform archive names and stable runtime versions', () => {
    assert.equal(targetFor('22.23.0', 'win32', 'x64').archive, 'node-v22.23.0-win-x64.zip');
    assert.equal(targetFor('22.23.0', 'darwin', 'arm64').archive, 'node-v22.23.0-darwin-arm64.tar.gz');
    assert.equal(targetFor('22.23.0', 'linux', 'x64').archive, 'node-v22.23.0-linux-x64.tar.gz');
    assert.throws(() => targetFor('22.23.0-preview.1'), /Unsupported/);
});

test('Windows runtime ZIP rejects a symlink followed by a duplicate file without writing outside staging', async () => {
    const root = directory('runtime-symlink'), archive = path.join(root, 'runtime.zip');
    const sentinel = path.join(root, 'outside.txt');
    put(root, 'outside.txt', 'original');
    const target = targetFor('22.23.0', 'win32', 'x64');
    await new Promise((resolve, reject) => {
        const zip = archiver('zip'), output = fs.createWriteStream(archive);
        output.on('close', resolve); output.on('error', reject); zip.on('error', reject); zip.pipe(output);
        zip.symlink(`${target.basename}/node.exe`, sentinel);
        zip.append('overwritten', { name: `${target.basename}/node.exe` });
        zip.finalize().catch(reject);
    });
    const bytes = fs.readFileSync(archive), checksum = await sha256(archive);
    await assert.rejects(prepareRuntime(path.join(root, 'output'), { version: '22.23.0', platform: 'win32', arch: 'x64',
        fetcher: async url => new Response(url.endsWith('SHASUMS256.txt') ? `${checksum}  ${target.archive}\n` : bytes) }), /Unsafe Node.js archive entry/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original');
});

test('private Node runtime survives application changes, repairs corruption and never needs system installation', async () => {
    const userData = directory('runtime-profile');
    const runtime = new RuntimeManager({ userData, bundledNode: process.execPath, defaultVersion: process.versions.node,
        fetcher: async () => { throw new Error('No network allowed'); } });
    const cached = await runtime.ensure();
    assert.ok(cached.startsWith(path.join(userData, 'runtimes')));
    assert.notEqual(cached, process.execPath);
    const metadata = await readJson(path.join(path.dirname(cached), 'runtime.json'));
    assert.equal(metadata.version, process.versions.node);
    assert.equal(await sha256(cached), metadata.executableSha256);
    const movedApp = new RuntimeManager({ userData, bundledNode: path.join(temporary, 'old-app-removed'), defaultVersion: process.versions.node });
    assert.equal(await movedApp.ensure(), cached);
    fs.writeFileSync(cached, 'damaged');
    assert.equal(await runtime.ensure(), cached);
    assert.equal(await sha256(cached), await sha256(process.execPath));
    let requests = 0;
    await assert.rejects(prepareRuntime(directory('invalid-runtime'), { version: '22.23.0', fetcher: async url => {
        requests++;
        return new Response(url.endsWith('SHASUMS256.txt') ? `${'0'.repeat(64)}  ${targetFor('22.23.0').archive}\n` : 'corrupt archive');
    } }), /checksum mismatch/);
    assert.equal(requests, 2);
});

test('launcher downloads in the background and installs only after graceful server shutdown', async () => {
    const item = await launcherFixture();
    const controller = new EventEmitter();
    controller.state = {}; controller.publish = () => {};
    controller.child = { pid: 1 }; controller.busy = false;
    const order = [];
    controller.stop = async () => { order.push('stop'); controller.child = null; controller.releasePromise = Promise.resolve().then(() => order.push('drained')); };
    const updater = new EventEmitter();
    updater.checkForUpdates = async () => ({ updateInfo: { version: item.manifest.version } });
    let finishDownload;
    updater.downloadUpdate = () => new Promise(resolve => { finishDownload = resolve; });
    updater.quitAndInstall = () => order.push('install');
    const service = new LauncherUpdates({ controller, catalog: { releases: async () => [item.release] }, currentVersion: '1.2.0',
        packaged: true, platform: 'win32', arch: 'x64', fetcher: item.fetcher, createUpdater: options => {
            assert.equal(options.channel, 'latest-x64'); assert.ok(options.url.includes('/launcher-v1.3.0/')); return updater;
        }, beforeInstall: () => order.push('quit-authorized') });
    await service.check(); await service.download();
    await waitFor(() => finishDownload);
    assert.deepEqual(order, []); assert.ok(controller.child);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.previousBlockmapBaseUrlOverride, 'https://github.com/pmbstyle/L2Solo/releases/download/launcher-v1.2.0/');
    await assert.rejects(service.install(), /Download the launcher/);
    finishDownload(); await service.downloadPromise;
    controller.busy = true;
    await assert.rejects(service.install(), /current server operation/);
    controller.busy = false;
    await service.install();
    assert.deepEqual(order, ['stop', 'drained', 'quit-authorized', 'install']);
    assert.equal(service.state.status, 'installing');
});

test('certificate-free macOS updates use the matching DMG and never stop the server or invoke a native updater', async () => {
    const item = await launcherFixture();
    for (const arch of ['arm64', 'x64']) {
        const controller = { state: {}, publish() {}, child: { pid: 1 }, stop() { throw new Error('Manual download must not stop the server'); } };
        const service = new LauncherUpdates({ controller, catalog: { releases: async () => [item.release] }, currentVersion: '1.2.0',
            packaged: true, platform: 'darwin', arch, fetcher: item.fetcher, createUpdater() { throw new Error('Must not create the signed-app updater'); } });
        await service.check();
        assert.equal(service.state.supported, false);
        assert.equal(service.state.status, 'available');
        assert.equal(service.installerUrl(), assetUrl('launcher-v1.3.0', `L2Solo-Launcher-1.3.0-mac-${arch}.dmg`));
        await assert.rejects(service.download(), /Download this launcher update from GitHub/);
        service.state.status = 'downloaded';
        await assert.rejects(service.install(), /Download the installer/);
        assert.ok(controller.child);
        assert.equal(controller.appUpdating, undefined);
    }
    const pkg = require('../package.json');
    assert.equal(pkg.build.forceCodeSigning, false);
    assert.equal(pkg.build.mac.identity, '-');
    assert.equal(pkg.build.mac.notarize, false);
});

test('certificate-free builds keep automatic NSIS/AppImage updates and route portable/DEB downloads correctly', async () => {
    const item = await launcherFixture();
    const cases = [
        { platform: 'win32', portable: false, supported: true, suffix: 'windows-x64-Setup.exe' },
        { platform: 'win32', portable: true, supported: false, suffix: 'windows-x64-Portable.exe' },
        { platform: 'linux', appImage: true, supported: true, suffix: 'linux-x64.AppImage' },
        { platform: 'linux', appImage: false, supported: false, suffix: 'linux-x64.deb' }
    ];
    for (const entry of cases) {
        const controller = { state: {}, publish() {} };
        const service = new LauncherUpdates({ controller, catalog: { releases: async () => [item.release] }, currentVersion: '1.2.0',
            packaged: true, arch: 'x64', fetcher: item.fetcher, ...entry });
        await service.check();
        assert.equal(service.state.supported, entry.supported);
        assert.equal(service.installerUrl(), assetUrl('launcher-v1.3.0', `L2Solo-Launcher-1.3.0-${entry.suffix}`));
    }
});

async function serverFixture(script, tag = 'v0.1.0', schemaVersion = 1, { sourceCommit = 'a'.repeat(40), minimumLauncherVersion = '0.2.0' } = {}) {
    const stage = directory('server-stage');
    const migrationCheckpoint = schemaVersion === 2
        ? "if(process.env.L2NODE_UPDATE_TRIAL==='1'){require('./database-access.js').beginUpdateMigrations(process.cwd(),JSON.parse(process.env.L2NODE_UPDATE_DATABASES));}\n" : '';
    const contents = { 'package.json': JSON.stringify({ version: tag.replace(/^(server-)?v/, '') }),
        'config/default.ini': '[Database]\npath = tmp/world-data.sqlite\nhistoryPath = tmp/world-history.sqlite\n[General]\nmaxLevel = 78\n',
        'scripts/run-server.js': migrationCheckpoint + script, 'scripts/geodata-release.json': '{}',
        'scripts/database-access.js': fs.readFileSync(path.resolve(__dirname, '../../scripts/database-access.js'), 'utf8'),
        'scripts/geodata-bootstrap.js': 'module.exports={async inspectDirectory(){return {valid:true,fileCount:1}},async ensureGeodata(){return {valid:true,fileCount:1}}};',
        'src/NodeL2.js': '// entry', 'src/Server.js': '// listeners', 'scripts/launcher-population.js': '// status' };
    const files = [];
    for (const [name, value] of Object.entries(contents)) { put(stage, name, value); files.push({ path: name, bytes: Buffer.byteLength(value), sha256: await sha256(path.join(stage, name)) }); }
    const archive = path.join(directory('server-archive'), `L2Solo-Server-${tag.replace(/^server-/, '')}.zip`);
    await new Promise((resolve, reject) => {
        const zip = archiver('zip'), output = fs.createWriteStream(archive);
        output.on('close', resolve); zip.on('error', reject); zip.pipe(output);
        for (const file of files) zip.file(path.join(stage, file.path), { name: file.path });
        zip.finalize().catch(reject);
    });
    const bytes = fs.readFileSync(archive);
    const manifest = validateManifest({ schemaVersion, tag, minimumLauncherVersion,
        ...(channelOf(tag) === 'preview' ? { sourceCommit, channel: 'preview' } : {}),
        ...(schemaVersion === 2 ? { component: 'server', version: tag.replace(/^(server-)?v/, ''), databaseSchemaVersion: 1, startupProtocolVersion: 2, runtime: { version: process.versions.node } } : {}),
        archive: { name: path.basename(archive), bytes: bytes.length, sha256: await sha256(archive) }, files }, tag);
    const release = { tag_name: tag, prerelease: channelOf(tag) === 'preview', assets: [{ name: 'l2solo-release.json', browser_download_url: assetUrl(tag, 'l2solo-release.json') },
        { name: manifest.archive.name, size: bytes.length, browser_download_url: assetUrl(tag, manifest.archive.name) }] };
    return { stage, manifest, release, fetcher: async url => url.includes('api.github.com') ? Response.json([release])
        : url.endsWith('l2solo-release.json') ? Response.json(manifest) : new Response(bytes) };
}
const oldScript = "console.log('GameServer :: successful init'); process.on('message',m=>{if(m.type==='shutdown')process.exit(0)});process.on('disconnect',()=>process.exit(0));";
const migration = `const path=require('node:path'),{DatabaseSync}=require('node:sqlite');
    const world=new DatabaseSync(path.join(process.env.L2NODE_RUNTIME_DIR,'world-data.sqlite'));
    world.exec('CREATE TABLE failed_migration(value TEXT)');world.close();
    const history=new DatabaseSync(path.join(process.env.L2NODE_RUNTIME_DIR,'world-history.sqlite'));
    history.exec("UPDATE bot_life_events SET summary='during-update'");history.close();`;
async function upgrade(script, timeout = 5000) {
    const root = directory('world');
    const initial = await serverFixture(oldScript);
    await applyRelease(root, initial.stage, initial.manifest);
    put(root, 'config/local.ini', ''); prepareWorld(root, process.execPath);
    const next = await serverFixture(script, 'server-v0.2.0', 2);
    const controller = new Controller({ userData: directory('world-profile'), nodePath: process.execPath, fetcher: next.fetcher, startupTimeout: timeout });
    await controller.choose(root); await controller.install();
    assert.equal(controller.state.updatePending, true);
    return { root, controller, initial };
}

test('installation keeps its selected release and runtime when a background check finds a newer incompatible release', async () => {
    for (const phase of ['runtime', 'archive']) {
        const current = await serverFixture(oldScript, 'server-v0.1.0', 2);
        const newer = await serverFixture(oldScript + '\n// newer release', 'server-v0.2.0', 2);
        newer.manifest.minimumLauncherVersion = '99.0.0';
        newer.manifest.runtime.version = '24.0.0';
        const root = directory(`release-race-${phase}`), selectedRuntimes = [];
        let controller, installing = false, discoveredNewer = false;
        const discoverNewer = async () => { discoveredNewer = true; await controller.checkUpdates(); };
        const runtimeManager = { async ensure(version) {
            selectedRuntimes.push(version);
            if (installing && phase === 'runtime' && !discoveredNewer) await discoverNewer();
            return process.execPath;
        } };
        const fetcher = async url => {
            if (phase === 'archive' && url === assetUrl(current.manifest.tag, current.manifest.archive.name) && !discoveredNewer) await discoverNewer();
            if (url.includes('api.github.com')) return (discoveredNewer ? newer : current).fetcher(url);
            return (url.includes(`/${newer.manifest.tag}/`) ? newer : current).fetcher(url);
        };
        controller = new Controller({ userData: directory(`race-profile-${phase}`), nodePath: process.execPath, runtimeManager, fetcher });
        await controller.choose(root);
        installing = true;
        await controller.install();
        assert.equal(discoveredNewer, true, phase);
        assert.deepEqual(selectedRuntimes.filter(Boolean), [current.manifest.runtime.version], phase);
        assert.equal(controller.state.version, current.manifest.tag, phase);
        assert.equal((await readJson(markerPath(root))).tag, current.manifest.tag, phase);
        assert.equal((await readJson(path.join(root, 'package.json'))).version, '0.1.0', phase);
        assert.equal(controller.state.latest.tag, newer.manifest.tag, phase);
        assert.equal(controller.state.latest.updateAvailable, true, phase);
        assert.equal(controller.state.latest.launcherUpdateRequired, true, phase);
        assert.ok(controller.state.logs.some(entry => entry.line.startsWith(`Installed ${current.manifest.tag}:`)), phase);
    }
});

const configuredMigration = `const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
    fs.writeFileSync('tmp/trial-started','yes');
    const ini=fs.readFileSync(process.env.L2NODE_CONFIG_FILE,'utf8');
    const world=new DatabaseSync(path.resolve(ini.match(/^path\\s*=\\s*(.+)$/m)[1]));
    world.exec('CREATE TABLE wrong_world_migration(value INTEGER)');world.close();
    const history=new DatabaseSync(path.resolve(ini.match(/^historyPath\\s*=\\s*(.+)$/m)[1]));
    history.exec("UPDATE bot_life_events SET summary='wrong-world-migration'");history.close();process.exit(7);`;
function alternateWorld(root) {
    const paths = [path.join(root, 'tmp/other-world.sqlite'), path.join(root, 'tmp/other-history.sqlite')];
    fs.copyFileSync(path.join(root, 'tmp/world-data.sqlite'), paths[0]);
    fs.copyFileSync(path.join(root, 'tmp/world-history.sqlite'), paths[1]);
    return paths;
}

test('pending trial refuses changed world/history paths without touching either pair and can retry the original pair', async () => {
    for (const changed of ['world', 'history', 'both', 'during-preparation']) {
        const { root, controller } = await upgrade(configuredMigration);
        const original = [path.join(root, 'tmp/world-data.sqlite'), path.join(root, 'tmp/world-history.sqlite')];
        const other = alternateWorld(root);
        const files = [...original, ...other], hashes = await Promise.all(files.map(sha256));
        const local = path.join(root, 'config/local.ini'), ini = fs.readFileSync(local, 'utf8');
        const modified = ini.replace('path = tmp/world-data.sqlite', `path = ${changed === 'history' ? original[0] : other[0]}`)
            .replace('historyPath = tmp/world-history.sqlite', `historyPath = ${changed === 'world' ? original[1] : other[1]}`);
        const prepare = controller.ensureGeodata.bind(controller);
        if (changed === 'during-preparation') controller.ensureGeodata = async () => { await prepare(); fs.writeFileSync(local, modified); };
        else fs.writeFileSync(local, modified);
        try {
            await assert.rejects(controller.start(), /Database paths changed/, changed);
            assert.equal(controller.child, null, changed);
            assert.equal(fs.existsSync(path.join(root, 'tmp/trial-started')), false, changed);
            assert.equal((await readJson(journalPath(root))).phase, 'awaiting-start', changed);
            assert.deepEqual(await Promise.all(files.map(sha256)), hashes, changed);
        } finally { await controller.stop(); }
        controller.ensureGeodata = prepare;
        fs.writeFileSync(local, ini);
        await controller.start();
        await waitFor(() => !controller.child && !controller.busy);
        await controller.releasePromise;
        assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0', changed);
        assert.deepEqual(query(root, process.execPath, "SELECT name FROM sqlite_master WHERE name='wrong_world_migration'"), [], changed);
        assert.ok(query(root, process.execPath, 'SELECT summary FROM bot_life_events', true).every(row => row.summary === 'original'), changed);
        assert.deepEqual(await Promise.all(other.map(sha256)), hashes.slice(2), changed);
    }
});

test('pending trial rejects replacing a database file at the same configured path', async () => {
    const { root, controller } = await upgrade(configuredMigration);
    const world = path.join(root, 'tmp/world-data.sqlite'), moved = `${world}.original`;
    const [other] = alternateWorld(root);
    fs.renameSync(world, moved);
    fs.copyFileSync(other, world);
    try {
        await assert.rejects(controller.start(), /database was replaced/);
        assert.equal(controller.child, null);
        assert.equal(fs.existsSync(path.join(root, 'tmp/trial-started')), false);
        assert.equal((await readJson(journalPath(root))).phase, 'awaiting-start');
    } finally { fs.rmSync(world); fs.renameSync(moved, world); await controller.stop(); }
});

test('pending trial detects a retargeted database symlink', { skip: process.platform === 'win32' ? 'Creating symlinks requires Windows developer mode or elevation.' : false }, async () => {
    const { root, controller } = await upgrade(configuredMigration);
    const world = path.join(root, 'tmp/world-data.sqlite'), moved = `${world}.original`;
    const [other] = alternateWorld(root);
    fs.renameSync(world, moved);
    fs.symlinkSync(other, world);
    try {
        await assert.rejects(controller.start(), /Database paths changed/);
        assert.equal(controller.child, null);
        assert.equal(fs.existsSync(path.join(root, 'tmp/trial-started')), false);
        assert.equal((await readJson(journalPath(root))).phase, 'awaiting-start');
    } finally { fs.rmSync(world); fs.renameSync(moved, world); await controller.stop(); }
});

test('a refused startup preserves a replacement world when recovery resumes after a launcher restart', async () => {
    const { root } = await upgrade(configuredMigration);
    const world = path.join(root, 'tmp/world-data.sqlite'), moved = `${world}.original`;
    const journal = await readJson(journalPath(root));
    fs.renameSync(world, moved);
    fs.copyFileSync(moved, world);
    query(root, process.execPath, "UPDATE characters SET name='ReplacementWorld' WHERE id=11 RETURNING name");
    const expectedHash = await sha256(world);
    const expectedHistoryHash = await sha256(path.join(root, 'tmp/world-history.sqlite'));
    await writeJson(journalPath(root), { ...journal, phase: 'starting' });
    rejectUpdateBeforeMigrations(root, journal.databaseBackup.files);
    assert.equal((await readJson(journalPath(root))).phase, 'rejected');
    const restarted = new Controller({ userData: directory('refused-profile'), nodePath: process.execPath });
    await restarted.choose(root);
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
    assert.equal(await sha256(world), expectedHash);
    assert.equal(await sha256(path.join(root, 'tmp/world-history.sqlite')), expectedHistoryHash);
    assert.equal(fs.existsSync(journalPath(root)), false);
});

test('a crash before the server database guard preserves a replacement world without a rejection marker', async () => {
    const { root } = await upgrade(configuredMigration);
    const world = path.join(root, 'tmp/world-data.sqlite'), moved = `${world}.original`;
    const journal = await readJson(journalPath(root));
    fs.renameSync(world, moved); fs.copyFileSync(moved, world);
    query(root, process.execPath, "UPDATE characters SET name='ReplacementBeforeGuard' WHERE id=11 RETURNING name");
    const hash = await sha256(world);
    await writeJson(journalPath(root), { ...journal, phase: 'starting' });
    const restarted = new Controller({ userData: directory('pre-guard-crash-profile'), nodePath: process.execPath });
    await restarted.choose(root);
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
    assert.equal(await sha256(world), hash);
    assert.equal(fs.existsSync(journalPath(root)), false);
});

test('legacy recovery refuses an unidentified replacement database before changing code or data', async () => {
    const { root } = await upgrade(configuredMigration);
    const world = path.join(root, 'tmp/world-data.sqlite'), moved = `${world}.original`;
    const journal = await readJson(journalPath(root));
    fs.renameSync(world, moved); fs.copyFileSync(moved, world);
    query(root, process.execPath, "UPDATE characters SET name='LegacyReplacement' WHERE id=11 RETURNING name");
    const hash = await sha256(world), codeHash = await sha256(path.join(root, 'scripts/run-server.js'));
    await writeJson(journalPath(root), { ...journal, startupProtocolVersion: 1, phase: 'starting' });
    const restarted = new Controller({ userData: directory('legacy-recovery-profile'), nodePath: process.execPath });
    await assert.rejects(restarted.choose(root), /Automatic recovery stopped/);
    assert.equal(await sha256(world), hash);
    assert.equal(await sha256(path.join(root, 'scripts/run-server.js')), codeHash);
    assert.equal((await readJson(journalPath(root))).phase, 'starting');
});

test('an interrupted database rollback can resume after its own file replacements', async () => {
    const { root, controller } = await upgrade(configuredMigration);
    const journal = await readJson(journalPath(root));
    await writeJson(journalPath(root), { ...journal, phase: 'migrating' });
    query(root, process.execPath, "UPDATE characters SET name='InterruptedMigration' WHERE id=11 RETURNING name");
    const release = await controller.guard();
    try {
        await assert.rejects(recover(root, () => {}, { restoreDatabases: async current => {
            await controller.helper('update-data.cjs', ['restore', JSON.stringify({ id: current.id, ...current.databaseBackup })]);
            throw new Error('Simulated interruption after database replacement');
        } }), /Simulated interruption/);
    } finally { await release(); }
    assert.equal((await readJson(journalPath(root))).phase, 'recovering');
    const restarted = new Controller({ userData: directory('resume-rollback-profile'), nodePath: process.execPath });
    await restarted.choose(root);
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
    assert.equal(query(root, process.execPath, 'SELECT name FROM characters WHERE id=11')[0].name, 'Bot');
    assert.equal(fs.existsSync(journalPath(root)), false);
});

test('failed migration startup restores both databases and previous code before another start', async () => {
    const { root, controller } = await upgrade(`${migration}\nprocess.exit(7);`);
    await assert.rejects(controller.wipe('all', 'WIPE ALL'), /pending update/);
    await controller.start();
    await waitFor(() => !controller.child && !controller.busy);
    await controller.releasePromise;
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
    assert.equal(fs.readFileSync(path.join(root, 'scripts/run-server.js'), 'utf8'), oldScript);
    assert.deepEqual(query(root, process.execPath, "SELECT name FROM sqlite_master WHERE name='failed_migration'"), []);
    assert.ok(query(root, process.execPath, 'SELECT summary FROM bot_life_events', true).every(row => row.summary === 'original'));
    assert.match(controller.state.error, /Previous server files and world data were restored/);
    await controller.start(); await waitFor(() => controller.state.phase === 'running'); await controller.stop();
});

test('an imported newer world is rejected before replacing code or changing its databases', async () => {
    const root = directory('future-world');
    const initial = await serverFixture(oldScript);
    await applyRelease(root, initial.stage, initial.manifest);
    put(root, 'config/local.ini', ''); prepareWorld(root, process.execPath);
    query(root, process.execPath, 'INSERT INTO schema_migrations(version, appliedAt) VALUES (999, 1) RETURNING version');
    const next = await serverFixture(oldScript + '\n// new code', 'server-v0.2.0', 2);
    const controller = new Controller({ userData: directory('future-profile'), nodePath: process.execPath, fetcher: next.fetcher });
    await controller.choose(root);
    await assert.rejects(controller.install(), /schema 999 requires a newer server/);
    assert.equal(fs.readFileSync(path.join(root, 'scripts/run-server.js'), 'utf8'), oldScript);
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
    assert.equal(query(root, process.execPath, 'SELECT MAX(version) AS version FROM schema_migrations')[0].version, 999);
    assert.equal(fs.existsSync(journalPath(root)), false);
});

test('successful trial requires both bound ports and initialized world before admitting players', async () => {
    const script = `${migration}\nprocess.on('message',m=>{if(m.type==='launcher:update-commit'){require('fs').writeFileSync('tmp/players-admitted','yes')} if(m.type==='shutdown')process.exit(0)});
        process.on('disconnect',()=>process.exit(0));
        process.send({type:'launcher:initialized'}); process.send({type:'launcher:listening',service:'GameServer'});
        setTimeout(()=>{if(require('fs').existsSync('tmp/players-admitted'))process.exit(9);process.send({type:'launcher:listening',service:'AuthServer'})},75);`;
    const { root, controller } = await upgrade(script);
    await controller.start();
    try { await waitFor(() => controller.state.phase === 'running' && fs.existsSync(path.join(root, 'tmp/players-admitted'))); }
    finally { await controller.stop(); }
    assert.equal(fs.existsSync(journalPath(root)), false);
    assert.equal((await readJson(markerPath(root))).tag, 'server-v0.2.0');
    assert.equal(query(root, process.execPath, "SELECT name FROM sqlite_master WHERE name='failed_migration'").length, 1);
    const restarted = new Controller({ userData: directory('restart-profile'), nodePath: process.execPath });
    await restarted.choose(root);
    assert.ok(query(root, process.execPath, 'SELECT summary FROM bot_life_events', true).every(row => row.summary === 'during-update'));
});

test('startup timeout and process interruption retain recoverable world snapshots', async () => {
    const { root, controller } = await upgrade(`${migration}\nprocess.on('message',m=>{if(m.type==='shutdown')process.exit(0)});`, 150);
    await controller.start(); await waitFor(() => !controller.child && !controller.busy); await controller.releasePromise;
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
    assert.deepEqual(query(root, process.execPath, "SELECT name FROM sqlite_master WHERE name='failed_migration'"), []);
    const second = await upgrade(oldScript);
    const journal = await readJson(journalPath(second.root));
    await writeJson(journalPath(second.root), { ...journal, phase: 'migrating' });
    query(second.root, process.execPath, "UPDATE bot_life_events SET summary='interrupted' RETURNING summary", true);
    const restarted = new Controller({ userData: directory('recovery-profile'), nodePath: process.execPath });
    await restarted.choose(second.root);
    assert.equal((await readJson(markerPath(second.root))).tag, 'v0.1.0');
    assert.ok(query(second.root, process.execPath, 'SELECT summary FROM bot_life_events', true).every(row => row.summary === 'original'));
});

test('developer checkout can run but archive installation never overwrites it', async () => {
    const root = directory('developer');
    const initial = await serverFixture(oldScript);
    await applyRelease(root, initial.stage, initial.manifest); put(root, '.git', 'gitdir: elsewhere');
    const controller = new Controller({ userData: directory('developer-profile'), nodePath: process.execPath,
        fetcher: async () => { throw new Error('Must not fetch or install'); } });
    await controller.choose(root);
    await assert.rejects(controller.install(), /developer Git checkout/);
    assert.equal(fs.readFileSync(path.join(root, 'scripts/run-server.js'), 'utf8'), oldScript);
});

test('server archive downloads while the old world runs and is reused when applying offline', async () => {
    const root = directory('background-world');
    const initial = await serverFixture(oldScript);
    await applyRelease(root, initial.stage, initial.manifest);
    put(root, 'config/local.ini', ''); prepareWorld(root, process.execPath);
    const next = await serverFixture(`${migration}\nprocess.exit(1);`, 'server-v0.2.0', 2);
    let archives = 0;
    const fetcher = async (url, options) => { if (url.endsWith('.zip')) archives++; return next.fetcher(url, options); };
    const controller = new Controller({ userData: directory('background-profile'), nodePath: process.execPath, fetcher });
    await controller.choose(root); await controller.start();
    try {
        await waitFor(() => controller.state.phase === 'running');
        await controller.downloadServerUpdate(); await controller.preparePromise;
        assert.equal(controller.state.serverDownload.status, 'ready');
        assert.equal(controller.state.phase, 'running'); assert.ok(controller.child);
        assert.equal(archives, 1);
    } finally { await controller.stop(); }
    await controller.install();
    assert.equal(archives, 1);
    assert.equal(controller.state.updatePending, true);
    await controller.start(); await waitFor(() => !controller.child && !controller.busy); await controller.releasePromise;
    assert.equal((await readJson(markerPath(root))).tag, 'v0.1.0');
});

test('a preview server upgrades the previous preview world while stable installations remain separate', async () => {
    const root = directory('preview-world');
    const initial = await serverFixture(oldScript, 'server-v0.1.0-preview.9', 2, { minimumLauncherVersion: '0.2.0-preview.9' });
    await applyRelease(root, initial.stage, initial.manifest);
    put(root, 'config/local.ini', ''); prepareWorld(root, process.execPath);
    const owner = path.join(root, '.l2solo/folder.json');
    const stable = new Controller({ userData: directory('stable-profile'), nodePath: process.execPath });
    await assert.rejects(stable.choose(root), /belongs to the preview channel/);
    assert.equal(fs.existsSync(owner), false);
    const ready = `${migration}\nconsole.log('GameServer :: successful init');
        process.on('message',m=>{if(m.type==='shutdown')process.exit(0)});process.on('disconnect',()=>process.exit(0));
        for(const service of ['AuthServer','GameServer'])process.send({type:'launcher:listening',service});process.send({type:'launcher:initialized'});`;
    const next = await serverFixture(ready, 'server-v0.1.0-preview.10', 2, { minimumLauncherVersion: '0.2.0-preview.10' });
    const controller = new Controller({ userData: directory('preview-profile'), nodePath: process.execPath, channel: 'preview',
        launcherVersion: '0.2.0-preview.10', fetcher: next.fetcher });
    await controller.choose(root); await controller.install();
    assert.equal(controller.state.releaseChannel, 'preview');
    assert.equal((await readJson(owner)).channel, 'preview');
    assert.equal(controller.state.updatePending, true);
    await controller.start();
    try { await waitFor(() => controller.state.phase === 'running'); }
    finally { await controller.stop(); }
    assert.equal((await readJson(markerPath(root))).tag, 'server-v0.1.0-preview.10');
    assert.equal(fs.existsSync(journalPath(root)), false);
    assert.equal(query(root, process.execPath, "SELECT name FROM sqlite_master WHERE name='failed_migration'").length, 1);
    const reserved = directory('stable-reserved');
    await stable.choose(reserved);
    await assert.rejects(controller.choose(reserved), /belongs to the stable channel/);
    assert.equal((await readJson(path.join(reserved, '.l2solo/folder.json'))).channel, 'stable');
});

function prepareStartupFixture(root) {
    for (const name of ['src/NodeL2.js', 'src/Server.js', 'src/Global.js', 'scripts/database-access.js']) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.resolve(__dirname, '../..', name), target);
    }
}

test('real server TCP listeners reject players until the launcher commits the initialized world', async () => {
    const root = directory('startup-protocol');
    prepareStartupFixture(root);
    const env = { ...process.env, L2NODE_UPDATE_TRIAL: '1', L2NODE_LAUNCHER_STATUS: '0', L2SOLO_FIXTURE_SOURCE_ROOT: fs.realpathSync(root) };
    const databases = ['world.sqlite', 'world.history.sqlite'].map(name => ({
        path: path.join(fs.realpathSync(root), name), canonicalPath: canonicalPath(path.join(root, name)), existed: false
    }));
    env.L2NODE_UPDATE_DATABASES = JSON.stringify(databases);
    await writeJson(journalPath(root), { id: crypto.randomUUID(), startupProtocolVersion: 2, phase: 'starting',
        databaseBackup: { files: databases }, operations: [] });
    delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    const child = fork(path.join(__dirname, 'startup-fixture.cjs'), [], { cwd: root, env, silent: true });
    const messages = []; let stderr = '', exited = false;
    child.on('message', message => messages.push(message)); child.on('exit', () => { exited = true; });
    child.stderr.on('data', data => { stderr += data; });
    const read = port => new Promise((resolve, reject) => {
        let text = '';
        const socket = net.connect(port, '127.0.0.1');
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Session probe timed out.')); });
        socket.on('data', data => { text += data; }); socket.on('end', () => resolve(text));
        socket.on('error', error => error.code === 'ECONNRESET' ? resolve(text) : reject(error));
    });
    try {
        await waitFor(() => exited || messages.filter(message => message.type === 'launcher:listening').length === 2 && messages.some(message => message.type === 'launcher:initialized'));
        assert.equal(exited, false, stderr);
        assert.equal((await readJson(journalPath(root))).phase, 'migrating');
        const ports = messages.filter(message => message.type === 'launcher:listening').map(message => message.port);
        assert.deepEqual(await Promise.all(ports.map(read)), ['', '']);
        assert.equal(messages.some(message => message.type === 'fixture:observer'), false);
        child.send({ type: 'launcher:update-commit' });
        await waitFor(() => messages.some(message => message.type === 'fixture:observer'));
        assert.deepEqual(await Promise.all(ports.map(read)), ['player-admitted', 'player-admitted']);
    } finally {
        if (!exited) child.send({ type: 'shutdown' });
        await waitFor(() => exited);
    }
});

test('real server rejects a changed database pair before acquiring its lock or announcing readiness', async () => {
    const root = directory('startup-path-mismatch');
    prepareStartupFixture(root);
    const env = { ...process.env, L2NODE_UPDATE_TRIAL: '1', L2NODE_LAUNCHER_STATUS: '0', L2SOLO_FIXTURE_SOURCE_ROOT: fs.realpathSync(root),
        L2NODE_UPDATE_DATABASES: JSON.stringify(['snapshot-world.sqlite', 'snapshot-world.history.sqlite'].map(name => ({
            path: path.join(root, name), canonicalPath: canonicalPath(path.join(root, name)), existed: false
        }))) };
    delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    const child = fork(path.join(__dirname, 'startup-fixture.cjs'), [], { cwd: root, env, silent: true });
    const messages = []; let stderr = '', exited = false;
    child.on('message', message => messages.push(message)); child.on('exit', () => { exited = true; });
    child.stderr.on('data', data => { stderr += data; });
    try {
        await waitFor(() => exited || messages.some(message => message.type === 'launcher:initialized'));
        assert.equal(exited, true, 'Server must refuse a pair that differs from the launcher snapshot.');
        assert.match(stderr, /Database paths changed before update startup/);
        assert.equal(messages.some(message => ['launcher:initialized', 'launcher:listening'].includes(message.type)), false);
        assert.equal(fs.existsSync(path.join(root, 'world.sqlite.access.sqlite')), false);
    } finally {
        if (!exited) child.send({ type: 'shutdown' });
        await waitFor(() => exited);
    }
});
