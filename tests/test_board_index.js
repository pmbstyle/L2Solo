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
assert.deepStrictEqual(ids([...index.lines(7, BUY, 'Giran')]), ids(index.list(7, BUY, 'Giran')), 'lazy town cursor merges unplaced lines in the same price order');
assert.deepStrictEqual(ids([...index.lines(7, SELL)]), ids(index.list(7, SELL)), 'lazy global cursor uses the same index');
assert.equal(index.lines(7, BUY, 'Giran').next().value.recordId, 6, 'bounded consumers can stop after the first indexed quote');
assert.deepStrictEqual(index.towns(7, BUY).sort(), ['Dion', 'Giran', null].sort());

// The table row of a main-thread store and back.
const store = { shopId: 12, kind: 'sell_ad', storeType: SELL, ownerId: 5, town: 'Oren', botOwned: true,
    revision: 4,
    items: [{ afkTradeLineId: 40, selfId: 1864, enchant: 0, count: 3, price: 9, name: 'Stem' },
        { afkTradeLineId: 41, selfId: 1865, enchant: 0, count: 0, price: 9 }] };
const row = rowOf(store);
assert.deepStrictEqual(row, [12, 'sell_ad', SELL, 5, 'Oren', 1, [[40, 1864, 0, 3, 9, null, 0]], 4]);
assert.deepStrictEqual(recordOf(row), { id: 12, kind: 'sell_ad', storeType: SELL, ownerId: 5, town: 'Oren', botOwned: true,
    revision: 4, lines: [{ lineId: 40, selfId: 1864, enchant: 0, count: 3, price: 9, fills: 0 }] });
assert.strictEqual(recordOf(row.slice(0, 7)).revision, null, 'old worker rows stay readable without a revision fence');
const state = { price: 9, seenCounter: 4, seenItem: 2, rival: 10, worth: 0, seenFills: 1 };
const pricedRow = rowOf({ ...store, items: [{ ...store.items[0], pricing: state, fills: 2 }] });
index.put(recordOf(pricedRow));
assert.deepStrictEqual(index.ownerLines(5)[0].pricing, state, 'line observations cross the worker table unchanged');
assert.strictEqual(index.ownerLines(5)[0].fills, 2);
assert.deepStrictEqual(recordOf([12, 'sell_ad', SELL, 5, 'Oren', 1, [[40, 1864, 0, 3, 9]], 4]).lines,
    [{ lineId: 40, selfId: 1864, enchant: 0, count: 3, price: 9, fills: 0 }], 'legacy tuples remain readable without invented state');

// An owner's lines and the open sell lines of a group (the market counters).
{
    const grouped = new BoardIndex({ groupOf: (selfId) => (selfId < 100 ? 'low' : 'high') });
    grouped.put({ id: 1, ownerId: 3, storeType: SELL, town: 'Giran', lines: [{ lineId: 1, selfId: 7, count: 2, price: 5 },
        { lineId: 2, selfId: 200, count: 1, price: 9 }] });
    grouped.put({ id: 2, ownerId: 3, storeType: BUY, town: 'Giran', lines: [{ lineId: 3, selfId: 8, count: 1, price: 4 }] });
    grouped.put({ id: 3, ownerId: 4, storeType: SELL, town: 'Dion', lines: [{ lineId: 4, selfId: 9, count: 1, price: 6 }] });
    assert.deepStrictEqual(grouped.ownerLines(3).map((line) => line.lineId).sort(), [1, 2, 3]);
    assert.deepStrictEqual([grouped.linesIn('low'), grouped.linesIn('high')], [2, 1], 'sell lines only, by group');
    grouped.put({ id: 1, ownerId: 3, storeType: SELL, town: 'Giran', lines: [{ lineId: 2, selfId: 200, count: 1, price: 8 }] });
    assert.deepStrictEqual([grouped.linesIn('low'), grouped.linesIn('high')], [1, 1], 'a replaced record counts anew');
    grouped.remove(2);
    grouped.remove(1);
    assert.deepStrictEqual(grouped.ownerLines(3), []);
    assert.strictEqual(grouped.owners.has(3), false, 'an owner without records leaves the index');
    assert.deepStrictEqual([grouped.linesIn('low'), grouped.linesIn('high')], [1, 0]);
}

// Upkeep at the expected board size: 6.8k records of up to 3 lines over 300
// items in 16 towns; a change costs a few microseconds.
{
    const paging = new BoardIndex();
    let seed = 947;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let change = 0; change < 1000; change++) {
        const id = 1 + random(40);
        if (random(4) === 0) paging.remove(id);
        else paging.put(record(id, { storeType: random(2) ? SELL : BUY, town: ['Giran', 'Dion', null][random(3)] },
            Array.from({ length: 1 + random(3) }, () => ({ selfId: 1 + random(30), price: random(100), count: random(3) }))));
        for (const side of [SELL, BUY]) {
            const expected = new Map();
            for (const [id, item] of paging.sides.get(side)) {
                for (const town of ['*', ...item.towns.keys()]) {
                    if (!expected.has(town)) expected.set(town, []);
                    expected.get(town).push(id);
                }
            }
            const actual = paging.townItems.get(side);
            assert.strictEqual(actual.size, expected.size);
            for (const [town, ids] of expected) assert.deepStrictEqual(actual.get(town), ids.sort((a, b) => a - b));
            for (const town of [null, 'Giran', 'Dion']) {
                const expectedLines = [...paging.sides.get(side).keys()].sort((a, b) => a - b)
                    .flatMap(id => paging.list(id, side, town));
                assert.deepStrictEqual([...paging.page(side, { town })].map(row => row.line), expectedLines);
                if (expectedLines.length > 3) {
                    const rows = [...paging.page(side, { town })];
                    assert.deepStrictEqual([...paging.page(side, { town, cursor: rows[3].cursor })].map(row => row.line),
                        expectedLines.slice(3), 'a cursor seeks within the merged town/unplaced list');
                }
            }
        }
    }
    paging.clear();
    assert([...paging.townItems.values()].every(towns => !towns.size));
}

if (process.env.L2NODE_SKIP_BOARD_INDEX_BENCHMARK !== '1') {
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
