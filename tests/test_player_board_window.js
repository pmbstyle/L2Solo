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
let craftPrice = 1200;
const workshop = { boardRecords: () => [{ id: 'workshop_55', kind: 'workshop', ownerId: 55, ownerName: 'Brokk',
    town: 'Giran', loc: shop.loc, revision: 2, entries: [{ recipeId: 17, price: craftPrice }] }],
    lookup: () => ({ state: shop, recipe: { productId: 1459 }, price: craftPrice }),
    craft: async (owner, recipe, customer, options) => {
        assert.deepEqual([owner, recipe, customer, options.expectedPrice], [55, 17, 8, 1200]);
        crafts++; adena -= options.expectedPrice; return { product: { id: 91, amount: 1 } };
    } };
const response = { npcHtml: (_id, html) => html, itemsList: rows => rows };
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
    const pageTwoHtml = window.show(session, { side: SELL, town: 'Giran', cursor: pageOne.next });
    const previousLink = /action="bypass -h (board list [^"]+)"><font[^>]*>Previous<\/font>/.exec(pageTwoHtml);
    assert(previousLink);
    await window.handle(session, previousLink[1].split(' '));
    assert.deepEqual([...packets.at(-1).matchAll(/board answer shop (\d+) /g)].map(match => Number(match[1])),
        pageOne.entries.map(row => row.id));

    board.clear();
    const sell = record(1, 100, { ownerId: 45 });
    board.put(sell, { projection: { actor: merchant } });
    board.put(record(2, 1864, { kind: 'buy_ad', storeType: BUY, ownerId: 46, town: 'Dion' }), {});
    const first = window.show(session, {}); assertHtml(first);
    assert.match(htmlVisible(first), /Soulshot: D-grade.*2,000.*18 a each.*Kerrigan.*Giran/);
    assert.equal(session.playerBoardView.side, SELL); assert.equal(session.playerBoardView.town, 'Giran');
    const sellRequest = { kind: 'shop', id: 1, lineId: 1, selfId: 100, price: 18, revision: 4 };
    assert.equal((await window.answer(session, sellRequest)).action, 'meet');
    assert.match(htmlVisible(packets.at(-1)), /Kerrigan sells in Giran\./);
    x = 1000;
    const before = packets.length;
    assert.equal((await window.answer(session, sellRequest)).action, 'store_opened');
    assert.equal(selects, 2); assert.equal(packets.length, before, 'the normal store window is not replaced by another HTML page');
    x = 0;
    window.show(session, { side: BUY, town: 'Dion' });
    assert.match(packets.at(-1), /board answer buy_ad 2 2 1864 18 4/);
    assert.equal((await window.handle(session, ['board', 'answer', 'buy_ad', '2', '2', '1864', '18', '4'])).action, 'contact');
    assert.match(htmlVisible(packets.at(-1)), /Mirella buys Coal in Dion\. Meet there\./);
    board.put(record(3, 1835, { kind: 'sell_ad', ownerId: 45 }), {});
    assert.equal((await window.handle(session, ['board', 'answer', 'sell_ad', '3', '3', '1835', '18', '4'])).action, 'contact');
    assert.match(htmlVisible(packets.at(-1)), /Kerrigan sells in Dion\./);
    board.put(record(4, 1864, { kind: 'order', storeType: BUY, ownerId: 46, town: 'Dion' }), {});
    assert.equal((await window.handle(session, ['board', 'answer', 'order', '4', '4', '1864', '18', '4'])).action, 'contact');
    assert.match(htmlVisible(packets.at(-1)), /Mirella buys Coal in Dion\. Meet there\./);
    window.show(session, { side: SELL, town: 'Giran' });
    board.put({ ...sell, revision: 5, lines: [{ ...sell.lines[0], price: 19 }] }, {});
    assert.equal((await window.answer(session, sellRequest)).reason, 'record_changed');
    assert.match(htmlVisible(packets.at(-1)), /This offer has changed\./);
    assert.match(htmlVisible(packets.at(-1)), /19 a each/);

    window.show(session, { side: 'workshop' });
    const order = { kind: 'workshop', ownerId: 55, recipeId: 17, price: 1200, revision: 2 };
    assert.equal((await window.answer(session, order)).action, 'meet');
    assert.match(htmlVisible(packets.at(-1)), /Brokk crafts Soulshot: C-grade in Giran\. Meet there\./);
    x = 5000;
    assert.equal((await window.answer(session, order)).action, 'confirm'); assert.equal(crafts, 0); assert.equal(adena, 5000);
    assert.match(htmlVisible(packets.at(-1)), /Craft Soulshot: C-grade for 1,200 a from Brokk\?/);
    assert.match(packets.at(-1), /board craft 55 17 1200 2/);
    craftPrice = 1300;
    assert.equal((await window.answer(session, { ...order, confirmed: true })).reason, 'record_changed'); assert.equal(crafts, 0); assert.equal(adena, 5000);
    craftPrice = 1200;
    await window.handle(session, ['board', 'craft', '55', '17', '1200', '2']);
    assert.equal(crafts, 1); assert.equal(adena, 3800); assert.equal(actor.backpack.items[0].selfId, 1459);

    board.clear();
    for (let id = 1; id <= 24; id++) board.put(record(id, 100), {});
    const originalName = afk.itemName;
    afk.itemName = () => 'Long <&> product '.repeat(100);
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
