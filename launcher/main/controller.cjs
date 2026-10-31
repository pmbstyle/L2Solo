'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { readJson, writeJson, acquireLock } = require('./files.cjs');
const { readConfig, settings, saveSettings } = require('./config.cjs');
const { latestRelease, newerVersion } = require('./releases.cjs');
const { markerPath, recover, installRelease } = require('./installer.cjs');
const { holdLock } = require('./locks.cjs');
const { helperPath } = require('./helper-path.cjs');

function environment(root) {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'L2NODE_SHARED_CONFIG_FILE', 'L2NODE_GEODATA_RELEASE',
        'L2NODE_GEODATA_URL', 'L2NODE_GEODATA_SHA256', 'L2NODE_PROGRESSION_RATE', 'L2NODE_GEODATA_USAGE_FILE']) delete env[key];
    return { ...env, L2NODE_CONFIG_FILE: path.join(root, 'config/local.ini'), L2NODE_GEODATA_DIR: path.join(root, 'data/Geodata'),
        L2NODE_RUNTIME_DIR: path.join(root, 'tmp'), L2NODE_NO_BROWSER: '1' };
}

class Controller extends EventEmitter {
    constructor({ userData, nodePath, fetcher = fetch }) {
        super();
        this.userData = userData;
        this.nodePath = nodePath;
        this.fetcher = fetcher;
        this.child = null;
        this.busy = false;
        this.latest = null;
        this.state = { root: null, installed: false, version: null, phase: 'stopped', startedAt: null, latest: null,
            geodata: null, progress: { percent: 0, label: 'Choose a home for your world' }, logs: [], error: null };
    }
    snapshot() { return { ...this.state, busy: this.busy }; }
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
    async operation(work) {
        if (this.busy || this.child) throw new Error('Stop the server and wait for the current operation to finish.');
        if (!this.state.root) throw new Error('Choose an installation folder first.');
        this.busy = true;
        this.state.error = null;
        this.publish();
        let unlock;
        try {
            await this.releasePromise;
            unlock = await acquireLock(this.state.root, this.nodePath);
            return await work();
        } catch (error) {
            this.state.error = error.message;
            throw error;
        } finally {
            await unlock?.();
            this.busy = false;
            this.publish();
        }
    }
    async choose(directory) {
        if (this.busy || this.child) throw new Error('Stop the server before changing its folder.');
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
        if (!installed && ownership?.application !== 'L2Solo' && entries.some(name => name !== '.l2solo' && name !== '.DS_Store')) throw new Error('Choose an empty folder or an existing L2Solo server.');
        const previousState = structuredClone(this.state);
        this.state.root = root;
        this.state.installed = installed;
        try {
            await this.operation(async () => {
                await writeJson(path.join(root, '.l2solo/folder.json'), { application: 'L2Solo', schemaVersion: 1 });
                if (fs.existsSync(path.join(root, '.l2solo/transaction.json'))) {
                    const release = await this.guard();
                    try { await recover(root, message => this.log(message)); } finally { await release(); }
                }
                await this.inspect();
                await writeJson(path.join(this.userData, 'preferences.json'), { root });
            });
        } catch (error) { this.state = previousState; this.state.error = error.message; this.publish(); throw error; }
        return this.snapshot();
    }
    async inspect() {
        const root = this.state.root;
        this.state.installed = fs.existsSync(path.join(root, 'scripts/run-server.js')) && fs.existsSync(path.join(root, 'config/default.ini'));
        const marker = await readJson(markerPath(root));
        const pkg = this.state.installed ? await readJson(path.join(root, 'package.json')) : null;
        this.state.version = marker?.tag || (pkg?.version ? `v${pkg.version} · existing installation` : null);
        this.state.geodata = null;
        if (this.state.installed) {
            this.progress({ percent: 0, label: 'Verifying installed geodata' });
            this.state.geodata = await this.helper('geodata.cjs', ['check']);
        }
        this.progress({ percent: this.state.geodata?.valid ? 100 : 0,
            label: this.state.geodata?.valid ? 'All files ready' : this.state.installed ? 'Geodata needs installation or repair' : 'Ready to install the latest release' });
    }
    async checkUpdates() {
        this.latest = await latestRelease(this.fetcher);
        const { manifest, archiveUrl, ...summary } = this.latest;
        this.state.latest = { ...summary, updateAvailable: this.state.version?.split(' ·')[0] !== summary.tag,
            launcherUpdateRequired: newerVersion(manifest.minimumLauncherVersion || '0.1.0', require('../package.json').version) };
        this.publish();
        return this.snapshot();
    }
    helper(filename, args = [], onMessage = () => {}) {
        return new Promise((resolve, reject) => {
            let result, reportedError;
            const child = spawn(this.nodePath, [helperPath(filename), this.state.root, ...args], {
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
        const database = journal?.databasePath || path.resolve(this.state.root, config.Database?.path || 'tmp/nodel2.sqlite');
        return holdLock(database, this.nodePath);
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
    async install() {
        await this.operation(async () => {
            this.progress({ label: 'Finding the latest stable release', percent: 1 });
            await this.checkUpdates();
            if (this.state.latest.launcherUpdateRequired) throw new Error('Install the latest launcher from GitHub Releases before installing this server update.');
            const release = await this.guard();
            try {
                await recover(this.state.root, message => this.log(message));
                const result = await installRelease(this.state.root, this.latest, value => this.progress(value), this.fetcher);
                this.state.installed = true;
                this.state.version = this.latest.tag;
                this.log(`Installed ${this.latest.tag}: ${result.changedFiles} files changed.${result.backup ? ` Previous files: ${result.backup}` : ''}`);
                await this.ensureGeodata();
                this.state.latest.updateAvailable = false;
            } finally { await release(); }
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
    async saveSettings(changes) {
        let result;
        await this.operation(async () => { result = await saveSettings(this.state.root, changes); });
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
        if (this.child || this.busy) throw new Error('The server or another operation is already running.');
        if (!this.state.installed) throw new Error('Install a server first.');
        await this.operation(async () => {
            const release = await this.guard();
            try { await recover(this.state.root, message => this.log(message)); await this.ensureGeodata(); }
            finally { await release(); }
        });
        const unlock = await acquireLock(this.state.root, this.nodePath);
        try {
            const child = spawn(this.nodePath, [path.join(this.state.root, 'scripts/run-server.js')], {
                cwd: this.state.root, env: environment(this.state.root), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
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
                    if (/GameServer\s*:: successful init/.test(line)) this.state.phase = 'running';
                    this.log(line);
                }
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', error => { this.state.error = error.message; this.publish(); });
            child.once('close', (code, signal) => {
                if (pending) this.log(pending);
                clearTimeout(this.stopTimer);
                this.child = null;
                this.state.phase = 'stopped';
                this.state.startedAt = null;
                if (code && !this.stopping) this.state.error = `Server exited with code ${code}. See the console for details.`;
                this.stopping = false;
                this.log(`Server stopped (${signal || code || 0}).`);
                this.releasePromise = unlock().catch(error => this.log(error.message));
            });
            this.publish();
        } catch (error) { await unlock(); throw error; }
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
        return this.snapshot();
    }
}

module.exports = { Controller, environment };
