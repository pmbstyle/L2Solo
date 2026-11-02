'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const archiver = require('archiver');
const { readJson, writeJson, managedPath, sha256, acquireLock } = require('../main/files.cjs');
const { readConfig, settings, saveSettings } = require('../main/config.cjs');
const { assetUrl, validateManifest, latestRelease, download } = require('../main/releases.cjs');
const { applyRelease, extractRelease, markerPath, recover } = require('../main/installer.cjs');
const { Controller } = require('../main/controller.cjs');
const { news } = require('../main/news.cjs');
const { help, settingHelp } = require('../main/settings-help.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-launcher-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10 }));
const directory = name => fs.mkdtempSync(path.join(temporary, `${name}-`));
async function put(root, relative, content) {
    await fs.promises.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.promises.writeFile(path.join(root, relative), content);
}
const initialFiles = {
    'package.json': JSON.stringify({ name: 'nodel2', version: '0.1.0' }),
    'config/default.ini': '[Database]\npath = tmp/world.sqlite\n[General]\nprogressionPreset = x1\nexpRate = 1\nmaxLevel = 78\n[BotPopulation]\nenabled = true\nmaxPlayingPopulation = 1700\n[OpenRouter]\nenabled = false\napiKey =\n[WorldObserver]\nenabled = true\nhostname = 127.0.0.1\nport = 8088\n',
    'scripts/run-server.js': "console.log('GameServer :: successful init'); process.on('message', m => { if (m.type === 'shutdown') { require('fs').writeFileSync('tmp/drained', 'yes'); setTimeout(() => process.exit(0), 20); } }); process.on('disconnect', () => process.exit(0));",
    'scripts/geodata-release.json': '{}',
    'scripts/geodata-bootstrap.js': `const fs = require('fs'); const path = require('path'); module.exports = {
        async inspectDirectory(root) { return { valid: fs.existsSync(path.join(root, 'ready')), fileCount: 1 }; },
        async ensureGeodata(options) { fs.mkdirSync(options.targetDirectory, {recursive:true}); fs.writeFileSync(path.join(options.targetDirectory, 'ready'), 'yes'); return {valid:true}; }
    };`,
    'src/NodeL2.js': '// server entry',
    'data/Html/welcome.html': 'hello'
};
async function fixture(contents = initialFiles, tag = 'v0.1.0') {
    const stage = directory('stage');
    const files = [];
    for (const [relative, value] of Object.entries(contents)) {
        await put(stage, relative, value);
        files.push({ path: relative, bytes: Buffer.byteLength(value), sha256: await sha256(path.join(stage, relative)) });
    }
    return { stage, manifest: { schemaVersion: 1, tag, minimumLauncherVersion: '0.1.0', archive: { name: `L2Solo-Server-${tag}.zip`, bytes: 1, sha256: '0'.repeat(64) }, files } };
}
async function zip(stage, files, target) {
    await new Promise((resolve, reject) => {
        const archive = archiver('zip');
        const output = fs.createWriteStream(target);
        output.on('close', resolve); archive.on('error', reject); archive.pipe(output);
        for (const file of files) archive.file(path.join(stage, file.path), { name: file.path });
        archive.finalize().catch(reject);
    });
}
async function installed() {
    const root = directory('server');
    const item = await fixture();
    await applyRelease(root, item.stage, item.manifest);
    await put(root, 'data/Geodata/ready', 'yes');
    return root;
}
const controller = () => new Controller({ userData: directory('profile'), nodePath: process.execPath });

test('manifest rejects traversal, runtime data, case collisions and invalid file checksums', async () => {
    for (const name of ['../src/a', '/src/a', 'src/../config/local.ini', 'src\\a', 'config/local.ini', 'data/Geodata/17_25.l2j', 'tmp/world.sqlite', 'src/CON.txt', 'data/a.sqlite']) assert.throws(() => managedPath(name));
    const item = await fixture();
    assert.equal(validateManifest(item.manifest, 'v0.1.0'), item.manifest);
    assert.throws(() => validateManifest({ ...item.manifest, tag: 'develop' }, 'develop'));
    assert.throws(() => validateManifest({ ...item.manifest, files: [...item.manifest.files, { ...item.manifest.files[0], path: 'PACKAGE.JSON' }] }, 'v0.1.0'));
    assert.throws(() => validateManifest({ ...item.manifest, files: item.manifest.files.map(file => ({ ...file, sha256: 'wrong' })) }, 'v0.1.0'));
});

test('fresh installation and update preserve world, settings, geodata, saves and user files', async () => {
    const root = await installed();
    for (const name of ['tmp/world.sqlite', 'tmp/saves/world/save.sqlite', 'config/local.ini', 'data/Geodata/17_25.l2j', 'data/Html/custom.html']) await put(root, name, `private:${name}`);
    const replacement = await fixture({ ...initialFiles, 'src/NodeL2.js': '// new server entry' }, 'v0.2.0');
    const result = await applyRelease(root, replacement.stage, replacement.manifest);
    assert.equal(result.changedFiles, 1);
    assert.equal(await fs.promises.readFile(path.join(root, 'src/NodeL2.js'), 'utf8'), '// new server entry');
    assert.equal(await fs.promises.readFile(path.join(result.backup, 'src/NodeL2.js'), 'utf8'), '// server entry');
    for (const name of ['tmp/world.sqlite', 'tmp/saves/world/save.sqlite', 'config/local.ini', 'data/Geodata/17_25.l2j', 'data/Html/custom.html']) assert.equal(await fs.promises.readFile(path.join(root, name), 'utf8'), `private:${name}`);
    assert.equal((await readJson(markerPath(root))).tag, 'v0.2.0');
    assert.equal((await applyRelease(root, replacement.stage, replacement.manifest)).changedFiles, 0);
});

test('update removes obsolete release files while retaining modified obsolete files', async () => {
    const root = directory('obsolete');
    const old = await fixture({ ...initialFiles, 'src/old.js': 'old', 'src/edited.js': 'original' });
    await applyRelease(root, old.stage, old.manifest);
    await put(root, 'src/edited.js', 'local edit');
    const next = await fixture(initialFiles, 'v0.2.0');
    await applyRelease(root, next.stage, next.manifest);
    assert.equal(fs.existsSync(path.join(root, 'src/old.js')), false);
    assert.equal(await fs.promises.readFile(path.join(root, 'src/edited.js'), 'utf8'), 'local edit');
});

test('interrupted update journal restores overwritten and newly created files', async () => {
    const root = await installed();
    const previous = await readJson(markerPath(root));
    const id = crypto.randomUUID();
    await put(root, `.l2solo/backups/${id}/src/NodeL2.js`, '// server entry');
    await put(root, 'src/NodeL2.js', 'half-written');
    await put(root, 'src/new.js', 'uncommitted');
    await writeJson(path.join(root, '.l2solo/transaction.json'), { id, previous, operations: [
        { path: 'src/NodeL2.js', existed: true }, { path: 'src/new.js', existed: false }
    ] });
    await recover(root);
    await recover(root);
    assert.equal(await fs.promises.readFile(path.join(root, 'src/NodeL2.js'), 'utf8'), '// server entry');
    assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false);
    assert.equal((await readJson(markerPath(root))).tag, previous.tag);
});

