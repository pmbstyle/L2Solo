'use strict';

const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { assetUrl, launcherRelease, newerVersion } = require('./releases.cjs');

function validateFeed(text, manifest, target) {
    const asset = manifest.assets.find(asset => asset.name === manifest.feeds[target]);
    if (!asset || Buffer.byteLength(text) !== asset.bytes || crypto.createHash('sha256').update(text).digest('hex') !== asset.sha256) throw new Error('Launcher update metadata checksum mismatch.');
    const info = yaml.load(text);
    if (info?.version !== manifest.version || !Array.isArray(info.files) || !info.files.length || info.packages) throw new Error('Invalid launcher update metadata.');
    for (const file of info.files) {
        const expected = manifest.assets.find(asset => asset.name === file.url);
        if (!expected || expected.bytes !== file.size || !expected.sha512 || expected.sha512 !== file.sha512) throw new Error('Launcher update metadata does not match its release.');
    }
    if (info.path && !info.files.some(file => file.url === info.path && file.sha512 === info.sha512)) throw new Error('Invalid launcher update download path.');
    return info;
}

class LauncherUpdates {
    constructor({ controller, catalog, currentVersion, packaged, createUpdater, beforeInstall = () => {}, installFailed = () => {}, fetcher = fetch,
        platform = process.platform, arch = process.arch, portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE), appImage = Boolean(process.env.APPIMAGE), channel = 'stable' }) {
        if (!['stable', 'preview'].includes(channel)) throw new Error('Unknown update channel.');
        Object.assign(this, { controller, catalog, currentVersion, createUpdater, beforeInstall, installFailed, fetcher, platform, arch, portable, appImage, channel });
        // Releases use free ad-hoc signing on macOS. Update the application
        // through its DMG instead of invoking the signed-app native updater.
        this.supported = packaged && !portable && platform !== 'darwin' && (platform !== 'linux' || appImage);
        this.state = { currentVersion, status: 'idle', supported: this.supported, availableVersion: null, percent: 0, error: null };
        this.publish();
    }
    publish(patch = {}) {
        Object.assign(this.state, patch);
        this.controller.state.launcherUpdate = { ...this.state };
        this.controller.publish();
    }
    installerUrl() {
        if (!this.latest) throw new Error('Check for launcher updates first.');
        const installers = this.latest.manifest.installers[`${this.platform}-${this.arch}`] || [];
        const preferred = this.platform === 'darwin' ? /\.dmg$/ : this.platform === 'win32'
            ? this.portable ? /-Portable\.exe$/ : /-Setup\.exe$/ : this.appImage ? /\.AppImage$/ : /\.deb$/;
        const name = installers.find(name => preferred.test(name)) || installers[0];
        return name ? assetUrl(this.latest.tag, name) : this.latest.url;
    }
    async check(force = false) {
        if (['downloading', 'downloaded', 'installing'].includes(this.state.status)) return;
        this.publish({ status: 'checking', error: null });
        try {
            this.latest = await launcherRelease(this.fetcher, await this.catalog.releases(force), '0.0.0', this.channel);
            this.publish({ status: newerVersion(this.latest.version, this.currentVersion) ? 'available' : 'current',
                availableVersion: this.latest.version, notes: this.latest.notes, url: this.latest.url });
        } catch (error) { this.publish({ status: 'error', error: error.message }); throw error; }
    }
    async download() {
        if (!this.supported) throw new Error('Download this launcher update from GitHub and install it using your platform installer.');
        if (['downloading', 'downloaded', 'installing'].includes(this.state.status)) return;
        if (!this.latest || !newerVersion(this.latest.version, this.currentVersion)) throw new Error('Check for a newer launcher release first.');
        this.publish({ status: 'downloading', percent: 0, error: null });
        // Return immediately: downloading an application update must not lock
        // the server controls or stop an active world.
        this.downloadPromise = this.prepare().catch(error => this.publish({ status: 'error', error: error.message }));
    }
    async prepare() {
        const target = `${this.platform}-${this.arch}`;
        const feed = this.latest.manifest.feeds[target];
        if (!feed) throw new Error('No launcher update is available for this platform.');
        const response = await this.fetcher(assetUrl(this.latest.tag, feed), { signal: AbortSignal.timeout(30000) });
        if (!response.ok || Number(response.headers.get('content-length')) > 1024 ** 2) throw new Error('Could not download launcher update metadata.');
        const text = await response.text();
        if (text.length > 1024 ** 2) throw new Error('Launcher update metadata is too large.');
        validateFeed(text, this.latest.manifest, target);
        this.updater = this.createUpdater({ provider: 'generic', url: assetUrl(this.latest.tag, feed).replace(/[^/]+$/, ''), channel: `${this.channel === 'preview' ? 'preview' : 'latest'}-${this.arch}` });
        Object.assign(this.updater, { autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: this.channel === 'preview',
            previousBlockmapBaseUrlOverride: assetUrl(`launcher-v${this.currentVersion}`, 'placeholder').replace(/[^/]+$/, '') });
        this.updater.on('error', error => {
            if (this.state.status === 'installing') { this.controller.appUpdating = false; this.installFailed(); }
            this.publish({ status: 'error', error: error.message });
        });
        this.updater.on('download-progress', progress => this.publish({ percent: progress.percent, bytes: progress.transferred, total: progress.total }));
        const result = await this.updater.checkForUpdates();
        if (result?.updateInfo?.version !== this.latest.version) throw new Error('The selected launcher release changed during the update check.');
        await this.updater.downloadUpdate();
        this.publish({ status: 'downloaded', percent: 100 });
    }
    async install() {
        if (!this.supported) throw new Error('Download the installer from GitHub and replace this application to update it.');
        if (this.state.status !== 'downloaded' || !this.updater) throw new Error('Download the launcher update first.');
        if (this.controller.busy || this.controller.appUpdating || this.controller.launching) throw new Error('Wait for the current server operation to finish.');
        this.controller.appUpdating = true;
        this.publish({ status: 'installing', error: null });
        try {
            await this.controller.stop();
            await this.controller.releasePromise;
            if (this.controller.child || this.controller.busy) throw new Error('The server has not finished stopping.');
            this.beforeInstall();
            this.updater.quitAndInstall(false, true);
        } catch (error) {
            this.controller.appUpdating = false;
            this.installFailed();
            this.publish({ status: 'downloaded', error: error.message });
            throw error;
        }
    }
}

module.exports = { LauncherUpdates, validateFeed };
