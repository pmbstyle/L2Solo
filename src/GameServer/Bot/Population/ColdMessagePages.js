'use strict';
const Protocol = require('./ColdSimulationProtocol');
const PAGE_BYTES = 240 * 1024;

function collectionPages(type, epoch, collections, msgId, onOversize = () => null) {
    const empty = () => Object.fromEntries(Object.keys(collections).map((field) => [field, []]));
    // Reserve room for a generated message ID/timestamp. The sender still
    // validates the complete envelope before postMessage.
    const baseBytes = Protocol.byteLength(Protocol.envelope(type, epoch, empty(), msgId)) + 256;
    const pages = [];
    let page = empty();
    let bytes = baseBytes;
    let count = 0;
    const flush = () => {
        if (count) pages.push(page);
        page = empty(); bytes = baseBytes; count = 0;
    };
    const entryBytes = (value) => Protocol.byteLength([value]) - 2;
    for (const [field, entries] of Object.entries(collections)) {
        for (const original of entries || []) {
            let value = original;
            let size = entryBytes(value);
            if (!Number.isFinite(size) || baseBytes + size > PAGE_BYTES) {
                value = onOversize(original);
                if (!value) continue;
                size = entryBytes(value);
                if (!Number.isFinite(size) || baseBytes + size > PAGE_BYTES) continue;
            }
            if (count >= Protocol.MAX_BATCH || bytes + size + (page[field].length ? 1 : 0) > PAGE_BYTES) flush();
            bytes += size + (page[field].length ? 1 : 0);
            page[field].push(value);
            count++;
        }
    }
    flush();
    return pages;
}

module.exports = { collectionPages, PAGE_BYTES };