test('archive extraction rejects a valid archive with corrupted payload checksums', async () => {
    const item = await fixture();
    const archive = path.join(directory('archive'), 'release.zip');
    await zip(item.stage, item.manifest.files, archive);
    const valid = directory('unpack');
    await extractRelease(archive, valid, item.manifest);
    const manifest = structuredClone(item.manifest);
    manifest.files[0].sha256 = 'f'.repeat(64);
    await assert.rejects(extractRelease(archive, directory('bad-unpack'), manifest), /checksum mismatch/);
});

test('archive extraction rejects symlink entries before they can escape staging', async () => {
    const item = await fixture();
    const archive = path.join(directory('symlink-archive'), 'release.zip');
    const sentinel = path.join(directory('outside-staging'), 'sentinel.txt');
    await fs.promises.writeFile(sentinel, 'original');
    await new Promise((resolve, reject) => {
        const zip = archiver('zip');
        const stream = fs.createWriteStream(archive);
        stream.on('close', resolve); zip.on('error', reject); zip.pipe(stream);
        zip.symlink('src/NodeL2.js', sentinel);
        zip.append('overwritten', { name: 'src/NodeL2.js' });
        zip.finalize().catch(reject);
    });
    await assert.rejects(extractRelease(archive, directory('symlink-unpack'), item.manifest), /symbolic links/);
    assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'original');
});

