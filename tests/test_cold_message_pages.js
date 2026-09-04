const assert = require('assert');
const { collectionPages, PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

const rows = Array.from({ length: 130 }, (_, id) => ({ id, text: 'мир🙂'.repeat(900) }));
const pages = collectionPages('snapshot_page', 'test', { rows }, 'fixed');
assert.deepStrictEqual(pages.flatMap(page => page.rows), rows, 'pagination preserves every row in order');
for (const page of pages) {
    assert(page.rows.length <= Protocol.MAX_BATCH);
    assert(Protocol.byteLength(Protocol.envelope('snapshot_page', 'test', page, 'fixed')) <= PAGE_BYTES,
        'UTF-8 size, envelope and delimiters must fit the page budget');
}
const huge = { id: 5, state: { text: 'x'.repeat(300000) } };
let oversize = 0;
const mixed = collectionPages('claim_ack', 'test', { grants: [huge, { id: 6 }], rejected: [{ id: 7 }] }, 'fixed', row => {
    oversize++; return { id: row.id, state: null, reason: 'too_large' };
});
assert.strictEqual(oversize, 1);
assert.deepStrictEqual(mixed.flatMap(page => page.grants).map(row => row.id), [5, 6]);
assert.deepStrictEqual(mixed.flatMap(page => page.rejected).map(row => row.id), [7]);
assert.deepStrictEqual(collectionPages('snapshot_page', 'test', { rows: [huge] }, 'fixed'), []);
console.log('Cold message UTF-8 limits, order and oversize recovery checks passed');
