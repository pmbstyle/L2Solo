'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Visibility = invoke('GameServer/World/CharacterVisibility');
const Response = invoke('GameServer/Network/Response');
const Session = invoke('GameServer/Session');
const BotSession = invoke('GameServer/Bot/BotSession');
const World = invoke('GameServer/World/World');
const Wars = invoke('GameServer/Clan/ClanWarRuntime');
const Send = invoke('Packet/Send');
const originals = { charInfo: Response.charInfo, between: Wars.between,
    players: World.fetchVisibleRealPlayers };
const goal = {};
const actor = { fetchId: () => 2006478, fetchClassId: () => 30,
    state: { fetchTowards: () => 'move', fetchDead: () => false } };
const owner = actor.session = { actor, moveTimer: {}, activeMoveGoal: goal,
    activeMoveSegment: { actor, goal, to: { locX: 900, locY: 200, locZ: -3328 } } };
const info = (subject = actor) => {
    const packet = new Send(3).writeD(100).writeD(200).writeD(-3328).writeD(0).writeD(subject.fetchId()).fetchBuffer();
    packet.__characterActor = subject;
    return packet;
};
const viewer = () => {
    const packets = [];
    const session = { actor: {}, socket: { write: p => packets.push(p.subarray(2)) },
        recordOutboundPacket() {}, packData: Session.prototype.packData,
        dataSendToMe: Session.prototype.dataSendToMe };
    return { session, packets };
};
try {
    Response.charInfo = subject => info(subject);
    Wars.between = () => ({ status: 'neutral' });
    const a = viewer(), b = viewer();
    a.session.dataSendToMe(info());
    assert.deepEqual(a.packets.map(p => p[0]), [3, 1], 'a moving character snapshot must immediately resume its leg');
    const move = a.packets[1];
    assert.deepEqual([17, 21, 25].map(i => move.readInt32LE(i)), [100, 200, -3328], 'resume from the exact snapshot origin');
    assert.deepEqual([5, 9, 13].map(i => move.readInt32LE(i)), [900, 200, -3328]);
    assert.equal(b.packets.length, 0, 'refreshing one viewer must not restart movement for everyone');
    assert.equal(owner.activeMoveGoal, goal, 'visibility must not replace the server route');

    a.session.dataSendToMe(Response.deleteOb(actor.fetchId()));
    assert.equal(a.session.knownCharacterActors.has(actor.fetchId()), false);
    a.packets.length = 0;
    const nextMove = Response.moveToLocation(actor.fetchId(), {
        from: { locX: 100, locY: 200, locZ: -3328 }, to: owner.activeMoveSegment.to
    }, actor);
    a.session.dataSendToMe(nextMove);
    assert.deepEqual(a.packets.map(p => p[0]), [3, 1], 'movement after deletion must reveal the body before the route, exactly once');
    a.packets.length = 0;
    a.session.dataSendToMe(nextMove);
    assert.deepEqual(a.packets.map(p => p[0]), [1], 'a known body needs no duplicate snapshot on each leg');

    const transferred = viewer();
    transferred.session.dataSendToMe(info());
    transferred.packets.length = 0;
    transferred.session.actor.teleportSequence = 1;
    transferred.session.dataSendToMe(nextMove);
    assert.deepEqual(transferred.packets.map(p => p[0]), [3, 1],
        'a teleport clears the client scene, so a formerly known bot needs a new body before movement');
    transferred.packets.length = 0;
    transferred.session.actor = {};
    transferred.session.dataSendToMe(nextMove);
    assert.deepEqual(transferred.packets.map(p => p[0]), [3, 1],
        'switching characters on the same connection must invalidate the old known-body cache');

    // Both broadcaster paths write directly to sockets, bypassing dataSendToMe.
    for (const prototype of [BotSession.prototype, Session.prototype]) {
        const v = viewer();
        World.fetchVisibleRealPlayers = () => [v.session];
        prototype.dataSendToOthers.call({ accountId: 'bot_visibility_test',
            packData: Session.prototype.packData }, nextMove, actor);
        assert.deepEqual(v.packets.map(p => p[0]), [3, 1], 'raw broadcasts must also prime an unknown moving body');
        v.packets.length = 0;
        prototype.dataSendToOthers.call({ accountId: 'bot_visibility_test',
            packData: Session.prototype.packData }, info(), actor);
        assert.deepEqual(v.packets.map(p => p[0]), [3, 1], 'raw snapshot broadcasts must resume motion for each viewer');
    }

    // One client can observe several independent solo/party bodies. Learning
    // one bot must not suppress another, and a replacement with the same ID
    // must still be recreated before its first movement packet.
    const sharedViewer = viewer();
    const independentBots = [4101, 4102, 4103].map(id => ({
        fetchId: () => id, fetchClassId: () => 6,
        state: { fetchTowards: () => 'move', fetchDead: () => false }
    }));
    for (const body of independentBots) {
        const bodyGoal = {};
        body.session = { actor: body, moveTimer: {}, activeMoveGoal: bodyGoal,
            activeMoveSegment: { actor: body, goal: bodyGoal, to: { locX: body.fetchId(), locY: 300, locZ: -3300 } } };
        sharedViewer.session.dataSendToMe(Response.moveToLocation(body.fetchId(), {
            from: { locX: 100, locY: 200, locZ: -3328 }, to: body.session.activeMoveSegment.to
        }, body));
    }
    assert.deepEqual(sharedViewer.packets.map(p => p[0]), [3, 1, 3, 1, 3, 1]);
    assert.deepEqual(sharedViewer.packets.filter(p => p[0] === 3).map(p => p.readInt32LE(17)), [4101, 4102, 4103]);
    sharedViewer.packets.length = 0;
    const replacement = { ...independentBots[0] };
    sharedViewer.session.dataSendToMe(Response.moveToLocation(replacement.fetchId(), {
        from: { locX: 100, locY: 200, locZ: -3328 }, to: { locX: 700, locY: 300, locZ: -3300 }
    }, replacement));
    assert.deepEqual(sharedViewer.packets.map(p => p[0]), [3, 1], 'a new hot body reusing the ID must not inherit its predecessor client entry');
    assert.equal(sharedViewer.session.knownCharacterActors.get(4102).deref(), independentBots[1]);

    // A monster/summon borrows a player session, but its pawn movement must
    // keep its NPC model rather than passing through player CharInfo.
    const npcViewer = viewer();
    const npc = { fetchId: () => 9001, fetchLocX: () => 10, fetchLocY: () => 20, fetchLocZ: () => 30 };
    const npcTarget = { fetchId: () => 9002, fetchLocX: () => 300, fetchLocY: () => 200, fetchLocZ: () => 30 };
    npcViewer.session.dataSendToMe(Response.moveToPawn(npc, npcTarget, 40));
    assert.deepEqual(npcViewer.packets.map(p => p[0]), [0x60], 'NPC chases must never manufacture a player body');
    const idle = { fetchId: () => 4200, state: { fetchTowards: () => false } };
    npcViewer.packets.length = 0;
    npcViewer.session.dataSendToMe(info(idle));
    assert.deepEqual(npcViewer.packets.map(p => p[0]), [3], 'stationary merchants must not acquire synthetic movement');

    const stopped = viewer();
    owner.moveTimer = null;
    stopped.session.dataSendToMe(info());
    assert.deepEqual(stopped.packets.map(p => p[0]), [3], 'a cancelled server leg must never be resurrected by a refresh');
    owner.moveTimer = {};
    owner.activeMoveGoal = {};
    stopped.packets.length = 0;
    stopped.session.dataSendToMe(info());
    assert.deepEqual(stopped.packets.map(p => p[0]), [3], 'a stale leg from a replaced goal must not replay');
    owner.activeMoveGoal = null;
    owner.activeMoveSegment = null;
    actor.automation = { moveInterpolation: { actor, to: { locX: 500, locY: 200, locZ: -3328 } } };
    stopped.packets.length = 0;
    stopped.session.dataSendToMe(info());
    assert.deepEqual(stopped.packets.map(p => p[0]), [3, 1], 'native automated chases must also resume after snapshots');
    actor.automation.moveInterpolation.followTarget = { fetchId: () => 77,
        fetchLocX: () => 700, fetchLocY: () => 200, fetchLocZ: () => -3328 };
    actor.automation.moveInterpolation.followRadius = 80;
    stopped.packets.length = 0;
    stopped.session.dataSendToMe(info());
    assert.deepEqual(stopped.packets.map(p => p[0]), [3, 0x60], 'following keeps its moving target after a refresh');
    assert.equal(stopped.packets[1].readInt32LE(5), 77);
    assert.equal(stopped.packets[1].readInt32LE(9), 80);
    assert.deepEqual([13, 17, 21].map(i => stopped.packets[1].readInt32LE(i)), [100, 200, -3328]);

} finally {
    Response.charInfo = originals.charInfo;
    Wars.between = originals.between;
    World.fetchVisibleRealPlayers = originals.players;
}
console.log('Character visibility and motion continuity checks passed');
