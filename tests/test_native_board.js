'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../src/Global');
const Window = require('../src/GameServer/AfkTrade/PlayerBoardWindow');
const Native = require('../src/GameServer/AfkTrade/NativeBoard');
const Meeting = require('../src/GameServer/AfkTrade/PlayerBoardMeeting');
const packets = [], fixtures = [], calls = [];
const session = { actor: { fetchId: () => 8 }, accountId: 'native_board_test', dataSendToMe: p => packets.push(p) };
const queryRows = [0, 1, 2, 3, 4, 5].map(i => ({ id: 90 + i, lineId: 100 + i, selfId: 1864 + i, kind: 'sell_ad',
    price: 9876543210, count: 6000000000, revision: 4, itemName: 'Coal ' + i, ownerName: 'Brokk', town: 'Giran', conditional: true }));
let reply = { ok: true, action: 'confirm_trade', selfId: 1864, amount: 3, price: 9876543210,
    total: 29629629630, ownerName: 'Brokk', town: 'Giran' }, hold;
const service = {
    entries: (_s, options) => ({ available: true, entries: options.side === 'workshop' ? [] : queryRows, next: { selfId: 1869, n: 7, side: 1 } }),
    itemIds: () => queryRows.map(r => r.selfId),
    answer: async (_s, request) => {
        calls.push(request); if (hold) await hold;
        if (reply.action === 'confirm_trade') session.playerBoardPreparation = { ...request, amount: request.amount || reply.amount };
        return reply;
    },
    cancel: async () => { session.tradeMeetingPresence = undefined; return { ok: true }; }
};
const board = Window.create({ service: () => service,
    afk: () => ({ itemName: id => 'Coal ' + (id - 1864), boardIndex: () => ({ townItems: new Map([[1, new Map([['Giran', []], ['Dion', []]])]]), itemIds: () => [1864], lines: () => [{ custodyPolicy: 1, kind: 'sell_ad' }] }) }),
    workshops: () => ({ boardRecords: () => [] }), response: () => invoke('GameServer/Network/Response'), townOf: () => 'Giran',
    meeting: s => Meeting.status(s, { life: () => ({ cachedState: () => ({ name: 'Brokk', loc: { locX: 5000, locY: 0, locZ: 0 },
        activity: 'traveling', stats: { travel: { meetingId: 55, to: { locX: 0, locY: 0, locZ: 0 }, arrivalAt: 100000 } } }) }), now: 10000 }) });
