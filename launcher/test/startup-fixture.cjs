'use strict';

// Exercise the real NodeL2 startup/session gate and real TCP listeners without
// loading geodata, starting a bot population or touching a user's world.
const path = require('node:path');
const root = require('node:fs').realpathSync(process.env.L2SOLO_FIXTURE_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const noop = () => {};
global.options = { default: { Database: { path: path.join(process.cwd(), 'world.sqlite') }, AuthServer: { hostname: '127.0.0.1', port: 0 }, GameServer: { hostname: '127.0.0.1', port: 0 } } };
global.utils = { infoSuccess: noop, infoWarn: noop, buildNumber: () => 1, currentDate: () => '', nodeVersion: () => process.versions.node };
class Session {
    constructor(socket) { socket.end('player-admitted'); }
    dataReceive() {}
    error() {}
}
const service = { init: noop, start: noop, stop: async () => {}, shutdown: async () => {}, warmup: noop, flushAll: async () => {}, loadAll: async () => 0,
    events: { drain: async () => ({ drained: true }) } };
const modules = {
    Server: require(path.join(root, 'src/Server.js')),
    Database: { init: callback => callback(), compactStackableInventory: async () => ({ skipped: true }), close: async () => {} },
    'GameServer/World/World': { init: async () => {} }, 'GameServer/DataCache': { init: noop, items: [] },
    'GameServer/Clan/ClanService': { init: async () => {} }, 'AuthenticationServer/Session': Session, 'GameServer/Session': Session,
    'GameServer/ProgressionRates': { profile: () => ({}) },
    'WorldObserver/WorldObserverServer': { init: () => process.send({ type: 'fixture:observer' }) }
};
global.invoke = name => modules[name] || service;
require.cache[path.join(root, 'src/Global.js')] = { exports: {}, loaded: true };
require(path.join(root, 'src/NodeL2.js'));
