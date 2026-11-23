'use strict';

const { BUY } = require('../../AfkTrade/BoardIndex');

// A refusal is specific to the seller, terms, and public market for the item.
const refused = new Map();
const LIMIT = 4096;
const keyOf = (line, count, sellerId) => `${sellerId}:${line.recordId}:${line.lineId}:${count}`;

function remember(board, line, count, sellerId, fingerprint) {
    if (line?.storeType !== BUY || line.custodyPolicy !== 1 || !Number.isSafeInteger(line.revision)
        || typeof fingerprint !== 'string' || board?.itemFingerprint?.(line.selfId) !== fingerprint) return false;
    const key = keyOf(line, count, sellerId);
    const previous = refused.get(key);
    if (previous?.revision > line.revision
        || previous?.revision === line.revision && previous.fingerprint === fingerprint) return false;
    refused.delete(key);
    refused.set(key, { revision: line.revision, fingerprint });
    if (refused.size > LIMIT) refused.delete(refused.keys().next().value);
    return true;
}

function rejects(board, line, count, sellerId) {
    if (line?.storeType !== BUY || line.custodyPolicy !== 1) return false;
    const refusal = refused.get(keyOf(line, count, sellerId));
    return !!refusal && refusal.revision === line.revision && refusal.fingerprint === board?.itemFingerprint?.(line.selfId);
}

function clear() { refused.clear(); }

module.exports = { remember, rejects, clear };
