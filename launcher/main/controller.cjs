'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { networkInterfaces } = require('node:os');
const { readJson, writeJson, acquireLock, canonicalPath } = require('./files.cjs');
const { readConfig, settings, saveSettings } = require('./config.cjs');
const { latestRelease, newerVersion, versionOf, channelOf } = require('./releases.cjs');
const { markerPath, journalPath, recover, commitRelease, needsDatabaseRollback, stageRelease, installRelease } = require('./installer.cjs');
const { ReleaseCatalog } = require('./release-catalog.cjs');
const { holdLock } = require('./locks.cjs');
const { helperPath } = require('./helper-path.cjs');

function environment(root) {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'L2NODE_SHARED_CONFIG_FILE', 'L2NODE_GEODATA_RELEASE',
        'L2NODE_GEODATA_URL', 'L2NODE_GEODATA_SHA256', 'L2NODE_PROGRESSION_RATE', 'L2NODE_GEODATA_USAGE_FILE', 'L2NODE_UPDATE_DATABASES']) delete env[key];
    return { ...env, L2NODE_CONFIG_FILE: path.join(root, 'config/local.ini'), L2NODE_GEODATA_DIR: path.join(root, 'data/Geodata'),
        L2NODE_RUNTIME_DIR: path.join(root, 'tmp'), L2NODE_NO_BROWSER: '1', L2NODE_LAUNCHER_STATUS: '1' };
}

function loginConnection(config, interfaces = networkInterfaces()) {
    const auth = config.AuthServer || {};
    const advertised = String(config.GameServer?.advertisedHostname || '').trim();
    const listen = String(auth.hostname || '').trim();
    const local = Object.values(interfaces).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address || '127.0.0.1';
    const host = advertised || (listen && !['0.0.0.0', '::', '*'].includes(listen) ? listen : local);
    const port = Number(auth.port) || 2106;
    return { host, port, address: `${host.includes(':') ? `[${host}]` : host}:${port}` };
}