test('download rejects checksum errors before installation', async () => {
    const filename = path.join(directory('download'), 'archive.zip');
    await assert.rejects(download('https://github.com/test.zip', filename, { bytes: 4, sha256: '0'.repeat(64) }, null,
        async () => new Response('test')), /checksum mismatch/);
});

test('settings preserve comments, unknown overrides and secrets while validating changes', async () => {
    const root = await installed();
    await put(root, 'config/local.ini', '; keep this comment\n[OpenRouter]\napiKey = private-key\n[Future]\ncustom = untouched\n[General]\nexpRate = 2\nexpRate = 3\n');
    assert.equal(settings(root).find(section => section.id === 'General').fields.find(field => field.key === 'spRate').value, '3');
    await saveSettings(root, [ { section: 'General', key: 'expRate', value: '5' }, { section: 'BotPopulation', key: 'maxPlayingPopulation', value: '500' } ]);
    const raw = await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8');
    assert.match(raw, /keep this comment/);
    assert.equal(readConfig(root).OpenRouter.apiKey, 'private-key');
    assert.equal(readConfig(root).Future.custom, 'untouched');
    assert.equal(readConfig(root).General.expRate, '5');
    assert.equal(readConfig(root).BotPopulation.maxPlayingPopulation, '500');
    assert.equal(readConfig(root).AI, undefined, 'viewing settings must not shadow OpenRouter with an empty AI section');
    for (const change of [ { section: 'General', key: 'maxLevel', value: '79' }, { section: 'BotPopulation', key: 'maxPlayingPopulation', value: '-1' },
        { section: 'AI', key: 'apiKey', value: 'key\n[Database]\npath=other' }, { section: 'General', key: 'missing', value: '1' } ]) {
        await assert.rejects(saveSettings(root, [change]));
        assert.equal(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), raw);
    }
});

test('every bundled launcher setting has scoped help, with units and comment fallback for server extensions', async () => {
    const root = await installed();
    await put(root, 'config/default.ini', await fs.promises.readFile(path.resolve(__dirname, '../../config/default.ini'), 'utf8'));
    const groups = settings(root);
    for (const group of groups) for (const field of group.fields) {
        assert.ok(help[group.id]?.[field.key], `Missing explanation: ${group.id}.${field.key}`);
        assert.ok(field.description.length > 20);
    }
    const description = section => groups.find(group => group.id === section).fields.find(field => field.key === 'enabled').description;
    assert.notEqual(description('AI'), description('ClanSimulation'));
    assert.notEqual(description('AI'), description('WorldObserver'));
    assert.equal(settingHelp('Database', 'checkpointIntervalMs').unit, 'ms');
    assert.equal(settingHelp('Database', 'checkpointMinWalBytes').unit, 'bytes');
    await fs.promises.appendFile(path.join(root, 'config/default.ini'), '\n[Extension]\n; Controls the test extension service.\ncustomEnabled = true\n');
    const extended = settings(root).find(group => group.id === 'Extension');
    assert.equal(extended.fields[0].description, 'Controls the test extension service.');
});

