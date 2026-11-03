'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const { PlayerClient, npcHtml, bypasses, within } = require('../src/Perf/PlayerClient');
const SendPacket = invoke('Packet/Send');

(async () => {
    // A player session as HotCrowd makes it: its socket takes what the server writes, dataReceive
    // takes the client's frames.
    const frames = [];
    const session = {
        socket: { written: 0, write() { this.written += 1; return true; } },
        actor: { fetchLocX: () => 100, fetchLocY: () => 200, fetchLocZ: () => -300 },
        dataReceive(frame) { frames.push(frame); }
    };
    const client = new PlayerClient(session);

    // A client frame is [length][opcode][fields], as packetReceiver hands it to dataReceive.
    await client.walk({ locX: 1, locY: 2, locZ: 3 });
    const walk = frames[0];
    assert.equal(walk.readInt16LE(0), walk.length);
    assert.equal(walk[2], 0x01);
    assert.deepEqual([3, 7, 11, 15, 19, 23].map(at => walk.readInt32LE(at)), [1, 2, 3, 100, 200, -300],
        'destination, then where the client is');
    await client.say('hi', 0);
    assert.equal(frames[1][2], 0x38);
    assert.equal(frames[1].toString('ucs2', 3, 7), 'hi');

    // What the server writes is named and kept; a wait resolves on the packet, or times out.
    const html = '<html><a action="bypass -h npc_5_Chat 1">Go</a><a action="bypass -h npc_5_teleport 3">Gludin</a></html>';
    const packed = (packet) => {
        const body = packet.fetchBuffer();
        const frame = Buffer.alloc(body.length + 2);
        frame.writeInt16LE(body.length + 2, 0);
        body.copy(frame, 2);
        return frame;
    };
    const waiting = client.packet('NpcHtml', { timeoutMs: 2000 });
    session.socket.write(packed(new SendPacket(0x0f).writeD(5).writeS(html).writeD(0)));
    const entry = await waiting;
    assert.equal(session.socket.written, 1, 'the socket still gets the packet');
    assert.deepEqual(npcHtml(entry), { npcId: 5, html });
    assert.deepEqual(bypasses(html), ['npc_5_Chat 1', 'npc_5_teleport 3']);
    assert.equal((await client.packet('NpcHtml', { timeoutMs: 10 })).at, entry.at, 'an earlier packet answers a later wait');
    await assert.rejects(client.packet('TeleportToLocation', { since: entry.at + 1, timeoutMs: 50 }), /no TeleportToLocation/);
    assert.deepEqual(client.namesSince(0), ['NpcHtml']);

    let calls = 0;
    assert.equal(await within(1000, () => (++calls >= 3 ? 'yes' : null), { everyMs: 5 }), 'yes');
    await assert.rejects(within(30, () => false, { everyMs: 5, what: 'never' }), /never did not hold within 30 ms/);
    console.log('test_perf_player_client passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