class Controller extends EventEmitter {
    constructor({ userData, nodePath, fetcher = fetch, runtimeManager = null, catalog = null, startupTimeout = 600000,
        channel = 'stable', launcherVersion = require('../package.json').version }) {
        super();
        if (!['stable', 'preview'].includes(channel)) throw new Error('Unknown update channel.');
        this.channel = channel;
        this.launcherVersion = launcherVersion;
        this.userData = userData;
        this.nodePath = nodePath;
        this.controlNodePath = nodePath;
        this.runtimeManager = runtimeManager;
        this.catalog = catalog || new ReleaseCatalog({ userData, fetcher });
        this.startupTimeout = startupTimeout;
        this.fetcher = fetcher;
        this.child = null;
        this.busy = false;
        this.latest = null;
        this.state = { root: null, installed: false, version: null, releaseChannel: channel, phase: 'stopped', startedAt: null, latest: null,
            geodata: null, world: null, connection: null, population: null, progress: { percent: 0, label: 'Choose a server folder' }, logs: [], error: null };
    }
    snapshot() { return { ...this.state, busy: this.busy || Boolean(this.appUpdating) || Boolean(this.launching) }; }
    publish() { this.emit('state', this.snapshot()); }
    progress(value) {
        const changed = this.state.progress?.label !== value.label;
        this.state.progress = value;
        if (changed || Date.now() - (this.lastProgressAt || 0) > 100 || value.percent === 100) {
            this.lastProgressAt = Date.now();
            this.publish();
        }
    }
    log(message) {
        const line = String(message).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd();
        if (!line) return;
        this.state.logs.push({ at: Date.now(), line });
        this.state.logs = this.state.logs.slice(-250);
        if (this.state.root) {
            const file = path.join(this.state.root, 'tmp/logs/desktop-server.log');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
        }
        this.publish();
    }
    async initialize() {
        const preferences = await readJson(path.join(this.userData, 'preferences.json'), {});
        if (preferences.root) {
            try { await this.choose(preferences.root); }
            catch (error) { this.state.error = error.message; this.publish(); }
        }
        return this.snapshot();
    }
    async operation(work, kind = 'files') {
        if (this.busy || this.child || this.appUpdating || this.launching && kind !== 'start') throw new Error('Stop the server and wait for the current operation to finish.');
        if (!this.state.root) throw new Error('Choose an installation folder first.');
        this.busy = true;
        this.state.operation = kind === 'start' ? 'files' : kind;
        this.state.error = null;
        this.publish();
        let unlock;
        try {
            await this.releasePromise;
            unlock = await acquireLock(this.state.root, this.controlNodePath);
            return await work();
        } catch (error) {
            this.state.error = error.message;
            throw error;
        } finally {
            await unlock?.();
            this.busy = false;
            this.state.operation = null;
            this.publish();
        }
    }
    async choose(directory) {
        if (this.busy || this.child || this.appUpdating || this.launching) throw new Error('Stop the server before changing its folder.');
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Choose an absolute installation folder.');
        await fs.promises.mkdir(directory, { recursive: true });
        const root = await fs.promises.realpath(directory);
        for (const name of ['.l2solo', 'config']) {
            try { if ((await fs.promises.lstat(path.join(root, name))).isSymbolicLink()) throw new Error(`The ${name} folder must not be a symbolic link.`); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const entries = await fs.promises.readdir(root);
        const installed = fs.existsSync(path.join(root, 'scripts/run-server.js')) && fs.existsSync(path.join(root, 'config/default.ini'));
        const ownership = await readJson(path.join(root, '.l2solo/folder.json'));
        const installation = await readJson(markerPath(root));
        const installedChannel = installation ? channelOf(installation.tag) : ownership?.channel;
        if (installedChannel && installedChannel !== this.channel) throw new Error(`This server belongs to the ${installedChannel} channel. Choose a separate folder for the ${this.channel} server.`);
        if (!installed && ownership?.application !== 'L2Solo' && entries.some(name => name !== '.l2solo' && name !== '.DS_Store')) throw new Error('Choose an empty folder or an existing L2Solo server.');
        const previousState = structuredClone(this.state);
        this.state.root = root;
        this.state.installed = installed;
        try {
            await this.operation(async () => {
                await writeJson(path.join(root, '.l2solo/folder.json'), { application: 'L2Solo', schemaVersion: 1, channel: this.channel });
                if (fs.existsSync(path.join(root, '.l2solo/transaction.json'))) {
                    const release = await this.guard();
                    try { await this.recoverUpdate(true); } finally { await release(); }
                }
                const marker = await readJson(markerPath(root));
                if (this.runtimeManager) this.nodePath = await this.runtimeManager.ensure(marker?.runtime?.version, value => this.progress(value));
                await this.inspect();
                await this.refreshWorld();
                await writeJson(path.join(this.userData, 'preferences.json'), { root });
            });
        } catch (error) { this.state = previousState; this.state.error = error.message; this.publish(); throw error; }
        return this.snapshot();
    }
    async inspect() {
        const root = this.state.root;
        this.state.installed = fs.existsSync(path.join(root, 'scripts/run-server.js')) && fs.existsSync(path.join(root, 'config/default.ini'));
        this.state.connection = this.state.installed ? loginConnection(readConfig(root)) : null;
        this.state.population = null;
        const marker = await readJson(markerPath(root));
        this.state.developerMode = fs.existsSync(path.join(root, '.git'));
        this.state.updatePending = (await readJson(journalPath(root)))?.phase === 'awaiting-start';
        const pkg = this.state.installed ? await readJson(path.join(root, 'package.json')) : null;
        this.state.version = marker?.tag || (pkg?.version ? `v${pkg.version} · existing installation` : null);
        this.refreshUpdateAvailability();
        this.state.geodata = null;
        if (this.state.installed) {
            this.progress({ percent: 0, label: 'Verifying installed geodata' });
            this.state.geodata = await this.helper('geodata.cjs', ['check']);
        }
        this.progress({ percent: this.state.geodata?.valid ? 100 : 0,
            label: this.state.geodata?.valid ? 'All files ready' : this.state.installed ? 'Geodata needs installation or repair' : 'Ready to install the latest release' });
    }
    async checkUpdates(force = true) {
        await this.findRelease(force);
        return this.snapshot();
    }
    async findRelease(force = true) {
        const release = await latestRelease(this.fetcher, await this.catalog.releases(force), this.channel);
        this.latest = release;
        const { manifest, archiveUrl, ...summary } = release;
        const current = versionOf(this.state.version?.split(' ·')[0] || 'v0.0.0');
        this.state.latest = { ...summary, updateAvailable: newerVersion(versionOf(summary.tag), current),
            launcherUpdateRequired: newerVersion(manifest.minimumLauncherVersion || '0.1.0', this.launcherVersion) };
        this.publish();
        return release;
    }
    refreshUpdateAvailability() {
        if (this.state.latest) this.state.latest.updateAvailable = newerVersion(versionOf(this.state.latest.tag), versionOf(this.state.version?.split(' ·')[0] || 'v0.0.0'));
    }
    helper(filename, args = [], onMessage = () => {}, nodePath = this.nodePath) {
        return new Promise((resolve, reject) => {
            let result, reportedError;
            const child = spawn(nodePath, [helperPath(filename), this.state.root, ...args], {
                env: environment(this.state.root), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
            });
            let stderr = '';
            child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
            child.on('message', message => {
                if (message.type === 'result') result = message.result;
                if (message.type === 'error') reportedError = message.message;
                onMessage(message);
            });
            child.on('error', reject);
            child.on('exit', code => code === 0 && result ? resolve(result)
                : reject(new Error(reportedError || stderr || `Server helper failed (${code}).`)));
        });
    }
    async guard() {
        const journal = await readJson(path.join(this.state.root, '.l2solo/transaction.json'));
        const config = !journal?.databasePath && this.state.installed ? readConfig(this.state.root) : {};
        const database = journal?.databaseBackup?.files?.[0]?.canonicalPath || journal?.databasePath
            || path.resolve(this.state.root, config.Database?.path || 'tmp/nodel2.sqlite');
        return holdLock(database, this.controlNodePath);
    }
    async recoverUpdate(keepPending = false) {
        const journal = await readJson(journalPath(this.state.root));
        const recoveryNode = needsDatabaseRollback(journal) && this.runtimeManager
            ? await this.runtimeManager.ensure(journal.previous?.runtime?.version) : this.nodePath;
        return recover(this.state.root, message => this.log(message), { keepPending, restoreDatabases: journal =>
            this.helper('update-data.cjs', ['restore', JSON.stringify({ id: journal.id, ...journal.databaseBackup })], () => {}, recoveryNode) });
    }
    async ensureGeodata() {
        this.state.geodata = null;
        this.progress({ label: 'Checking Chronicle 4 geodata', percent: 76 });
        this.state.geodata = await this.helper('geodata.cjs', [], message => {
            if (message.type === 'log') {
                this.log(message.message);
                this.progress({ label: message.message, percent: this.state.progress.percent });
            }
            if (message.type === 'progress') this.progress({ label: 'Downloading Chronicle 4 geodata',
                percent: 76 + (message.total ? message.bytes / message.total : 0) * 21, bytes: message.bytes, total: message.total });
        });
        this.progress({ label: 'All files ready', percent: 100 });
    }
    async downloadServerUpdate() {
        if (this.busy || this.appUpdating || this.state.developerMode || this.state.updatePending) throw new Error('Wait for the current operation or pending update to finish.');
        if (this.preparing) return this.snapshot();
        const release = await this.findRelease();
        if (newerVersion(release.manifest.minimumLauncherVersion || '0.1.0', this.launcherVersion)) throw new Error('Update the launcher before downloading this server release.');
        this.preparing = true;
        this.state.serverDownload = { status: 'downloading', tag: release.tag, percent: 0 };
        this.publish();
        this.preparePromise = stageRelease(path.join(this.userData, 'server-downloads'), release, progress => {
            this.state.serverDownload = { status: 'downloading', tag: release.tag, ...progress }; this.publish();
        }, this.fetcher).then(() => { this.state.serverDownload = { status: 'ready', tag: release.tag, percent: 100 }; })
            .catch(error => { this.state.serverDownload = { status: 'error', tag: release.tag, error: error.message }; })
            .finally(() => { this.preparing = false; this.publish(); });
        return this.snapshot();
    }
    async install() {
        if (this.preparing) throw new Error('Wait for the server download to finish.');
        await this.operation(async () => {
            if (this.state.developerMode) throw new Error('This folder is a developer Git checkout. Update it with your development tools, or choose a separate folder for a managed server.');
            this.progress({ label: 'Finding the latest stable release', percent: 1 });
            const target = await this.findRelease();
            if (newerVersion(target.manifest.minimumLauncherVersion || '0.1.0', this.launcherVersion)) throw new Error('Update the launcher in Updates before installing this server release.');
            if (this.state.installed && newerVersion(versionOf(this.state.version.split(' ·')[0]), versionOf(target.tag))) throw new Error('Automatic server downgrades are not supported.');
            const nextNode = this.runtimeManager ? await this.runtimeManager.ensure(target.manifest.runtime?.version, value => this.progress(value)) : this.nodePath;
            const unlockWorld = await this.guard();
            try {
                await this.recoverUpdate();
                const options = { trial: target.manifest.schemaVersion === 2,
                    cacheDirectory: path.join(this.userData, 'server-downloads'),
                    snapshotDatabases: async (id, world) => {
                        const backup = await this.helper('update-data.cjs', ['snapshot', JSON.stringify({ id, ...world })]);
                        return { ...backup, files: backup.files.map(file => ({ ...file, canonicalPath: canonicalPath(file.path) })) };
                    },
                    restoreDatabases: journal => this.helper('update-data.cjs', ['restore', JSON.stringify({ id: journal.id, ...journal.databaseBackup })]) };
                const result = await installRelease(this.state.root, target, value => this.progress(value), this.fetcher, options);
                this.nodePath = nextNode;
                this.state.installed = true;
                this.state.connection = loginConnection(readConfig(this.state.root));
                this.state.version = target.tag;
                this.state.updatePending = (await readJson(journalPath(this.state.root)))?.phase === 'awaiting-start';
                if (this.state.updatePending) {
                    const pending = await readJson(journalPath(this.state.root));
                    const world = this.worldOptions();
                    const history = world.historyPath ? path.resolve(this.state.root, world.historyPath)
                        : world.databasePath.endsWith('.sqlite') ? `${world.databasePath.slice(0, -7)}.history.sqlite` : `${world.databasePath}.history.sqlite`;
                    if (pending.databaseBackup.files[0].path !== world.databasePath || pending.databaseBackup.files[1].path !== history) {
                        await this.recoverUpdate();
                        await this.inspect();
                        throw new Error('This update changes the database location. Set an explicit World database path before updating.');
                    }
                }
                this.log(`Installed ${target.tag}: ${result.changedFiles} files changed.${result.backup ? ` Previous files: ${result.backup}` : ''}`);
                await this.ensureGeodata();
                await this.refreshWorld();
                this.refreshUpdateAvailability();
                this.state.serverDownload = null;
            } finally { await unlockWorld(); }
        });
        return this.snapshot();
    }
    async repair() {
        await this.operation(async () => {
            if (!this.state.installed) throw new Error('Install a server first.');
            const release = await this.guard();
            try { await this.ensureGeodata(); } finally { await release(); }
        });
        return this.snapshot();
    }
    getSettings() { if (!this.state.installed) return []; return settings(this.state.root); }
    worldOptions() {
        const config = readConfig(this.state.root).Database || {};
        return { databasePath: path.resolve(this.state.root, config.path || 'tmp/nodel2.sqlite'), historyPath: config.historyPath || '' };
    }
    async assertPendingWorld(journal = undefined) {
        journal ??= await readJson(journalPath(this.state.root));
        if (journal?.phase !== 'awaiting-start') return journal;
        const files = journal.databaseBackup?.files;
        if (!Array.isArray(files) || files.length !== 2) throw new Error('The pending update has no valid world snapshot.');
        const world = this.worldOptions();
        const paths = [world.databasePath, world.historyPath ? path.resolve(this.state.root, world.historyPath)
            : world.databasePath.endsWith('.sqlite') ? `${world.databasePath.slice(0, -7)}.history.sqlite` : `${world.databasePath}.history.sqlite`];
        for (const [index, file] of files.entries()) {
            if (paths[index] !== file.path || canonicalPath(paths[index]) !== (file.canonicalPath || canonicalPath(file.path))) {
                throw new Error('Database paths changed since this update was installed. Restore the original world and history database paths before starting.');
            }
            const stat = fs.existsSync(paths[index]) ? fs.statSync(paths[index], { bigint: true }) : null;
            if (file.existed !== Boolean(stat) || file.identity && (file.identity.device !== String(stat?.dev) || file.identity.inode !== String(stat?.ino))) {
                throw new Error('The world or history database was replaced since this update was installed. Keep the pending snapshot and restore the original database files before starting.');
            }
        }
        return journal;
    }
    async refreshWorld() {
        const root = this.state.root;
        const revision = this.worldRevision;
        const world = this.state.installed
            ? await this.helper('world-data.cjs', ['list', JSON.stringify(this.worldOptions())]) : null;
        if (this.state.root !== root || this.worldRevision !== revision) return this.snapshot();
        this.state.world = world;
        this.publish();
        return this.snapshot();
    }
    async backup(action, payload = {}) {
        if (this.state.updatePending && action === 'load') throw new Error('Start the server to verify its pending update before restoring a backup.');
        if (!['create', 'load', 'delete'].includes(action)) throw new Error('Unknown backup operation.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid backup request.');
        if (action !== 'create' && payload.confirmed !== true) throw new Error('Confirm this backup operation first.');
        if (payload.name !== undefined && (typeof payload.name !== 'string' || payload.name.length > 120)) throw new Error('Backup name must be 120 characters or fewer.');
        if (action !== 'create' && typeof payload.id !== 'string') throw new Error('Choose a backup first.');
        await this.operation(async () => {
            if (!this.state.installed || this.state.phase !== 'stopped') throw new Error('Stop the server before managing backups.');
            const result = await this.helper('world-data.cjs', [action, JSON.stringify({ ...this.worldOptions(), id: payload.id,
                name: payload.name?.trim() || `Backup — ${new Date().toLocaleString('en-GB')}` })]);
            this.state.world = result;
            this.worldRevision = (this.worldRevision || 0) + 1;
            this.log(`${{ create: 'Backup created', load: 'Backup restored', delete: 'Backup deleted' }[action]}: ${result.result.name || payload.id}`);
        }, 'backup');
        return this.snapshot();
    }
    async wipe(scope, confirmation) {
        if (this.state.updatePending) throw new Error('Start the server to verify its pending update before wiping world data.');
        if (!['bots', 'players', 'all'].includes(scope)) throw new Error('Choose bots, players, or all.');
        if (confirmation !== `WIPE ${scope.toUpperCase()}`) throw new Error(`Type WIPE ${scope.toUpperCase()} to confirm.`);
        await this.operation(async () => {
            if (!this.state.installed || this.state.phase !== 'stopped') throw new Error('Stop the server before wiping world data.');
            const result = await this.helper('world-data.cjs', ['wipe', JSON.stringify({ ...this.worldOptions(), scope, confirmation })]);
            this.state.world = result;
            this.worldRevision = (this.worldRevision || 0) + 1;
            this.log(`World wipe completed: ${scope}, ${result.result.characters} characters, ${result.result.accounts} accounts.`);
        }, 'wipe');
        return this.snapshot();
    }
    async saveSettings(changes) {
        if (this.state.updatePending && changes.some(change => change.section === 'Database')) throw new Error('Start the server to verify its pending update before changing database settings.');
        let result;
        await this.operation(async () => {
            result = await saveSettings(this.state.root, changes);
            this.state.connection = loginConnection(readConfig(this.state.root));
            if (changes.some(change => change.section === 'Database' && ['path', 'historyPath'].includes(change.key))) await this.refreshWorld();
        }, 'settings');
        return result;
    }
    observerUrl() {
        const config = readConfig(this.state.root).WorldObserver || {};
        if (config.enabled === 'false') throw new Error('Enable World Observer in settings first.');
        const hostname = ['0.0.0.0', '::'].includes(config.hostname) ? '127.0.0.1' : config.hostname || '127.0.0.1';
        const url = new URL('http://127.0.0.1/observer/');
        url.hostname = hostname.includes(':') ? `[${hostname}]` : hostname;
        url.port = config.port || '8088';
        return url.toString();
    }
    async start() {
        if (this.child || this.busy || this.appUpdating || this.launching) throw new Error('The server or another operation is already running.');
        if (!this.state.installed) throw new Error('Install a server first.');
        this.launching = true;
        try {
            this.state.connection = loginConnection(readConfig(this.state.root));
            this.state.population = null;
            await this.operation(async () => {
                await this.assertPendingWorld();
                const release = await this.guard();
                try {
                    await this.recoverUpdate(true);
                    const marker = await readJson(markerPath(this.state.root));
                    if (this.runtimeManager) this.nodePath = await this.runtimeManager.ensure(marker?.runtime?.version, value => this.progress(value));
                    await this.ensureGeodata();
                    await this.assertPendingWorld();
                }
                finally { await release(); }
            }, 'start');
            const unlock = await acquireLock(this.state.root, this.controlNodePath);
            try {
                const journal = await this.assertPendingWorld();
                const trial = journal?.phase === 'awaiting-start';
                if (trial) await writeJson(journalPath(this.state.root), { ...journal, phase: 'starting' });
                let committed = !trial, commitPromise;
                const ready = new Set();
                const child = spawn(this.nodePath, [path.join(this.state.root, 'scripts/run-server.js')], {
                    cwd: this.state.root, env: { ...environment(this.state.root), L2NODE_UPDATE_TRIAL: trial ? '1' : '0',
                        L2NODE_UPDATE_DATABASES: trial ? JSON.stringify(journal.databaseBackup.files.map(file => ({ path: file.path,
                            canonicalPath: file.canonicalPath || canonicalPath(file.path), existed: file.existed, identity: file.identity }))) : '' },
                    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                });
                this.child = child;
                this.state.phase = 'starting';
                this.state.error = null;
                this.state.startedAt = Date.now();
                let pending = '';
                const onData = data => {
                    pending += String(data);
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop();
                    for (const line of lines) {
                        if (!trial && /GameServer\s*:: successful init/.test(line)) this.state.phase = 'running';
                        this.log(line);
                    }
                };
                child.stdout.on('data', onData);
                child.stderr.on('data', onData);
                child.on('message', message => {
                    if (trial && !committed && this.child === child && this.state.phase === 'starting') {
                        if (message?.type === 'launcher:listening' && ['AuthServer', 'GameServer'].includes(message.service)) ready.add(message.service);
                        if (message?.type === 'launcher:initialized') ready.add('world');
                        if (ready.size === 3 && !commitPromise) {
                            commitPromise = commitRelease(this.state.root).then(() => {
                                committed = true;
                                clearTimeout(this.trialTimer);
                                if (this.child === child && child.connected && this.state.phase === 'starting') {
                                    child.send({ type: 'launcher:update-commit' }, () => {});
                                    this.state.phase = 'running';
                                    this.state.updatePending = false;
                                    this.log('Server update verified. World is open to players.');
                                }
                            }).catch(error => { this.state.error = error.message; this.stop().catch(cause => this.log(cause.message)); });
                        }
                    }
                    if (this.child !== child || this.state.phase === 'stopping' || message?.type !== 'launcher:population') return;
                    if (![message.bots, message.players, message.capacity].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) return;
                    this.state.population = { bots: message.bots, players: message.players, total: message.bots + message.players,
                        capacity: message.capacity, updatedAt: Date.now() };
                    this.publish();
                });
                child.on('error', error => { this.state.error = error.message; this.publish(); });
                child.once('close', (code, signal) => {
                    if (pending) this.log(pending);
                    clearTimeout(this.stopTimer);
                    clearTimeout(this.trialTimer);
                    this.child = null;
                    this.state.phase = 'stopped';
                    this.state.startedAt = null;
                    this.state.population = null;
                    if (code && !this.stopping) this.state.error = `Server exited with code ${code}. See the console for details.`;
                    this.stopping = false;
                    this.log(`Server stopped (${signal || code || 0}).`);
                    this.busy = trial && !committed;
                    this.releasePromise = (async () => {
                        await commitPromise;
                        if (trial && !committed) {
                            const restoreWorld = needsDatabaseRollback(await readJson(journalPath(this.state.root)));
                            const release = await this.guard();
                            try { await this.recoverUpdate(); } finally { await release(); }
                            const marker = await readJson(markerPath(this.state.root));
                            if (this.runtimeManager) this.nodePath = await this.runtimeManager.ensure(marker?.runtime?.version);
                            await this.inspect();
                            await this.refreshWorld();
                            this.state.error = restoreWorld ? 'The new server did not finish startup. Previous server files and world data were restored.'
                                : 'The update stopped before database migrations. Previous server files were restored; world data was left unchanged.';
                        }
                    })().catch(error => { this.state.error = `Update recovery needs attention: ${error.message}`; })
                        .finally(async () => { await unlock(); this.busy = false; this.publish(); });
                });
                if (trial) this.trialTimer = setTimeout(() => {
                    this.state.error = 'Server update startup timed out.';
                    this.stop().catch(error => this.log(error.message));
                }, this.startupTimeout);
                this.publish();
            } catch (error) { await unlock(); throw error; }
        } finally { this.launching = false; this.publish(); }
        return this.snapshot();
    }
    async stop() {
        const child = this.child;
        if (!child) return this.snapshot();
        if (this.state.phase === 'stopping') return this.snapshot();
        this.stopping = true;
        this.state.phase = 'stopping';
        this.publish();
        const done = new Promise(resolve => child.once('close', resolve));
        if (child.connected) child.send({ type: 'shutdown', reason: 'desktop_stop' });
        else child.kill('SIGTERM');
        this.stopTimer = setTimeout(() => {
            if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else child.kill('SIGKILL');
        }, 22000);
        await done;
        await this.releasePromise;
        await this.refreshWorld();
        return this.snapshot();
    }
}

module.exports = { Controller, environment, loginConnection };
