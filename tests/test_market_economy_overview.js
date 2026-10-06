'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const HistoryStore = require('../src/HistoryStore');
const Overview = require('../src/MarketEconomyOverview');
const MarketModel = require('../src/WorldObserver/public/marketModel');

async function main() {
    const directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'test-market-economy-'));
    const file = path.join(directory, 'history.sqlite');
    let connection = HistoryStore.open(file);
    let worker;
    try {
        const timestamp = Date.UTC(2026, 9, 6, 16, 30);
        const hour = Math.floor(timestamp / Overview.HOUR_MS);
        const insert = connection.prepare('INSERT INTO economy_flow_hour (hour, operation, store, selfId, delta, events) VALUES (?, ?, ?, ?, ?, ?)');
        const add = (at, operation, store, selfId, delta) => insert.run(at, operation, store, selfId, delta, 1);
        add(hour - 1, 'loot', 'inventory', 57, 1400);
        add(hour - 1, 'teleport', 'inventory', 57, -300);
        add(hour - 1, 'escrow', 'inventory', 57, -10000);
        add(hour - 1, 'escrow', 'afk_escrow', 57, 10000);
        add(hour - 1, 'hall_bid', 'inventory', 57, -20000);
        add(hour - 1, 'hall_bid', 'clan_hall_bid', 57, 20000);
        add(hour - 1, 'warehouse', 'inventory', 57, -9000);
        add(hour - 1, 'warehouse', 'warehouse', 57, 9000);
        add(hour - 1, 'craft', 'inventory', 1864, -300000);
        add(hour - 24, 'old', 'inventory', 57, 80000);
        add(hour + 1, 'future', 'inventory', 57, 90000);
        add(hour, 'loot', 'inventory', 57, 50);
        const all = (sql, params) => connection.prepare(sql).all(...params);
        const value = Overview.fetch(all, { timestamp });
        assert.strictEqual(value.buckets.length, 24);
        assert.deepStrictEqual(value.buckets.at(-2), { at: (hour - 1) * Overview.HOUR_MS,
            sources: 1400, sinks: 300, net: 1100, observed: true, partial: false });
        assert.strictEqual(value.buckets.at(-1).partial, true);
        assert.strictEqual(value.buckets.at(-1).sources, 50);
        assert.strictEqual(value.buckets[0].observed, false);
        assert.strictEqual(value.buckets[0].sources, 0);
        connection.close();
        connection = null;

        // Exercise the actual read-only overview Worker used by the market API.
        worker = new Worker(path.join(__dirname, '../src/MarketTradeOverviewWorker.js'), { workerData: { databasePath: file } });
        const result = await new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('message', resolve);
            worker.postMessage({ type: 'overview', id: 7, options: { timestamp } });
        });
        assert.strictEqual(result.id, 7);
        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(result.overview.economy, value);
        assert.strictEqual(result.overview.windows.day.trades, 0);

        const counters = Overview.counterIndices({ COUNTER_KEYS: ['gear d', 'shot none'],
            counter: (key, at) => {
                assert.strictEqual(at, timestamp);
                return { deals: key === 'gear d' ? 12 : 0, perHour: 3,
                    index: key === 'gear d' ? Math.log(1.5) : null };
            } }, timestamp);
        assert.strictEqual(counters[0].priceIndex, 150);
        assert.strictEqual(counters[0].changePercent, 50);
        assert.strictEqual(counters[1].priceIndex, null);
        const view = MarketModel.economy({ economy: { counters, adena: result.overview.economy } });
        assert.strictEqual(view.buckets[0].partial, true);
        assert.deepStrictEqual(view.completed, { hours: 1, sources: 1400, sinks: 300, net: 1100 });
        assert.strictEqual(MarketModel.economy({}).available, false);
        console.log('Market economy overview: aggregate net flows, transfers, partial/missing hours, real read-only Worker and price index passed');
    } finally {
        connection?.close();
        if (worker) await worker.terminate();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
