'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const World = invoke('GameServer/World/World'), Actor = invoke('GameServer/Model/Actor');
const Runtime = invoke('GameServer/World/CharacterLocationRuntime');
const previous = World.user, packets = [];
const stop = World.subscribeActorPublications(packet => packets.push(packet));
let serial = 9900000;
function member(id = ++serial, account = `player_publication_${id}`) {
    const session = { accountId: account, fetchAccountId() { return this.accountId; }, socket: { destroy() {} },
        coldLifeState: { party: { partyId: 'publication_party' } } };
    session.actor = new Actor({ id, username: account, name: account, isOnline: true, locX: 100, locY: 100, locZ: 0 });
    session.actor.session = session; World.insertUser(session); return session;
}
try {
    World.user = { sessions: [], revision: 0 };
    const first = member(), record = World.registeredActorById(first.actor.fetchId());
    assert(packets.some(packet => packet.cause === 'attach' && packet.record === record));
    assert.deepEqual(World.pvpPartySessionsForKey('party:publication_party'), [first]);
    packets.length = 0;
    first.actor.setLocXYZ({ locX: 200, locY: 200, locZ: 0 });
    first.actor.setLocXYZ({ locX: 12000, locY: 12000, locZ: 0 });
    assert.deepEqual(packets, [], 'same-cell and crossing movements publish nothing');
    assert.equal(World.actorSessionsNear({ locX: 12000, locY: 12000 }, 0)[0], first);
    assert.equal(World.retireUserActor(first, first.actor), true);
    assert.equal(packets.length, 1); assert.equal(packets[0].cause, 'retire');
    const retired = World.registeredActorById(record.id);
    assert(retired.retired); assert.equal(Runtime.index.getSource(record.id, 'actor'), retired);
    packets.length = 0; first.actor.setLocX(15000);
    assert.deepEqual(packets, []); assert.deepEqual(World.actorSessionsNear({ locX: 15000, locY: 12000 }, 1), []);
    const replacement = member(record.id, first.accountId);
    assert(packets.some(packet => packet.kind === 'remove' && packet.record === retired));
    const current = World.registeredActorById(record.id);
    assert.equal(current.actor, replacement.actor);
    packets.length = 0; first.actor.setLocX(1); World.removeUser(first);
    assert.deepEqual(packets, [], 'stale actor setters and cleanup cannot publish a replacement');
    assert.equal(World.registeredActorById(record.id), current);
    World.removeUser(replacement);
    assert.equal(packets.length, 1); assert.equal(packets[0].kind, 'remove');
    assert.equal(World.registeredActorById(record.id), null);
    const broken = member(); packets.length = 0;
    assert.throws(() => broken.actor.setLocX(1e100), /invalid_character_cell/);
    assert.deepEqual(packets, [], 'failed movement has no accepted location publication');
    broken.actor.setLocX(0);
    assert.equal(World.actorSessionsNear({ locX: 0, locY: 100 }, 0)[0], broken);
    console.log('Actor publications retain attach/retire/remove, exclude moves and preserve replacement/error recovery: PASS');
} finally { stop(); World.user = previous; }
