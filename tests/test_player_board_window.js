'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const { create: createService } = require('../src/GameServer/AfkTrade/PlayerBoardService');
const Window = require('../src/GameServer/AfkTrade/PlayerBoardWindow');
const packets = [];
let x = 0, selects = 0, crafts = 0, visits = 0, adena = 5000;
const actor = { fetchId: () => 8, fetchHp: () => 100, fetchClanId: () => 0,
    fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0,
    select: () => { selects++; }, backpack: { items: [], insertItem(id, selfId, row) { this.items.push(row); },
        fetchItems() { return this.items; } } };
const session = { actor, accountId: 'player_board_window', dataSendToMe: packet => packets.push(packet) };
const merchant = { fetchId: () => 900045, fetchLocX: () => 1000, fetchLocY: () => 0, fetchLocZ: () => 0 };
const names = new Map([[1459, 'Soulshot: C-grade'], [1835, 'Soulshot: No Grade'], [1864, 'Coal']]);
const board = new BoardIndex();
const afk = { isBoardReady: () => true, boardIndex: () => board, itemName: id => names.get(Number(id)) || 'Soulshot: D-grade',
    offerOf: line => { visits++; return { sourceName: line.ownerId === 46 ? 'Mirella' : 'Kerrigan',
        itemName: afk.itemName(line.selfId), projection: line.ref?.projection }; } };
const shop = { characterId: 55, name: 'Brokk', currentRegion: 'Giran', loc: { locX: 5000, locY: 0, locZ: 0 }, simulation: { revision: 2 } };
let craftPrice = 1200, craftSucceeded = true, craftError = null;
const workshop = { boardRecords: () => [{ id: 'workshop_55', kind: 'workshop', ownerId: 55, ownerName: 'Brokk',
    town: 'Giran', loc: shop.loc, revision: 2, entries: [{ recipeId: 17, price: craftPrice }] }],
    lookup: () => ({ state: shop, recipe: { productId: 1459, productCount: 250, successRate: 60,
        materials: [{ selfId: 1864, amount: 10 }] }, price: craftPrice }),
    craft: async (owner, recipe, customer, options) => {
        if (craftError) throw craftError;
        assert.deepEqual([owner, recipe, customer, options.expectedPrice], [55, 17, 8, 1200]);
        assert.equal(options.expectedRevision, 2);
        crafts++; adena -= options.expectedPrice; return { product: craftSucceeded ? { id: 91, amount: 1 } : null };
    } };
const response = { npcHtml: (_id, html) => html, itemsList: rows => rows, userInfo: () => [],
    systemMessage: invoke('GameServer/Network/Response').systemMessage };
const service = createService({ afk: () => afk, workshops: () => workshop,
    life: () => ({ cachedState: () => ({ currentRegion: 'Dion', loc: { locX: 7000, locY: 0, locZ: 0 } }) }),
    database: () => ({ fetchItems: async () => [{ id: 91, selfId: 1459, amount: 1 }] }), response: () => response });
const window = Window.create({ service: () => service, afk: () => afk, workshops: () => workshop,
    response: () => response, townOf: () => 'Giran' });
const record = (id, selfId, fields = {}) => ({ id, kind: 'shop', storeType: SELL, ownerId: 100 + id, town: 'Giran',
    revision: 4, lines: [{ lineId: id, selfId, count: 2000, price: 18 }], ...fields });
const htmlVisible = html => html.replace(/action="[^"]*"/g, '').replace(/<[^>]+>/g, ' ');
const assertHtml = html => {
    assert(html.length <= 8192);
    assert(!/\b-?\d+_\d+\b|\bitem\s*\d+\b|\bid=\d+/i.test(htmlVisible(html)), 'player text never leaks raw record, spot or item ids');
};

