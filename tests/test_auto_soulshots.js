const assert = require('assert');

require('../src/Global');

const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const AutoSoulShot = invoke('GameServer/Network/Request/AutoSoulShot');
const ExtendedRequest = invoke('GameServer/Network/Request/ExtendedRequest');
const Attack = invoke('GameServer/Actor/Attack');
const Database = invoke('Database');

Database.updateItemAmount = () => Promise.resolve();
Database.deleteItem = () => Promise.resolve();

function item(id, data) {
    return new Item(id, {
        selfId: data.selfId,
        kind: data.kind,
        amount: data.amount,
        equipped: data.equipped || false,
        slot: data.slot || 0,
        soulshot: data.soulshot || 0,
        spiritshot: data.spiritshot || 0,
        rank: data.rank || 'none'
    });
}

const backpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
backpack.items = [
    item(1, { selfId: 1, kind: 'Weapon.Sword', equipped: true, slot: 7, soulshot: 2 }),
    item(2, { selfId: 1835, kind: 'Other.Shot', amount: 10 })
];
const session = {
    actor: {
        backpack,
        isDead: () => false,
        fetchId: () => 2000001,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -300
    },
    packets: [],
    dataSendToMe(packet) { this.packets.push(packet); },
    dataSendToMeAndOthers() {}
};

function request(selfId, enabled) {
    const packet = Buffer.alloc(11);
    packet[0] = 0xd0;
    packet.writeInt16LE(5, 1);
    packet.writeInt32LE(selfId, 3);
    packet.writeInt32LE(enabled, 7);
    ExtendedRequest(session, packet);
}

request(1835, 1);
assert.strictEqual(session.actor.autoSoulshots.has(1835), true, 'hotbar enable should register the requested soulshot');
assert.strictEqual(backpack.isAutoShotEnabled(session.actor, 'soulshot'), true, 'only the matching equipped-weapon grade should auto-reload');
assert.strictEqual(backpack.fetchItemFromSelfId(1835).fetchAmount(), 8, 'enabling a compatible soulshot should immediately charge it');
assert.strictEqual(session.actor.soulshotLoaded, true, 'enabling a compatible soulshot should set its loaded state');
const enabledPacket = session.packets.findLast((packet) => packet[0] === 0xfe);
assert.strictEqual(enabledPacket[0], 0xfe, 'hotbar enable should acknowledge with an extended response');
assert.strictEqual(enabledPacket.readInt16LE(1), 0x12, 'C4 response should use ExAutoSoulShot sub-id');
assert.strictEqual(enabledPacket.readInt32LE(3), 1835, 'response should identify the toggled shot item');
assert.strictEqual(enabledPacket.readInt32LE(7), 1, 'response should mark the shot as enabled');

request(1835, 0);
assert.strictEqual(backpack.isAutoShotEnabled(session.actor, 'soulshot'), false, 'hotbar disable should stop automatic reloads');
const disabledPacket = session.packets.findLast((packet) => packet[0] === 0xfe);
assert.strictEqual(disabledPacket.readInt32LE(7), 0, 'response should mark the shot as disabled');

request(2509, 1);
assert.strictEqual(session.actor.autoSoulshots.has(2509), false, 'a shot absent from inventory must not be enabled');

assert.doesNotThrow(
    () => ExtendedRequest(session, Buffer.from([0xd0, 0x01, 0x00])),
    'unrelated short C4 extended requests must not be parsed as auto-shot packets'
);
assert.doesNotThrow(
    () => ExtendedRequest(session, Buffer.from([0xd0, 0x05, 0x00])),
    'truncated auto-shot requests must not crash the session'
);
assert.strictEqual(session.actor.autoSoulshots.has(1835), false, 'unrelated extended requests must not alter auto-shot state');

const bssBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
bssBackpack.items = [
    item(3, { selfId: 238, kind: 'Weapon.Blunt', equipped: true, slot: 7, spiritshot: 1, rank: 'b' }),
    item(4, { selfId: 3950, kind: 'Other.Shot', amount: 3 })
];
const bssSession = {
    actor: {
        backpack: bssBackpack,
        isDead: () => false,
        fetchId: () => 2000002,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -300
    },
    dataSendToMe() {},
    dataSendToMeAndOthers() {}
};
const bssPacket = Buffer.alloc(11);
bssPacket[0] = 0xd0;
bssPacket.writeInt16LE(5, 1);
bssPacket.writeInt32LE(3950, 3);
bssPacket.writeInt32LE(1, 7);
ExtendedRequest(bssSession, bssPacket);
assert.strictEqual(bssBackpack.fetchAutoSpiritshotKind(bssSession.actor), 'blessedSpiritshot', 'Blessed Spiritshot should participate in the C4 auto-shot toggle');
assert.strictEqual(bssBackpack.fetchItemFromSelfId(3950).fetchAmount(), 2, 'enabling Blessed Spiritshot should consume the weapon cost immediately');
assert.strictEqual(bssSession.actor.blessedSpiritshotLoaded, true, 'Blessed Spiritshot auto-charge should retain its damage modifier');

const beginnerBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
beginnerBackpack.items = [
    item(5, { selfId: 1, kind: 'Weapon.Sword', equipped: true, slot: 7, soulshot: 1 }),
    item(6, { selfId: 5789, kind: 'Other.Shot', amount: 3 })
];
const beginnerSession = {
    actor: { backpack: beginnerBackpack, isDead: () => false, fetchId: () => 2000003, fetchLocX: () => 100, fetchLocY: () => 200, fetchLocZ: () => -300 },
    dataSendToMe() {}, dataSendToMeAndOthers() {}
};
const beginnerPacket = Buffer.alloc(11);
beginnerPacket[0] = 0xd0;
beginnerPacket.writeInt16LE(5, 1);
beginnerPacket.writeInt32LE(5789, 3);
beginnerPacket.writeInt32LE(1, 7);
ExtendedRequest(beginnerSession, beginnerPacket);
assert.strictEqual(beginnerBackpack.isAutoShotEnabled(beginnerSession.actor, 'soulshot'), true, 'quest beginner Soulshot should support the C4 hotbar toggle');
assert.strictEqual(beginnerBackpack.fetchItemFromSelfId(5789).fetchAmount(), 2, 'enabling a quest beginner Soulshot should charge it immediately');

const attack = new Attack();
let consumeCalls = 0;
const combatActor = {
    soulshotLoaded: false,
    backpack: {
        isAutoShotEnabled: () => false,
        consumeSoulshot() { consumeCalls += 1; }
    }
};
attack.chargeShotForSkill({ actor: combatActor }, combatActor, false);
assert.strictEqual(consumeCalls, 0, 'ordinary combat must not consume shots until explicitly enabled');
combatActor.backpack.isAutoShotEnabled = () => true;
combatActor.backpack.consumeSoulshot = (ignoredSession, callback) => {
    consumeCalls += 1;
    callback(false);
};
attack.chargeShotForSkill({ actor: combatActor }, combatActor, false);
assert.strictEqual(consumeCalls, 1, 'enabled hotbar shots should be eligible for automatic reload');
attack.destructor();

console.log('Auto soulshot toggle checks passed');