test('presentation hides the requested settings, groups related fields and preserves all hidden INI values', async () => {
    const root = await installed();
    const defaults = await fs.promises.readFile(path.resolve(__dirname, '../../config/default.ini'), 'utf8');
    await put(root, 'config/default.ini', defaults);
    const original = '; Hidden settings remain configured here\n[BotPopulation]\nenabled = false\ndeveloperDiagnostics = true\ndirectorEnabled = false\nmaxPlayingPopulation = 1700\n[Database]\npath = tmp/world.sqlite\nhistoryPath = tmp/custom-history.sqlite\ncheckpointIntervalMs = 7777\ncustomPrivateOption = keep-me\n[General]\nprotocol = 656\n[GameServer]\nid = 23\nmaxOnline = 250\npvp = true\n[AuthServer]\nprotocol = 0xc621\nblowfishKey = local-test-key\n[Enchant]\ncrystalWeaponChance = 12\n[ClanSimulation]\nbloodMarkItemId = 1419\nactionLeaseMs = 3456\n[ClanWars]\nreviewMs = 12345\nintelTtlMs = 56789\n';
    await put(root, 'config/local.ini', original);
    const groups = settings(root);
    const fields = section => groups.find(group => group.id === section).fields;
    const keys = section => fields(section).map(field => field.key);
    assert.deepEqual(keys('BotPopulation'), ['maxPlayingPopulation','starterBotsPerRace','generatedColdBatchSize','generatedColdSeedDelayMs',
        'pvpAggression','knowledgeErrorsEnabled','coldHonestTravel','ambientScenesEnabled','ambientSceneCooldownMs','ambientPairCooldownMs','ambientSceneTtlMs','devLogPlayerChat','debug']);
    assert.deepEqual(keys('General'), ['maxLevel','progressionPreset','expRate','spRate','adenaRate','dropChanceRate','spoilRate','newbieRewardPolicy','pkDeathDropChance','showMonsterLevel']);
    assert.deepEqual(keys('GameServer'), ['hostname','port','advertisedHostname','playerWarehouseSlots']);
    assert.deepEqual(keys('AuthServer'), ['hostname','port','autoCreate']);
    assert.deepEqual(keys('Database'), ['path']);
    assert.deepEqual(keys('Enchant'), ['weaponChance','blessedWeaponChance','maxWeapon','armorChance','blessedArmorChance','maxArmor',
        'accessoryChance','blessedAccessoryChance','maxAccessory','safeMax','safeMaxFull']);
    assert.deepEqual(keys('ClanWars'), ['enabled','hostilityThreshold','minHarmEpisodes','quietWithdrawMs','redeclareCooldownMs',
        'minMembers','maxMembers','maxActiveOperations','operationMs','operationCooldownMs','lossWindowMs','counterattackCooldownMs']);
    for (const key of ['maxBotMemberShare','bloodMarkItemId','bloodMarkSourceNpcId','strategyRetryMs','actionBatchSize','actionLeaseMs','actionRetryMs']) {
        assert.equal(keys('ClanSimulation').includes(key), false, key);
    }
    assert.deepEqual([...new Set(fields('BotPopulation').map(field => field.group))], ['Population & seeding','Behavior & travel','Social scenes','Logging']);
    assert.deepEqual([...new Set(fields('Enchant').map(field => field.group))], ['Weapons','Armour','Jewellery','Safe enchant levels']);
    const before = readConfig(root);
    assert.equal(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), original, 'reading the presentation must not rewrite INI files');
    await saveSettings(root, [{section:'BotPopulation',key:'maxPlayingPopulation',value:'1600'}]);
    const saved = original.replace('maxPlayingPopulation = 1700', 'maxPlayingPopulation = 1600');
    assert.equal(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), saved);
    assert.equal(await fs.promises.readFile(path.join(root, 'config/default.ini'), 'utf8'), defaults);
    const after = readConfig(root);
    before.BotPopulation.maxPlayingPopulation = '1600';
    assert.deepEqual(after, before, 'hidden values must remain readable by the runtime configuration loader');
    await assert.rejects(saveSettings(root, [{section:'Database',key:'historyPath',value:'tmp/other.sqlite'}]), /Unknown server setting/);
    assert.equal(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), saved);
});

