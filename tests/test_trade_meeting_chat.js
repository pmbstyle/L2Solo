'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Response = invoke('GameServer/Network/Response');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const originalInvoke = global.invoke, savedWarn = utils.infoWarn;
const packets = [], warnings = [], states = new Map(), sessions = new Map();
let row, sequence = 0;
const playerActor = { fetchLocX: () => 1000, fetchLocY: () => 0, fetchLocZ: () => 0,
    fetchHp: () => 100, isDead: () => false };
const player = { actor: playerActor, dataSendToMe: packet => packets.push(packet) };
sessions.set(2, player);
const native = {
    fetchTradeMeetingByToken: async token => token === row.token ? row : null,
    fetchTradeMeetingForOwner: async () => row,
    fetchItems: async () => []
};
global.invoke = name => ({ Database: native, 'GameServer/Network/Response': Response,
    'GameServer/Bot/Population/BotLifeState': { cachedState: id => states.get(id) },
    'GameServer/Bot/Population/ColdSimulationCoordinator': { notifyState() {} },
    'GameServer/World/World': { registeredActorById: id => sessions.has(id) ? { session: sessions.get(id) } : null },
    'GameServer/AfkTrade/AfkTradeService': { syncOnlineInventory: async () => {} }
})[name] || originalInvoke(name);
utils.infoWarn = (...args) => warnings.push(args);
const state = overrides => ({ characterId: 1, name: 'Seller', phase: 'cold', activity: 'traveling',
    loc: { locX: 0, locY: 0, locZ: 0 }, stats: { travel: { to: { locX: 1000, locY: 0, locZ: 0 }, arrivalAt: Date.now() + 150000 } }, ...overrides });
const text = () => packets.at(-1).subarray(9).toString('utf16le').split('\0')[1];
async function agree(bot = 1, other = 2) {
    row = { id: ++sequence, token: 'meeting-chat-' + sequence, actorA: bot, actorB: other,
        state: 'accepted', locX: 1000, locY: 0, locZ: 0, routeA: '{"durationMs":60000}' };
    return Service.accept(row.token, other);
}
(async () => {
    try {
        states.set(1, state());
        assert.equal((await agree()).pending, true);
        assert.match(text(), /on my way.*About 3 min/);
        assert.equal(packets[0][0], 0x4a);
        assert.equal(packets[0].readInt32LE(1), 1);
        assert.equal(packets[0].readInt32LE(5), 2);
        assert.equal(packets[0].subarray(9).toString('utf16le').split('\0')[0], 'Seller');
        await Service.accept(row.token, 2); await Service.receipt(row.token, 2);
        assert.equal(packets.length, 1, 'acceptance and receipt retries share one acknowledgement');
        states.set(1, state({ activity: 'fighting', stats: {} })); await agree();
        assert.match(text(), /finish this fight/); assert(!text().includes('About'));
        states.set(1, state({ activity: 'resting', stats: { restUntil: Date.now() + 60000 } })); await agree();
        assert.match(text(), /recover first.*About 2 min/);
        states.set(1, state({ stats: { travel: { to: { locX: 2000, locY: 0, locZ: 0 } } } })); await agree();
        assert.match(text(), /finish this trip/); assert(!text().includes('About'));
        const before = packets.length;
        states.set(1, state({ loc: { locX: 1000, locY: 0, locZ: 0 } })); await agree();
        states.set(3, state({ characterId: 3 })); await agree(1, 3);
        assert.equal(packets.length, before, 'same-point and bot-to-bot trades send no travel acknowledgement');
        states.set(3, state({ characterId: 3, phase: 'hot', loc: { locX: 1000, locY: 0, locZ: 0 } }));
        sessions.set(3, { actor: { fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 } });
        await agree(3); assert.equal(packets.length, before + 1, 'hot merchants use their physical actor position');
        states.set(1, state());
        player.dataSendToMe = () => { throw Error('socket closed'); };
        assert.equal((await agree()).pending, true, 'chat transport failure never undoes native acceptance');
        assert.equal(warnings.length, 1);
        player.dataSendToMe = packet => packets.push(packet);
        await Service.receipt(row.token, 2);
        assert.equal(packets.length, before + 2, 'a failed delivery does not consume the acknowledgement');
        console.log('PASS private meeting acknowledgement, real sender, ETA, rest/fight/trip truth, replay dedup and transport failure');
    } finally { Service.reset(); global.invoke = originalInvoke; utils.infoWarn = savedWarn; }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
