'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, ...args) => ipcRenderer.invoke('launcher:action', action, ...args);

contextBridge.exposeInMainWorld('launcher', Object.freeze({
    platform: process.platform,
    state: () => invoke('state'),
    chooseFolder: () => invoke('chooseFolder'),
    checkUpdates: () => invoke('checkUpdates'),
    downloadLauncherUpdate: () => invoke('downloadLauncherUpdate'),
    installLauncherUpdate: () => invoke('installLauncherUpdate'),
    openLauncherRelease: () => invoke('openLauncherRelease'),
    install: () => invoke('install'),
    downloadServerUpdate: () => invoke('downloadServerUpdate'),
    repair: () => invoke('repair'),
    start: () => invoke('start'),
    stop: () => invoke('stop'),
    world: () => invoke('world'),
    backup: (action, payload) => invoke('backup', action, payload),
    wipe: (scope, confirmation) => invoke('wipe', scope, confirmation),
    openBackups: () => invoke('openBackups'),
    settings: () => invoke('settings'),
    saveSettings: changes => invoke('saveSettings', changes),
    news: () => invoke('news'),
    openLink: url => invoke('openLink', url),
    openFolder: () => invoke('openFolder'),
    openObserver: () => invoke('openObserver'),
    onState(callback) {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('launcher:state', listener);
        return () => ipcRenderer.removeListener('launcher:state', listener);
    }
}));
