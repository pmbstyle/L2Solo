'use strict';
// The economy model's specification and its code registry stay one list: the
// situation and lever rows of the model's specification marked built are exactly the ids
// of rules/levers.js, each lever points at a function, and each built row
// names a test case that exists.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { specRows } = require('../scripts/economy-model/spec-rows');
const { SITUATIONS, LEVERS } = require('../scripts/economy-model/rules/levers');

const rows = specRows(fs.readFileSync(path.join(__dirname, '../scripts/economy-model/SPEC.md'), 'utf8'));
const STATUSES = ['planned', 'built'];

for (const row of rows) assert.ok(STATUSES.includes(row.cells.status), `SPEC.md:${row.line} ${row.id}: status "${row.cells.status}" is not one of ${STATUSES.join(', ')}`);

// Situation rows sit in tables with a fact column, lever rows in tables with a kind column.
const standing = (list, column) => list.filter(row => column in row.cells && row.cells.status === 'built').map(row => row.id);

// Each id is the id of one row.
const ids = rows.map(row => row.id);
assert.equal(new Set(ids).size, ids.length, `row ids are unique, repeated: [${ids.filter((id, at) => ids.indexOf(id) !== at).join(', ')}]`);
const duplicated = rows.concat(rows.slice(0, 1)).map(row => row.id);
assert.notEqual(new Set(duplicated).size, duplicated.length, 'a duplicated row in a parsed copy is seen as a repeated id');

// Throws with each id that stands on one side only, printed on its side.
function assertOneList(specIds, codeIds) {
    const notInCode = specIds.filter(id => !codeIds.includes(id)), notInSpec = codeIds.filter(id => !specIds.includes(id));
    assert.ok(!notInCode.length && !notInSpec.length,
        `a row or a lever on one side only fails with its id: in SPEC.md, not in rules/levers.js: [${notInCode.join(', ')}]; in rules/levers.js, not in SPEC.md: [${notInSpec.join(', ')}]`);
}

const specIds = standing(rows, 'kind'), codeIds = Object.keys(LEVERS);
assertOneList(specIds, codeIds);
assertOneList(standing(rows, 'fact'), Object.keys(SITUATIONS));

// A row or a lever added on one side only fails, its id printed: a built lever
// row added to a parsed copy of the spec, then its id to a copy of the registry.
const PROBE = { id: 'PROBE.1', line: 0, cells: { kind: 'free', status: 'built' } };
assert.throws(() => assertOneList(standing(rows.concat(PROBE), 'kind'), codeIds),
    error => error.message.includes('in SPEC.md, not in rules/levers.js: [PROBE.1]'),
    'a spec row with no lever fails with its id');
assert.throws(() => assertOneList(specIds, codeIds.concat('PROBE.1')),
    error => error.message.includes('in rules/levers.js, not in SPEC.md: [PROBE.1]'),
    'a lever with no spec row fails with its id');

for (const id of codeIds) assert.equal(typeof LEVERS[id], 'function', `${id} points at the function that does it`);
for (const id of Object.keys(SITUATIONS)) assert.equal(typeof SITUATIONS[id], 'function', `${id} points at the function that names it`);

// Each built row's test cell names a case that exists in that test file.
for (const row of rows.filter(each => each.cells.status === 'built')) {
    const cell = row.cells.test || '', at = cell.indexOf(': ');
    assert.ok(at > 0, `SPEC.md:${row.line} ${row.id}: a built row names "<test file>: <case>", got "${cell}"`);
    const file = path.join(__dirname, cell.slice(0, at)), name = cell.slice(at + 2);
    assert.ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(name), `SPEC.md:${row.line} ${row.id}: no case "${name}" in ${cell.slice(0, at)}`);
}

console.log('test_economy_model_spec: ok');