test('enum settings publish selectable choices and reject unsupported values without changing the INI', async () => {
    const root = await installed();
    await put(root, 'config/default.ini', await fs.promises.readFile(path.resolve(__dirname, '../../config/default.ini'), 'utf8'));
    await put(root, 'config/local.ini', '[OpenRouter]\nreasoningEffort = legacy-value\n[Future]\nreasoningEffort = custom-value\n');
    const field = (section, key) => settings(root).find(group => group.id === section).fields.find(field => field.key === key);
    for (const section of ['AI']) {
        assert.equal(field(section, 'reasoningEffort').type, 'select');
        assert.deepEqual(field(section, 'reasoningEffort').options, ['off', 'low', 'medium', 'high']);
        assert.deepEqual(field(section, 'completionLimitParam').options, ['max_tokens', 'max_completion_tokens']);
    }
    assert.equal(field('AI', 'reasoningEffort').value, 'legacy-value', 'reading an unknown value must not silently replace it');
    assert.equal(field('Future', 'reasoningEffort').type, 'text', 'enum definitions must be scoped to their sections');
    assert.equal(field('AI', 'model').type, 'text');
    assert.equal(field('AI', 'enabled').type, 'boolean');
    assert.equal(settings(root).some(section => ['OpenRouter', 'Langfuse'].includes(section.id)), false);
    assert.deepEqual(field('General', 'progressionPreset').options, ['x1', 'x10', 'x50']);
    assert.deepEqual(field('General', 'newbieRewardPolicy').options, ['strict', 'grant', 'always']);
    await saveSettings(root, [
        { section: 'AI', key: 'reasoningEffort', value: 'high' },
        { section: 'AI', key: 'completionLimitParam', value: 'max_completion_tokens' },
        { section: 'General', key: 'newbieRewardPolicy', value: 'grant' }
    ]);
    assert.equal(readConfig(root).OpenRouter.reasoningEffort, 'legacy-value');
    assert.equal(readConfig(root).AI.reasoningEffort, 'high');
    assert.equal(readConfig(root).AI.providerSort, 'price', 'hidden legacy routing must survive migration');
    const raw = await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8');
    for (const change of [
        { section: 'AI', key: 'reasoningEffort', value: 'xhigh' },
        { section: 'AI', key: 'reasoningEffort', value: 'false' },
        { section: 'AI', key: 'completionLimitParam', value: 'max_output_tokens' },
        { section: 'General', key: 'progressionPreset', value: 'x100' },
        { section: 'General', key: 'newbieRewardPolicy', value: 'unknown' }
    ]) {
        await assert.rejects(saveSettings(root, [change]), /Choose one of/);
        assert.equal(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), raw);
    }
});

