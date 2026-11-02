'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Controller } = require('./controller.cjs');
const { news, safeLink } = require('./news.cjs');
const { RuntimeManager } = require('./runtime.cjs');
const { ReleaseCatalog, interval } = require('./release-catalog.cjs');
const { LauncherUpdates } = require('./launcher-updates.cjs');
const releaseChannel = require('../package.json').releaseChannel || 'stable';
const applicationName = releaseChannel === 'preview' ? 'L2Solo Launcher Preview' : 'L2Solo Launcher';

protocol.registerSchemesAsPrivileged([{ scheme: 'l2solo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (releaseChannel === 'preview') {
    app.setName(applicationName);
    app.setPath('userData', path.join(app.getPath('appData'), applicationName));
}
if (!app.isPackaged && process.env.L2SOLO_SMOKE_DIR) app.setPath('userData', path.join(process.env.L2SOLO_SMOKE_DIR, 'profile'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
    let window, controller, quitting = false;
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    app.whenReady().then(async () => {
        const assetsRoot = path.resolve(__dirname, '..');
        protocol.handle('l2solo', request => {
            const url = new URL(request.url);
            const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
            const base = relative.startsWith('assets/') ? assetsRoot : path.join(assetsRoot, 'renderer');
            const filename = path.resolve(base, relative);
            if (url.hostname !== 'app' || !filename.startsWith(`${base}${path.sep}`)) return new Response('Not found', { status: 404 });
            return net.fetch(pathToFileURL(filename).toString());
        });
        session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
        session.defaultSession.setPermissionCheckHandler(() => false);
        const bundledNode = path.join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
        const developmentNode = path.join(assetsRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
        const userData = app.getPath('userData');
        const runtimeManager = new RuntimeManager({ userData, bundledNode: app.isPackaged ? bundledNode : developmentNode });
        const nodePath = await runtimeManager.ensure();
        const catalog = new ReleaseCatalog({ userData });
        controller = new Controller({ userData, nodePath, runtimeManager, catalog, channel: releaseChannel });
        const launcherUpdates = new LauncherUpdates({ controller, catalog, currentVersion: app.getVersion(), packaged: app.isPackaged, channel: releaseChannel,
            beforeInstall: () => { quitting = true; }, installFailed: () => { quitting = false; }, createUpdater: options => {
                if (process.platform === 'darwin') throw new Error('Update this macOS application using its DMG installer.');
                const { NsisUpdater, AppImageUpdater } = require('electron-updater');
                const Updater = process.platform === 'win32' ? NsisUpdater : AppImageUpdater;
                return new Updater(options);
            } });
        async function checkAllUpdates(force = false) {
            const results = await Promise.allSettled([controller.checkUpdates(force), launcherUpdates.check(force)]);
            controller.state.updateCheckError = results[0].status === 'rejected' ? results[0].reason.message : null;
            controller.publish();
            const failures = results.filter(result => result.status === 'rejected');
            if (force && failures.length === results.length) throw failures[0].reason;
            return controller.snapshot();
        }
        window = new BrowserWindow({
            width: 1180, height: 800, minWidth: 960, minHeight: 680,
            backgroundColor: '#071012', title: applicationName, autoHideMenuBar: true,
            titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 },
            titleBarOverlay: { color: '#0b1417', symbolColor: '#a9bbb3', height: 44 },
            icon: path.join(assetsRoot, 'assets/logo.png'),
            webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        controller.on('state', state => { if (!window.isDestroyed()) window.webContents.send('launcher:state', state); });
        ipcMain.handle('launcher:action', async (event, action, ...args) => {
            if (event.sender !== window.webContents || event.senderFrame?.url !== 'l2solo://app/index.html') throw new Error('Untrusted launcher request.');
            switch (action) {
            case 'state': return { ...controller.snapshot(), launcherVersion: app.getVersion() };
            case 'chooseFolder': {
                const result = await dialog.showOpenDialog(window, { title: 'Choose your L2Solo server folder',
                    buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] });
                return result.canceled ? { ...controller.snapshot(), selectionCanceled: true } : controller.choose(result.filePaths[0]);
            }
            case 'checkUpdates': return checkAllUpdates(true);
            case 'downloadLauncherUpdate': await launcherUpdates.download(); return controller.snapshot();
            case 'installLauncherUpdate': await launcherUpdates.install(); return controller.snapshot();
            case 'openLauncherRelease':
                return shell.openExternal(launcherUpdates.installerUrl());
            case 'install': return controller.install();
            case 'downloadServerUpdate': return controller.downloadServerUpdate();
            case 'repair': return controller.repair();
            case 'start': return controller.start();
            case 'stop': return controller.stop();
            case 'world': return controller.refreshWorld();
            case 'backup': return controller.backup(args[0], args[1]);
            case 'wipe': return controller.wipe(args[0], args[1]);
            case 'openBackups': {
                if (!controller.state.installed) throw new Error('Choose an installed server first.');
                const directory = path.join(controller.state.root, 'tmp/saves');
                await fs.promises.mkdir(directory, { recursive: true });
                return shell.openPath(directory);
            }
            case 'settings': return controller.getSettings();
            case 'saveSettings': return controller.saveSettings(args[0]);
            case 'news': return news();
            case 'openLink':
                if (!safeLink(args[0])) throw new Error('This link is not supported.');
                return shell.openExternal(args[0]);
            case 'openFolder':
                if (!controller.state.root) throw new Error('Choose an installation folder first.');
                return shell.openPath(controller.state.root);
            case 'openObserver':
                if (!controller.child) throw new Error('Start the server to open World Observer.');
                return shell.openExternal(controller.observerUrl());
            default: throw new Error('Unknown launcher action.');
            }
        });
        window.on('close', event => {
            if (quitting) return;
            if (controller.busy || controller.launching || controller.appUpdating) {
                event.preventDefault();
                dialog.showMessageBox(window, { type: 'info', message: 'An operation is in progress.', detail: 'Wait for it to finish before closing the launcher.' });
            } else if (controller.child) {
                event.preventDefault();
                controller.stop().then(() => { quitting = true; app.quit(); }).catch(error => dialog.showErrorBox('Could not stop server', error.message));
            }
        });
        await window.loadURL('l2solo://app/index.html');
        await controller.initialize();
        // Update discovery is informational; an offline machine can still play.
        if (!process.env.L2SOLO_SMOKE_DIR) checkAllUpdates().catch(() => {});
        const updateTimer = setInterval(() => checkAllUpdates().catch(() => {}), interval);
        updateTimer.unref();
        if (!app.isPackaged && process.env.L2SOLO_SMOKE_DIR) {
            await require('../test/ui-smoke.cjs')({ window, controller, directory: process.env.L2SOLO_SMOKE_DIR });
            quitting = true;
            app.quit();
        }
        // Deterministic UI smoke checks use an isolated profile and never start a world.
        if (!app.isPackaged && process.env.L2SOLO_SCREENSHOT) {
            await window.webContents.insertCSS('*{animation:none!important;transition:none!important}');
            await new Promise(resolve => setTimeout(resolve, 7500));
            await fs.promises.writeFile(process.env.L2SOLO_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
            quitting = true;
            app.quit();
        }
    }).catch(error => {
        if (!app.isPackaged && process.env.L2SOLO_SMOKE_DIR) { console.error(error); app.exit(1); return; }
        dialog.showErrorBox('L2Solo Launcher', error.message);
        app.quit();
    });
    app.on('window-all-closed', () => app.quit());
}