const handle = Native.create({ window: () => board });
const body = () => { const p = packets.at(-1);assert.equal(p[0], 0x0f);let end = 5;while (p.readUInt16LE(end)) end += 2;return p.subarray(5, end).toString('utf16le'); };
const capture = () => { const value = body();assert(value.startsWith(Native.PREFIX) || value.startsWith(Native.PREFIX_V2));assert(value.length <= 8192);fixtures.push(value);return value; };
const run = (role, extra) => {
    const id = session.nativeBoardActions.findIndex(a => a.role === role) + 1;assert(id);
    return handle(session, ['native-board', 'run', String(session.nativeBoardEpoch), String(session.nativeBoardRevision), String(id), ...(extra ? [extra] : [])]);
};
async function main() {
    await handle(session, ['native-board', 'open', '1']);assert(!packets.length);
    board.open(session);assert(body().includes('<!--L2SOLO_BOARD-->'));
    await handle(session, ['native-board', 'open', '1']);
    let value = capture();assert(value.includes('9,876,543,210 a each') && value.includes('6,000,000,000 available'));
    assert.equal(session.nativeBoardModel.rows.length, 6);assert(value.includes('Meeting offer'));
    const revision = session.nativeBoardRevision, epoch = session.nativeBoardEpoch;
    for (const parts of [['run', epoch, revision - 1, 2], ['run', epoch - 1, revision, 2], ['run', epoch, revision, 0], ['run', epoch, revision, '02'], ['run', epoch, revision, 99]]) {
        await handle(session, ['native-board', ...parts.map(String)]);assert.equal(calls.length, 0);
    }
    const action = session.nativeBoardActions.findIndex(a => a.command.startsWith('board answer')) + 1;
    await handle(session, ['native-board', 'run', String(epoch), String(revision), String(action)]);
    capture();assert.equal(calls.length, 1);assert.equal(calls[0].price, 9876543210);
    assert.equal(session.nativeBoardModel.screen, 'detail');assert.equal(session.nativeBoardModel.title, 'Buy items');
    assert(session.nativeBoardModel.details.some(([k, v]) => k === 'Total' && v === '29,629,629,630 a'));
    await run('quantity', '8');capture();assert.equal(calls.at(-1).amount, 8);
    const before = calls.length;await run('quantity', '1e2');assert.equal(calls.length, before);
    session.playerBoardPreparation = { kind: 'sell_ad', id: 90, lineId: 100, selfId: 1864, price: 9876543210, revision: 4, amount: 8 };
    reply = { ok: true, action: 'agreed', ownerName: 'Brokk', town: 'Giran' };
    session.tradeMeetingPresence = { id: 55, actorId: 8, otherId: 9, locX: 0, locY: 0, locZ: 0, town: 'Giran' };
    let finish;hold = new Promise(resolve => { finish = resolve; });
    const agree = run('primary');await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.nativeBoardModel.title, 'Checking the trade');capture();
    const busyCalls = calls.length;await handle(session, ['native-board', 'refresh', String(epoch), String(session.nativeBoardRevision)]);assert.equal(calls.length, busyCalls);
    finish();hold = null;await agree;capture();
    assert.equal(session.nativeBoardModel.title, 'Trade agreed');assert.equal(session.nativeBoardModel.meeting.seconds, 90);
    await handle(session, ['native-board', 'refresh', String(epoch), String(session.nativeBoardRevision)]);capture();
    assert.equal(session.nativeBoardModel.title, 'Trade agreed', 'poll preserves the agreed detail screen');
    await run('cancel');capture();assert(!session.nativeBoardModel.meeting);
    await handle(session, ['native-board', 'search', String(epoch), String(session.nativeBoardRevision), 'Coal%20']);capture();
    assert.equal(session.nativeBoardModel.screen, 'search');assert.equal(session.nativeBoardModel.rows.length, 6);
    await handle(session, ['native-board', 'search', String(epoch), String(session.nativeBoardRevision), '%20']);capture();assert.equal(session.playerBoardSearch, '');
    const towns = session.nativeBoardTowns;assert(towns.includes('Dion'));
    await handle(session, ['native-board', 'town', String(epoch), String(session.nativeBoardRevision), String(towns.indexOf('Dion'))]);capture();assert.equal(session.playerBoardView.town, 'Dion');
    reply = { ok: true, action: 'confirm', productId: 1459, productCount: 250, price: 1200, ownerId: 55, recipeId: 17, revision: 2,
        ownerName: 'Brokk', successRate: 60, materials: [{ selfId: 1864, amount: 10 }] };
    await board.answer(session, { kind: 'workshop', ownerId: 55, recipeId: 17, price: 1200, revision: 2 });capture();
    assert(session.nativeBoardModel.rows.some(r => r.itemId === 1864 && r.quantity === '10'));
    assert(session.nativeBoardModel.message.includes('even if crafting fails'));
    reply = { ok: true, action: 'store_opened' };await board.answer(session, { kind: 'shop', selfId: 1864 });capture();assert.equal(session.nativeBoardModel.screen, 'store');
    board.open(session);capture();const latestEpoch = session.nativeBoardEpoch;
    await handle(session, ['native-board', 'close', String(epoch)]);assert(session.nativeBoardOpen);
    await handle(session, ['native-board', 'close', String(latestEpoch)]);const packetCount = packets.length;
    board.meetingResult(session, { id: 55, state: 'completed' });assert.equal(packets.length, packetCount, 'completion cannot reopen a closed native panel');
    board.open(session);capture();await handle(session, ['native-board', 'open', '0']);assert(body().includes('<!--L2SOLO_BOARD-->'));
    // A late async result must not hide or replace a newly opened board.
    session.nativeBoardVersion = 1;board.open(session);capture();
    let finishLate;hold = new Promise(resolve => { finishLate = resolve; });
    reply = { ok: true, action: 'store_opened' };
    const late = board.answer(session, { kind: 'shop', selfId: 1864 });
    board.open(session);const newPacketCount = packets.length;finishLate();hold = null;await late;
    assert.equal(packets.length, newPacketCount);assert(session.nativeBoardOpen);
    const nativeHandler = Native.handle;let routed;
    try {
        Native.handle = (s, parts) => { assert.equal(s, session);routed = parts; };
        invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-board refresh 1 2' });
        assert.deepEqual(routed, ['native-board', 'refresh', '1', '2']);
    } finally { Native.handle = nativeHandler; }
    session.tradeMeetingPresence = { id: 55, actorId: 9, otherId: 10, locX: 0, locY: 0, locZ: 0, town: 'Giran' };
    board.open(session);capture();
    assert.equal(session.nativeBoardModel.meeting, null, 'a previous character meeting is not shown in the native window');
    assert(!session.nativeBoardActions.some(a => a.role === 'cancel'), 'native navigation cannot cancel a previous character meeting');
    assert.equal(Meeting.status(session, { life: () => { throw Error('foreign meeting must not read bot state'); } }), null);
    const meeting = { id: 55, actorId: 8, otherId: 9, locX: 0, locY: 0, locZ: 0, route: { durationMs: 60000 } };
    const status = state => Meeting.status({ actor: session.actor, tradeMeetingPresence: meeting }, { life: () => ({ cachedState: () => state }), now: 10000 });
    const far = { loc: { locX: 5000, locY: 0, locZ: 0 }, stats: {} };
    assert.equal(status({ ...far, activity: 'fighting' }).seconds, 0);
    assert.equal(status({ ...far, activity: 'resting', stats: { restUntil: 30000 } }).seconds, 80);
    assert.equal(status({ ...far, stats: { travel: { meetingId: 12, to: far.loc, arrivalAt: 30000 } } }).seconds, 0);
    assert.equal(status({ ...far, stats: { travel: { meetingId: 55, to: far.loc, arrivalAt: 30000 } } }).phase, 'Travelling to the next stop');
    assert.equal(status({ ...far, loc: { locX: 0, locY: 0, locZ: 0 } }).seconds, 0);
    session.tradeMeetingPresence = undefined;
    board.open(session);
    await handle(session, ['native-board', 'open', '2']);
    assert(capture().startsWith(Native.PREFIX_V2));
    const filter = value => handle(session, ['native-board', 'type', String(session.nativeBoardEpoch), String(session.nativeBoardRevision), value]);
    const oldRevision = session.nativeBoardRevision;
    await filter('meeting');capture();assert.equal(session.playerBoardView.tradeType, 'meeting');
    assert(session.nativeBoardActions.filter(a => a.command.startsWith('board list')).every(a => a.command.endsWith(' meeting')));
    await handle(session, ['native-board', 'type', String(session.nativeBoardEpoch), String(oldRevision), 'shop']);
    assert.equal(session.playerBoardView.tradeType, 'meeting', 'stale filter selection is ignored');
    await filter('invalid');assert.equal(session.playerBoardView.tradeType, 'meeting');
    await handle(session, ['native-board', 'town', String(session.nativeBoardEpoch), String(session.nativeBoardRevision), '0']);capture();
    assert.equal(session.playerBoardView.tradeType, 'meeting', 'place selection preserves the trade filter');
    await handle(session, ['native-board', 'search', String(session.nativeBoardEpoch), String(session.nativeBoardRevision), '%20']);capture();
    assert.equal(session.playerBoardView.tradeType, 'meeting', 'clearing search preserves the trade filter');
    await run('buy');capture();assert.equal(session.playerBoardView.tradeType, 'meeting');
    await run('workshop');capture();assert.equal(session.playerBoardView.tradeType, 'all', 'craft has its own stationary workshop offers');
    await handle(session, ['native-board', 'open', '1']);assert(capture().startsWith(Native.PREFIX), 'V1 clients retain the original wire layout');
    reply = { ok: true, action: 'meet', conditional: true, side: 1, ownerName: 'Brokk', town: 'Goddard',
        loc: { locX: 147744.7496179188, locY: -56093.45587490757, locZ: -2781 } };
    await board.answer(session, { kind: 'sell_ad', id: 90, lineId: 100, selfId: 1864, price: 123, revision: 4 });
    assert(session.nativeBoardModel.details.some(([label, value]) => label === 'Radar' && value === 'Location marked'));
    const marker = packets.filter(packet => packet[0] === 0xeb).at(-1);
    assert.deepEqual([1, 5, 9, 13, 17].map(offset => marker.readInt32LE(offset)), [0, 1, 147745, -56093, -2781]);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(fixtures.join('\0'), 'utf16le'));
    console.log('PASS native Market Board: wire snapshots, full prices, guarded actions, quantity, async agreement, meeting ETA, search/town, craft materials, private store handoff, close and stock fallback');
}
main().catch(error => { console.error(error);process.exitCode = 1; });