async function main() {
    for (let id = 1; id <= 10000; id++) board.put(record(id, 1 + Math.floor((id - 1) / 100),
        { town: id % 10 === 0 ? null : id % 2 ? 'Giran' : 'Dion' }));
    for (const town of ['Giran', null]) {
        const expected = board.selfIds(SELL).sort((a, b) => a - b).flatMap(id => board.list(id, SELL, town)).map(line => line.lineId);
        const seen = [];
        let cursor = null, page = 0;
        do {
            visits = 0;
            const result = service.entries(session, { side: SELL, town, cursor, limit: 20 });
            seen.push(...result.entries.map(entry => entry.lineId));
            page++;
            if (page === 50) assert(visits <= 21, 'page fifty reads only its own twenty lines and a lookahead');
            cursor = result.next;
        } while (cursor);
        assert.deepEqual(seen, expected, 'town/unplaced union and unfiltered board pages contain every line once in item order');
        assert.equal(new Set(seen).size, seen.length);
    }
    const pageOne = service.entries(session, { side: SELL, town: 'Giran', limit: 20 });
    const back = board.previousCursor(SELL, { town: 'Giran', cursor: pageOne.next });
    assert.deepEqual(service.entries(session, { side: SELL, town: 'Giran', cursor: back, limit: 20 }).entries.map(row => row.lineId),
        pageOne.entries.map(row => row.lineId), 'Previous seeks directly to the preceding page');
    visits = 0;
    const windowFirst = window.show(session, { side: SELL, town: 'Giran' });
    assert(visits <= Window.PAGE_SIZE + 1, 'native HTML reads its six offers and a lookahead');
    const nextCommand = /action="bypass -h (board list [^"]+)"><font[^>]*>Next<\/font>/.exec(windowFirst)[1];
    await window.handle(session, nextCommand.split(' '));
    const pageTwoHtml = packets.at(-1);
    const previousLink = /action="bypass -h (board list [^"]+)"><font[^>]*>Previous<\/font>/.exec(pageTwoHtml);
    assert(previousLink);
    await window.handle(session, previousLink[1].split(' '));
    assert.deepEqual([...packets.at(-1).matchAll(/board answer shop (\d+) /g)].map(match => Number(match[1])),
        [...windowFirst.matchAll(/board answer shop (\d+) /g)].map(match => Number(match[1])));

    board.clear();
    const sell = record(1, 100, { ownerId: 45 });
    sell.lines[0].enchant = 3;
    board.put(sell, { projection: { actor: merchant } });
    board.put(record(2, 1864, { kind: 'buy_ad', storeType: BUY, ownerId: 46, town: 'Dion' }), {});
    const first = window.show(session, {}); assertHtml(first);
    assert.match(htmlVisible(first), /Soulshot: D-grade.*18 a each.*2,000.*Kerrigan.*Giran/);
    assert.match(first, /combobox var="board_town"/);
    assert.match(first, /board search \$board_query/);
    assert.match(htmlVisible(first), /\+3 Soulshot: D-grade/);
    assert(!/Your town|answer<\/font>/.test(first), 'navigation and actions have clear player-facing labels');
    assert.equal(session.playerBoardView.side, SELL); assert.equal(session.playerBoardView.town, 'Giran');
    const sellRequest = { kind: 'shop', id: 1, lineId: 1, selfId: 100, price: 18, revision: 4 };
    assert.equal((await window.answer(session, sellRequest)).action, 'meet');
    assert.match(htmlVisible(packets.at(-1)), /Buy items.*Merchant.*Kerrigan.*Town.*Giran.*Go to the private shop.*marked on your radar/);
    const retry = /action="bypass -h (board answer [^"]+)"><font[^>]*>Try again<\/font>/.exec(packets.at(-1))[1];
    x = 1000;
    const before = packets.length;
    assert.equal((await window.handle(session, retry.split(' '))).action, 'store_opened');
    assert.equal(selects, 2); assert.equal(packets.length, before, 'the normal store window is not replaced by another HTML page');
    const beforeLocation = packets.length;
    session.questWaypoints = new Map([['quest', [1, 2, 3]]]);
    session.nativeItemsWaypoint = { x: 4, y: 5, z: 6 };
    await window.handle(session, ['board', 'locate', 'shop', '1', '1', '100', '18', '4']);
    assert.equal(selects, 2, 'Location only marks the current shop; it cannot open or buy from it');
    assert.deepEqual([session.playerBoardWaypoint.x, session.playerBoardWaypoint.y, session.playerBoardWaypoint.z], [1000,0,0]);
    const markers = packets.slice(beforeLocation).filter(p => Buffer.isBuffer(p) && p[0] === 0xeb);
    assert.deepEqual(markers.map(p => [1,5,9,13,17].map(o => p.readInt32LE(o))),
        [[2,2,0,0,0],[0,1,1,2,3],[0,1,4,5,6],[0,1,1000,0,0]], 'board, item and quest markers coexist');
    await window.handle(session, ['board', 'untrack']);
    assert.equal(session.playerBoardWaypoint, undefined); assert.deepEqual(session.nativeItemsWaypoint, { x: 4, y: 5, z: 6 });
    x = 0;
    window.show(session, { side: BUY, town: 'Dion' });
    assert.match(packets.at(-1), /board answer buy_ad 2 2 1864 18 4/);
    assert.equal((await window.handle(session, ['board', 'answer', 'buy_ad', '2', '2', '1864', '18', '4'])).action, 'contact');
    assert.match(htmlVisible(packets.at(-1)), /Sell items.*Item.*Coal.*Merchant.*Mirella.*Town.*Dion.*Contact the merchant/);
    visits = 0;
    await window.handle(session, ['board', 'search', 'Coal']);
    assert.match(packets.at(-1), /board list buy Dion 1864 -/);
    assert.equal(visits, 0, 'name search uses unique indexed items rather than scanning every offer');
    await window.handle(session, ['board', 'search', 'Soulshot:', 'D-grade']);
    assert.match(htmlVisible(packets.at(-1)), /No matching items/);
    await window.handle(session, ['board', 'town', 'All', 'towns']);
    assert.equal(session.playerBoardView.town, null);
    board.put(record(20, 1864, { storeType: BUY, town: 'Dark Elven Village' }));
    await window.handle(session, ['board', 'town', 'Dark', 'Elven', 'Village']);
    assert.equal(session.playerBoardView.town, 'Dark Elven Village');
    await window.handle(session, ['board', 'town', 'Dion']);
    board.put(record(3, 1835, { kind: 'sell_ad', ownerId: 45 }), {});
    assert.equal((await window.handle(session, ['board', 'answer', 'sell_ad', '3', '3', '1835', '18', '4'])).action, 'contact');
    assert.match(htmlVisible(packets.at(-1)), /Buy items.*Merchant.*Kerrigan.*Town.*Dion.*Contact the merchant/);
    board.put(record(4, 1864, { kind: 'order', storeType: BUY, ownerId: 46, town: 'Dion' }), {});
    assert.equal((await window.handle(session, ['board', 'answer', 'order', '4', '4', '1864', '18', '4'])).action, 'contact');
    assert.match(htmlVisible(packets.at(-1)), /Sell items.*Item.*Coal.*Merchant.*Mirella.*Town.*Dion.*Contact the merchant/);
    window.show(session, { side: SELL, town: 'Giran' });
    board.put({ ...sell, revision: 5, lines: [{ ...sell.lines[0], price: 19 }] }, {});
    assert.equal((await window.answer(session, sellRequest)).reason, 'record_changed');
    assert.match(htmlVisible(packets.at(-1)), /This offer has changed\./);
    assert.match(htmlVisible(packets.at(-1)), /19 a each/);

    window.show(session, { side: 'workshop' });
    const order = { kind: 'workshop', ownerId: 55, recipeId: 17, price: 1200, revision: 2 };
    assert.equal((await window.answer(session, order)).action, 'meet');
    assert.match(htmlVisible(packets.at(-1)), /Meet the crafter.*Soulshot: C-grade.*Brokk.*Giran.*Go to the crafter.*marked on your radar/);
    x = 5000;
    assert.equal((await window.answer(session, order)).action, 'confirm'); assert.equal(crafts, 0); assert.equal(adena, 5000);
    assert.match(htmlVisible(packets.at(-1)), /Product.*Soulshot: C-grade.*Fee.*1,200 a.*Crafter.*Brokk/);
    assert.match(htmlVisible(packets.at(-1)), /Quantity.*250.*Success.*60%.*10.*Coal/);
    assert.match(htmlVisible(packets.at(-1)), /spent even if crafting fails/);
    assert.match(packets.at(-1), /board craft 55 17 1200 2/);
    craftPrice = 1300;
    assert.equal((await window.answer(session, { ...order, confirmed: true })).reason, 'record_changed'); assert.equal(crafts, 0); assert.equal(adena, 5000);
    craftPrice = 1200;
    await window.handle(session, ['board', 'craft', '55', '17', '1200', '2']);
    assert.equal(crafts, 1); assert.equal(adena, 3800); assert.equal(actor.backpack.items[0].selfId, 1459);
    craftSucceeded = false;
    assert.equal((await window.answer(session, { ...order, confirmed: true })).action, 'craft_failed');
    assert.equal(crafts, 2); assert.equal(adena, 2600);
    assert.match(htmlVisible(packets.at(-1)), /Crafting failed.*no item was produced/);
    craftSucceeded = true; craftError = Error('workshop materials missing');
    assert.equal((await window.answer(session, { ...order, confirmed: true })).reason, 'materials_missing');
    assert.match(htmlVisible(packets.at(-1)), /required crafting materials/);
    craftError = Error('customer adena changed');
    assert.equal((await window.answer(session, { ...order, confirmed: true })).reason, 'insufficient_funds');
    assert.match(htmlVisible(packets.at(-1)), /not have enough adena/);
    craftError = null;
    await window.handle(session, ['board', 'search', 'Soulshot:', 'C-grade']);
    assert.match(packets.at(-1), /board list workshop Giran 1459 -/);

    board.clear();
    for (let id = 1; id <= 24; id++) board.put(record(id, 100), {});
    const originalName = afk.itemName;
    afk.itemName = () => 'Long <&> product '.repeat(100);
    const clippedFirst = window.show(session, { side: SELL, town: 'Giran' });
    const clippedNext = /action="bypass -h (board list [^"]+)"><font[^>]*>Next<\/font>/.exec(clippedFirst);
    assert(clippedNext);
    await window.handle(session, clippedNext[1].split(' '));
    const clippedBack = /action="bypass -h (board list [^"]+)"><font[^>]*>Previous<\/font>/.exec(packets.at(-1));
    await window.handle(session, clippedBack[1].split(' '));
    assert.deepEqual([...packets.at(-1).matchAll(/board answer shop (\d+) /g)].map(m => m[1]),
        [...clippedFirst.matchAll(/board answer shop (\d+) /g)].map(m => m[1]), 'Previous returns to the actual HTML-clipped page');
    const shown = [];
    let query = { side: SELL, town: 'Giran' };
    do {
        const html = window.show(session, query); assertHtml(html);
        shown.push(...[...html.matchAll(/board answer shop (\d+) /g)].map(match => Number(match[1])));
        const next = /action="bypass -h (board list [^"]+)"><font[^>]*>Next<\/font>/.exec(html);
        query = next ? { ...query, cursor: Window.decodeCursor(next[1].split(' ').at(-1), SELL) } : null;
    } while (query);
    assert.deepEqual(shown, Array.from({ length: 24 }, (_, i) => i + 1), 'HTML-size cuts continue at the first unseen row');
    afk.itemName = originalName;
    board.clear();
    for (let id = 1; id <= 24; id++) board.put(record(id, 100, { ownerId: id % 2 ? 8 : 45 }), {});
    const hiddenFirst = window.show(session, { side: SELL, town: 'Giran' });
    const hiddenNext = /action="bypass -h (board list [^"]+)"><font[^>]*>Next<\/font>/.exec(hiddenFirst);
    await window.handle(session, hiddenNext[1].split(' '));
    const hiddenBack = /action="bypass -h (board list [^"]+)"><font[^>]*>Previous<\/font>/.exec(packets.at(-1));
    await window.handle(session, hiddenBack[1].split(' '));
    assert.deepEqual([...packets.at(-1).matchAll(/board answer shop (\d+) /g)].map(m => m[1]),
        [...hiddenFirst.matchAll(/board answer shop (\d+) /g)].map(m => m[1]), 'own hidden offers cannot shift Previous to a different page');

    let selectedAmount = 1, cancelled = 0;
    const meetingWindow = Window.create({ afk: () => afk, workshops: () => workshop, response: () => response,
        townOf: () => 'Giran', service: () => ({ entries: () => ({ available: true, entries: [] }),
            answer: async (target, request) => {
                selectedAmount = request.amount ?? 1;
                target.playerBoardPreparation = { ...request, amount: selectedAmount };
                return { ok: true, action: 'confirm_trade', ownerName: 'Kerrigan', side: SELL,
                    amount: selectedAmount, selfId: 1864, town: 'Giran', total: selectedAmount * 18 };
            }, cancel: async () => { cancelled++; } }) });
    await meetingWindow.answer(session, { kind: 'sell_ad', id: 3 });
    assert.match(packets.at(-1), /edit var="board_quantity"/);
    assert.match(packets.at(-1), /board quantity \$board_quantity/);
    await meetingWindow.handle(session, ['board', 'quantity', '7']);
    assert.equal(selectedAmount, 7); assert.match(htmlVisible(packets.at(-1)), /Item.*Coal.*Quantity.*7.*Total.*126 a/);
    await meetingWindow.handle(session, ['board', 'quantity', '0']); assert.equal(selectedAmount, 7);
    session.tradeMeetingPresence = { id: 7 };
    assert.match(meetingWindow.show(session), /board cancel/);
    await meetingWindow.handle(session, ['board', 'cancel']); assert.equal(cancelled, 1);
    session.tradeMeetingPresence = undefined;
    meetingWindow.meetingResult(session, { id: 7, state: 'completed' });
    assert.match(htmlVisible(packets.at(-1)), /Trade completed/);
    const delivered = packets.length;
    meetingWindow.meetingResult(session, { id: 7, state: 'completed' }); assert.equal(packets.length, delivered);
    meetingWindow.meetingResult(session, { id: 8, state: 'cancelled' });
    assert.match(htmlVisible(packets.at(-1)), /Trade cancelled/);

    let finishAgreement, agreementCalls = 0;
    const waitingWindow = Window.create({ afk: () => afk, response: () => response, townOf: () => 'Giran',
        service: () => ({ entries: () => ({ available: true, entries: [] }), answer: () => {
            agreementCalls++; return new Promise(resolve => { finishAgreement = resolve; });
        } }) });
    session.playerBoardPreparation = { id: 9, amount: 1 };
    const agreement = waitingWindow.handle(session, ['board', 'agree']);
    assert.match(htmlVisible(packets.at(-1)), /Checking the trade/);
    const checkingMessages = packets.filter(packet => Buffer.isBuffer(packet) && packet[0] === 0x64).length;
    assert.match(packets.at(-2).subarray(13).toString('utf16le'), /Trade in progress.*Checking goods/);
    await waitingWindow.handle(session, ['board', 'agree']);
    assert.equal(agreementCalls, 1, 'a second Agree click cannot reserve the same trade twice');
    assert.equal(packets.filter(packet => Buffer.isBuffer(packet) && packet[0] === 0x64).length, checkingMessages);
    finishAgreement({ ok: false, reason: 'merchant_busy' });
    await agreement;
    assert.equal(session.playerBoardAgreePending, undefined);
    assert.match(htmlVisible(packets.at(-1)), /merchant is busy/);
    assert.match(packets.at(-2).subarray(13).toString('utf16le'), /merchant is busy/, 'declined agreement also reaches system chat');
    const disconnected = { ...session, dataSendToMe() { throw Error('socket closed'); } };
    await assert.rejects(waitingWindow.handle(disconnected, ['board', 'agree']), /socket closed/);
    assert.equal(disconnected.playerBoardAgreePending, undefined, 'failed progress delivery must release the pending request');
    assert.equal(agreementCalls, 1, 'a disconnected player does not start a new merchant approval');

    const defaultShow = Window.show;
    const ActorGenerics = invoke(path.actor), originalAdmin = ActorGenerics.adminPanel;
    const Config = invoke('GameServer/Bot/Population/PopulationConfig'), oldChatLog = Config.devLogPlayerChat;
    let boardOpened = 0, adminOpened = 0;
    try {
        Window.show = (target, query) => { assert.equal(target, session); assert.deepEqual(query, {}); boardOpened++; };
        ActorGenerics.adminPanel = target => { assert.equal(target, session); adminOpened++; };
        Config.devLogPlayerChat = false;
        invoke('GameServer/Network/Opcodes').table[0x57](session);
        assert.equal(boardOpened, 1); assert.equal(adminOpened, 0);
        invoke('GameServer/Network/Request/Speak').consume(session, { kind: 0, text: '.admin' });
        assert.equal(adminOpened, 1);
    } finally { Window.show = defaultShow; ActorGenerics.adminPanel = originalAdmin; Config.devLogPlayerChat = oldChatLog; }
    console.log('PASS Alt+B market, admin command, 10000-line cursors, HTML bounds and workshop confirmation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
