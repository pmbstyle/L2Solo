'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const { notify } = require('../src/GameServer/AfkTrade/PlayerMeetingNotifications');
const makePlayer = id => ({ actor: { fetchId: () => id }, packets: [],
    dataSendToMe(packet) { this.packets.push(packet); } });
const row = (id, state, lines) => ({ id, state, actorA: 1, actorB: 2, terms: JSON.stringify({ lines }) });
const line = (selfId, count, payer = 0, price = 10) => ({ selfId, count, payer, price });
const decode = packet => {
    assert.equal(packet[0], 0x64);
    const id = packet.readInt32LE(1), count = packet.readInt32LE(5), params = [];
    let offset = 9;
    for (let i = 0; i < count; i++) {
        const kind = packet.readInt32LE(offset); offset += 4;
        if (kind === 0) {
            let end = offset;
            while (packet.readUInt16LE(end)) end += 2;
            params.push([kind, packet.subarray(offset, end).toString('utf16le')]); offset = end + 2;
        } else { params.push([kind, packet.readInt32LE(offset)]); offset += 4; }
    }
    assert(packet.subarray(offset).every(byte => byte === 0), 'only packet padding follows the decoded parameters');
    return { id, params };
};
const buyer = makePlayer(1), seller = makePlayer(2);
const goods = [line(1864, 3), line(1864, 2), line(20, 1)];
const accepted = row(1, 'accepted', goods), completed = { ...accepted, state: 'completed' };
notify(buyer, accepted); notify(buyer, accepted);
assert.equal(buyer.packets.length, 1);
assert.match(decode(buyer.packets[0]).params[0][1], /Trade in progress.*reserved/);
notify(buyer, completed);
assert.deepEqual(buyer.packets.map(decode).slice(1), [
    { id: 614, params: [[0, 'Trade completed. Goods and payment are delivered.']] },
    { id: 29, params: [[3, 1864], [1, 5]] },
    { id: 30, params: [[3, 20]] }
], 'received counts come from the basket, aggregating split sources, never the existing stack total');
notify(buyer, completed); notify(buyer, accepted);
notify(buyer, { ...completed, state: 'cancelled' });
assert.equal(buyer.packets.length, 4, 'replays and stale accepted/cancelled rows cannot repeat or regress terminal chat');
notify(seller, completed);
assert.deepEqual(decode(seller.packets[1]), { id: 28, params: [[1, 60]] }, 'seller receives the standard adena pickup message');
const cancelled = row(2, 'cancelled', goods);
notify(buyer, cancelled); notify(buyer, cancelled);
assert.equal(buyer.packets.length, 5, 'refunds do not appear as newly purchased loot');
assert.match(decode(buyer.packets.at(-1)).params[0][1], /Trade cancelled/);
const outside = makePlayer(3), bot = { ...makePlayer(1), accountId: 'bot_seller' };
notify(outside, completed); notify(bot, completed);
assert.equal(outside.packets.length + bot.packets.length, 0);
const failed = makePlayer(1), send = failed.dataSendToMe;
failed.dataSendToMe = function(packet) { if (this.packets.length === 2) throw Error('closed'); send.call(this, packet); };
assert.throws(() => notify(failed, row(3, 'completed', goods)), /closed/);
failed.dataSendToMe = send;
notify(failed, row(3, 'completed', goods));
assert.deepEqual(failed.packets.map(decode), buyer.packets.slice(1, 4).map(decode), 'partial retry resumes after the successfully sent status and item');
const terminalFailure = makePlayer(1);
terminalFailure.dataSendToMe = () => { throw Error('closed'); };
assert.throws(() => notify(terminalFailure, row(4, 'completed', goods)), /closed/);
terminalFailure.dataSendToMe = send;
notify(terminalFailure, row(4, 'accepted', goods));
assert.equal(terminalFailure.packets.length, 0, 'a known terminal outcome never regresses even when its first status send failed');
notify(terminalFailure, row(4, 'completed', goods));
assert.equal(terminalFailure.packets.length, 3);
const reused = makePlayer(1);
notify(reused, completed); reused.actor = { fetchId: () => 2 }; notify(reused, completed);
assert.deepEqual(decode(reused.packets.at(-1)), { id: 28, params: [[1, 60]] }, 'a reused session tracks the current character');
console.log('PASS C4 meeting status, item/adena receipts, net quantities, cancelled refunds, replay dedup and partial transport retry');
