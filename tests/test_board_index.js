// The board's offer index (б8, BoardIndex): every line of every record by
// side, item and town, sorted best first; a record change moves only its
// lines. The same module serves the main thread and the workers.
const assert = require('assert');
const { BoardIndex, SELL, BUY, rowOf, recordOf } = require('../src/GameServer/AfkTrade/BoardIndex');

const index = new BoardIndex();
const record = (id, fields, lines) => ({ id, kind: 'shop', storeType: SELL, ownerId: id * 10, town: 'Giran',
    botOwned: true, ...fields, lines: lines.map((line, at) => ({ lineId: id * 100 + at, enchant: 0, count: 1, ...line })) });
const ids = (lines) => lines.map((line) => `${line.recordId}/${line.lineId}`);

// Sell lines: cheaper first, a player before a bot, then record and line id.
index.put(record(3, {}, [{ selfId: 7, price: 50 }]));
index.put(record(1, {}, [{ selfId: 7, price: 50 }, { selfId: 7, price: 40, enchant: 3 }]));
index.put(record(2, { botOwned: false }, [{ selfId: 7, price: 50 }]));
index.put(record(4, { town: 'Dion' }, [{ selfId: 7, price: 10 }, { selfId: 8, price: 1 }]));
assert.deepStrictEqual(ids(index.list(7, SELL)), ['4/400', '1/101', '2/200', '1/100', '3/300']);
assert.deepStrictEqual(ids(index.list(7, SELL, 'Giran')), ['1/101', '2/200', '1/100', '3/300'], 'one town');
assert.deepStrictEqual(ids(index.list(7, SELL, 'Aden')), []);
assert.strictEqual(index.first(7, SELL, { town: 'Giran', excludeOwner: 10 }).recordId, 2, 'an owner is skipped');
assert.strictEqual(index.first(7, SELL, { enchant: 3 }).lineId, 101, 'a second line at another enchant is indexed');
assert.strictEqual(index.first(7, SELL, { accept: (line) => line.price > 40 }).recordId, 2);

// A change moves only that record's lines; an empty line leaves the index.
index.put(record(4, { town: 'Dion' }, [{ selfId: 7, price: 60 }, { selfId: 8, price: 1, count: 0 }]));
assert.deepStrictEqual(ids(index.list(7, SELL)), ['1/101', '2/200', '1/100', '3/300', '4/400']);
assert.deepStrictEqual(index.selfIds(SELL), [7], 'an item without lines leaves the index');
index.remove(1);
assert.deepStrictEqual(ids(index.list(7, SELL, 'Giran')), ['2/200', '3/300']);
assert.strictEqual(index.size, 3);

// Buy lines: the higher price first. A record without a town counts in every town.
index.put(record(5, { storeType: BUY }, [{ selfId: 7, price: 20 }]));
index.put(record(6, { storeType: BUY, town: null }, [{ selfId: 7, price: 30 }]));
index.put(record(9, { storeType: BUY, town: 'Dion' }, [{ selfId: 7, price: 99 }]));
assert.deepStrictEqual(ids(index.list(7, BUY)), ['9/900', '6/600', '5/500']);
assert.deepStrictEqual(ids(index.list(7, BUY, 'Giran')), ['6/600', '5/500']);
assert.deepStrictEqual(index.towns(7, BUY).sort(), ['Dion', 'Giran', null].sort());

// The table row of a main-thread store and back.
const store = { shopId: 12, kind: 'sell_ad', storeType: SELL, ownerId: 5, town: 'Oren', botOwned: true,
    items: [{ afkTradeLineId: 40, selfId: 1864, enchant: 0, count: 3, price: 9, name: 'Stem' },
        { afkTradeLineId: 41, selfId: 1865, enchant: 0, count: 0, price: 9 }] };
const row = rowOf(store);
assert.deepStrictEqual(row, [12, 'sell_ad', SELL, 5, 'Oren', 1, [[40, 1864, 0, 3, 9]]]);
assert.deepStrictEqual(recordOf(row), { id: 12, kind: 'sell_ad', storeType: SELL, ownerId: 5, town: 'Oren', botOwned: true,
    lines: [{ lineId: 40, selfId: 1864, enchant: 0, count: 3, price: 9 }] });

// Upkeep at the expected board size: 6.8k records of up to 3 lines over 300
// items in 16 towns; a change costs a few microseconds.
{
    const large = new BoardIndex();
    const towns = ['Giran', 'Dion', 'Gludio', 'Oren', 'Aden', 'Heine', 'Goddard', 'Rune', 'Schuttgart', 'Floran',
        'Hunters Village', 'Gludin', 'Talking Island', 'Elven Village', 'Dark Elven Village', 'Orc Village'];
    let seed = 7;
    const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const build = (id) => record(id, { town: towns[random(16)], botOwned: random(4) > 0 },
        Array.from({ length: 1 + random(3) }, () => ({ selfId: 1 + random(300), price: 1 + random(1000), count: 1 + random(5) })));
    let started = process.hrtime.bigint();
    for (let id = 1; id <= 6800; id++) large.put(build(id));
    const fillMs = Number(process.hrtime.bigint() - started) / 1e6;
    started = process.hrtime.bigint();
    for (let change = 0; change < 10000; change++) large.put(build(1 + random(6800)));
    const changeUs = Number(process.hrtime.bigint() - started) / 1e3 / 10000;
    started = process.hrtime.bigint();
    let found = 0;
    for (let query = 0; query < 10000; query++) {
        if (large.first(1 + random(300), SELL, { town: towns[random(16)], excludeOwner: 10 })) found++;
    }
    const queryUs = Number(process.hrtime.bigint() - started) / 1e3 / 10000;
    console.log(`BoardIndex 6.8k records: fill ${fillMs.toFixed(1)} ms, change ${changeUs.toFixed(2)} us, town query ${queryUs.toFixed(2)} us (${found} found)`);
    assert(changeUs < 200 && queryUs < 50, 'upkeep and lookup stay small');
}

console.log('Board index checks passed');
