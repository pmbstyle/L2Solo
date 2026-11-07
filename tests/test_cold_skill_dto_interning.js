'use strict';

// A cold worker shares one frozen record per distinct skill row. Re-publishing
// a bot's state (every commit ack and page) must leave its skill array, the
// shared records and the pool exactly as a full interning pass would.
const assert = require('node:assert/strict');
const { SkillDtoInterner, FIELDS } = require('../src/GameServer/Bot/Population/SkillDtoInterner');

function row(selfId, level = 1) {
    const value = {};
    for (const key of FIELDS) value[key] = ['passive', 'spell', 'isCubic'].includes(key) ? false : 0;
    return { ...value, selfId, level };
}
const set = (interner, id, array) => { interner.commit(interner.prepare(id, array)); return array; };

{
    const interner = new SkillDtoInterner();
    const first = set(interner, 1, [row(3), row(4), row(3)]);
    const dtos = [...first];
    assert(dtos.every(dto => Object.isFrozen(dto)));
    assert.strictEqual(dtos[0], dtos[2], 'equal rows share one record');
    const before = interner.size();

    // The same interned array re-set: same records, same pool.
    set(interner, 1, first);
    assert.deepEqual([...first], dtos);
    first.forEach((dto, i) => assert.strictEqual(dto, dtos[i]));
    assert.deepEqual(interner.size(), before);

    // Another bot with raw copies gets the same records.
    const second = set(interner, 2, [row(4), row(3)]);
    assert.strictEqual(second[0], dtos[1]);
    assert.strictEqual(second[1], dtos[0]);
    const shared = interner.size();
    assert.equal(shared.unique, 2);

    // A new array holding the held records, then a refused publication: nothing changes.
    const copy = [...first];
    interner.rollback(interner.prepare(1, copy));
    copy.forEach((dto, i) => assert.strictEqual(dto, dtos[i]));
    assert.deepEqual(interner.size(), shared);
    set(interner, 1, copy);
    assert.deepEqual(interner.size(), shared);

    // An element replaced in place is interned again; the dropped record stays while bot 2 holds it.
    copy[1] = row(5);
    set(interner, 1, copy);
    assert(Object.isFrozen(copy[1]));
    assert.equal(interner.size().unique, 3);
    assert.strictEqual(copy[0], dtos[0]);

    // Releasing every owner frees every record.
    interner.remove(1);
    interner.remove(2);
    assert.deepEqual({ ...interner.size(), fallback: 0 }, { owners: 0, unique: 0, buckets: 0, fallback: 0,
        acquiredSlots: 0, slotLimit: 4096 });
}

{
    // A row that fell back on a full pool is admitted on the next re-set once a slot frees.
    const interner = new SkillDtoInterner({ maxUnique: 1 });
    set(interner, 1, [row(7)]);
    const array = set(interner, 2, [row(8)]);
    assert(!Object.isFrozen(array[0]), 'a full pool keeps the raw row');
    assert.equal(interner.size().fallback, 1);
    interner.remove(1);
    set(interner, 2, array);
    assert(Object.isFrozen(array[0]), 'the next re-set admits it');
    assert.equal(interner.size().unique, 1);
}

{
    // An array that cannot be interned (a frozen membership) drops the owner as before.
    const interner = new SkillDtoInterner();
    const array = set(interner, 1, [row(9)]);
    Object.freeze(array);
    set(interner, 1, array);
    assert.equal(interner.size().owners, 0);
    assert.equal(interner.size().unique, 0);
}

console.log('test_cold_skill_dto_interning: ok');
