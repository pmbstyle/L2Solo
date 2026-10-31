'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, ...args) => ipcRenderer.invoke('launcher:action', action, ...args);

contextBridge.exposeInMainWorld('launcher', Object.freeze({
    state: () => invoke('state'),
    chooseFolder: () => invoke('chooseFolder'),
    checkUpdates: () => invoke('checkUpdates'),
    install: () => invoke('install'),
    repair: () => invoke('repair'),
    start: () => invoke('start'),
    stop: () => invoke('stop'),
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