test('unified AI preserves the configured provider during migration and keeps custom AI independent of legacy settings', async () => {
    const root = await installed();
    await put(root, 'config/local.ini', '[OpenRouter]\nenabled=true\napiKey=keep-secret\nmodel=legacy-model\nproviderOrder=OpenAI\n[Langfuse]\nenabled=true\n');
    const ai = () => Object.fromEntries(settings(root).find(section => section.id === 'AI').fields.map(field => [field.key,field.value]));
    assert.equal(ai().model, 'legacy-model');
    assert.equal(ai().apiUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(readConfig(root).AI, undefined);
    await saveSettings(root, [{section:'AI',key:'apiUrl',value:'http://127.0.0.1:1234/v1/chat/completions'}]);
    assert.equal(readConfig(root).AI.apiKey, 'keep-secret');
    assert.equal(readConfig(root).AI.enabled, 'true');
    assert.equal(readConfig(root).AI.model, 'legacy-model');
    assert.equal(readConfig(root).AI.providerOrder, 'OpenAI');
    assert.equal(readConfig(root).Langfuse.enabled, 'true', 'hiding developer settings must not erase them');
    await put(root, 'config/local.ini', '[AI]\napiUrl=http://localhost:9000/v1/chat/completions\nmodel=local-model\n');
    assert.equal(ai().model, 'local-model');
    assert.equal(ai().apiKey, '', 'custom AI must not inherit the legacy provider secret');
    await assert.rejects(saveSettings(root,[{section:'Langfuse',key:'enabled',value:'false'}]),/Unknown server setting/);
});

test('folder attachment rejects unrelated folders and leaves them untouched', async () => {
    const root = directory('unrelated');
    await put(root, 'important.txt', 'keep');
    await assert.rejects(controller().choose(root), /empty folder or an existing/);
    assert.deepEqual(await fs.promises.readdir(root), ['important.txt']);
});

test('a first installation interrupted before file deployment remains attached on restart', async () => {
    const root = directory('incomplete-install');
    const app = controller();
    await app.choose(root);
    const release = await app.guard();
    await release(); // The lock creates tmp/ before a release is deployed.
    await put(root, '.l2solo/staging-interrupted.zip', 'partial download');
    const restarted = new Controller({ userData: app.userData, nodePath: process.execPath });
    await restarted.initialize();
    assert.equal(restarted.state.root, await fs.promises.realpath(root));
    assert.equal(restarted.state.installed, false);
    assert.equal(restarted.state.error, null);
});

test('installation operation lock rejects a second launcher', async () => {
    const root = directory('locked');
    const release = await acquireLock(root);
    try { await assert.rejects(acquireLock(root), /Another launcher/); }
    finally { await release(); }
    const again = await acquireLock(root);
    await again();
});

test('database guard blocks updates to a running world and releases on disconnect', async () => {
    const root = await installed();
    const app = controller();
    await app.choose(root);
    const release = await app.guard();
    try { await assert.rejects(app.guard(), /world is in use/); }
    finally { await release(); }
    const next = await app.guard();
    await next();
    const child = spawn(process.execPath, [path.resolve(__dirname, '../main/db-guard.cjs'), path.join(root, 'tmp/world.sqlite')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await once(child, 'message');
    child.disconnect();
    await once(child, 'exit');
    const recovered = await app.guard();
    await recovered();
});

test('controller attaches, starts once, streams logs and waits for graceful shutdown', async () => {
    const root = await installed();
    const app = controller();
    await app.choose(root);
    assert.equal(app.state.geodata.valid, true);
    await app.start();
    try {
        await assert.rejects(app.start(), /already running/);
        if (app.state.phase !== 'running') await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Server did not become ready')), 5000);
            const onState = state => { if (state.phase === 'running') { clearTimeout(timeout); app.off('state', onState); resolve(); } };
            app.on('state', onState);
        });
        assert.ok(app.state.logs.some(entry => /successful init/.test(entry.line)));
        await assert.rejects(app.saveSettings([{ section: 'General', key: 'maxLevel', value: '70' }]), /Stop the server/);
    } finally { await app.stop(); }
    assert.equal(app.state.phase, 'stopped');
    assert.equal(await fs.promises.readFile(path.join(root, 'tmp/drained'), 'utf8'), 'yes');
});

test('controller downloads and installs a release end to end with progress and repairs', async () => {
    const item = await fixture();
    const archive = path.join(directory('install-archive'), 'server.zip');
    await zip(item.stage, item.manifest.files, archive);
    const bytes = await fs.promises.readFile(archive);
    item.manifest.archive.bytes = bytes.length;
    item.manifest.archive.sha256 = await sha256(archive);
    const release = { tag_name: item.manifest.tag, draft: false, prerelease: false, body: 'Release notes', assets: [
        { name: 'l2solo-release.json', browser_download_url: assetUrl(item.manifest.tag, 'l2solo-release.json') },
        { name: item.manifest.archive.name, size: bytes.length, digest: `sha256:${item.manifest.archive.sha256}`, browser_download_url: assetUrl(item.manifest.tag, item.manifest.archive.name) }
    ] };
    const fetcher = async url => url.includes('/api.github.com/') ? Response.json([release])
        : url.endsWith('/l2solo-release.json') ? Response.json(item.manifest) : new Response(bytes);
    const app = new Controller({ userData: directory('install-profile'), nodePath: process.execPath, fetcher });
    const root = directory('fresh-world');
    const progress = [];
    app.on('state', state => progress.push(state.progress.percent));
    await app.choose(root);
    await app.install();
    assert.equal(app.state.version, 'v0.1.0');
    assert.equal(app.state.geodata.valid, true);
    assert.equal(app.state.progress.percent, 100);
    assert.ok(progress.some(value => value > 0 && value < 100));
    assert.equal(app.state.latest.updateAvailable, false);
    await put(root, 'src/NodeL2.js', 'corrupted');
    await app.install();
    assert.equal(await fs.promises.readFile(path.join(root, 'src/NodeL2.js'), 'utf8'), '// server entry');
});

test('release discovery handles unpublished tags and untrusted asset URLs', async () => {
    await assert.rejects(latestRelease(async () => new Response('', { status: 404 })), /No stable release/);
    await assert.rejects(latestRelease(async () => Response.json([{ tag_name: 'v0.1.0', assets: [
        { name: 'l2solo-release.json', browser_download_url: 'https://attacker.example/manifest' }
    ] }])), /does not contain launcher/);
});

test('news falls back to clearly marked preview and never accepts arbitrary executable links', async () => {
    assert.equal((await news(async () => new Response('', { status: 503 }))).preview, true);
    const article = { id: '1', title: 'Update', excerpt: 'New adventures', category: 'UPDATE', publishedAt: '2026-10-31', url: 'https://l2solo.com/news/1' };
    const valid = await news(async () => Response.json({ schemaVersion: 1, articles: [article] }));
    assert.equal(valid.preview, false);
    assert.equal(valid.articles[0].title, 'Update');
    assert.equal((await news(async () => Response.json({ schemaVersion: 1, articles: [{ ...article, url: 'file:///private/file' }] }))).preview, true);
});
