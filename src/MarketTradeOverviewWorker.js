'use strict';

const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const MarketTradeOverview = require('./MarketTradeOverview');
const MarketEconomyOverview = require('./MarketEconomyOverview');

const connection = new DatabaseSync(String(workerData.databasePath), { readOnly: true, timeout: 250 });
const all = (sql, params = []) => connection.prepare(sql).all(...params);

parentPort.on('message', (message = {}) => {
    if (message.type !== 'overview') return;
    try {
        parentPort.postMessage({ id: message.id, overview: {
            ...MarketTradeOverview.fetch(all, message.options),
            economy: MarketEconomyOverview.fetch(all, message.options)
        } });
    } catch (error) {
        parentPort.postMessage({ id: message.id, error: error?.message || String(error) });
    }
});
