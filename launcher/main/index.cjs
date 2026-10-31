'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Controller } = require('./controller.cjs');
const { news, safeLink } = require('./news.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'l2solo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
else {
    if (!app.isPackaged && process.env.L2SOLO_SMOKE_DIR) app.setPath('userData', path.join(process.env.L2SOLO_SMOKE_DIR, 'profile'));
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
        const nodePath = app.isPackaged ? bundledNode : developmentNode;
        if (!fs.existsSync(nodePath)) throw new Error('Server runtime is missing. Run npm run runtime in the launcher folder.');
        controller = new Controller({ userData: app.getPath('userData'), nodePath });
        window = new BrowserWindow({
            width: 1260, height: 900, minWidth: 1000, minHeight: 720,
            backgroundColor: '#071012', title: 'L2Solo Launcher', autoHideMenuBar: true,
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
            case 'checkUpdates': return controller.checkUpdates();
            case 'install': return controller.install();
            case 'repair': return controller.repair();
            case 'start': return controller.start();
            case 'stop': return controller.stop();
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
            if (controller.busy) {
                event.preventDefault();
                dialog.showMessageBox(window, { type: 'info', message: 'Your files are still being prepared.', detail: 'Wait for the installation or verification to finish before closing the launcher.' });
            } else if (controller.child) {
                event.preventDefault();
                controller.stop().then(() => { quitting = true; app.quit(); }).catch(error => dialog.showErrorBox('Could not stop server', error.message));
            }
        });
        await window.loadURL('l2solo://app/index.html');
        await controller.initialize();
        // Update discovery is informational; an offline machine can still play.
        controller.checkUpdates().catch(() => {});
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
