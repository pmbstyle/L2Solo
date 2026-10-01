const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const BotGear = invoke('GameServer/Bot/AI/BotGear');

// Repeated plans for the same class and level are equal but independent.
const first = BotGear.planFor({ classId: 0, level: 15 });
const second = BotGear.planFor({ classId: 0, level: 15 });
assert.deepStrictEqual(second, first);
assert.notStrictEqual(second, first);
assert.notStrictEqual(second.items, first.items);
assert.notStrictEqual(second.items[0], first.items[0]);
assert.notStrictEqual(second.hint, first.hint);

// A caller editing its copy must not change later plans.
const weapon = first.items.find((item) => Number(item.slot) === 7 || Number(item.slot) === 14);
assert.ok(weapon, 'a level 15 fighter plan should include a weapon');
const weaponId = weapon.selfId;
weapon.selfId = -1;
first.items.length = 0;
first.hint.skills.length = 0;
const third = BotGear.planFor({ classId: 0, level: 15 });
assert.deepStrictEqual(third, second);

// Class and level are part of the key.
assert.notDeepStrictEqual(BotGear.planFor({ classId: 10, level: 15 }).items, third.items);
assert.notStrictEqual(BotGear.planFor({ classId: 0, level: 25 }).rank, third.rank);

// A replaced item catalog invalidates cached plans.
const originalItems = DataCache.items;
try {
    DataCache.items = originalItems.filter((item) => Number(item.selfId) !== Number(weaponId));
    const withoutWeapon = BotGear.planFor({ classId: 0, level: 15 });
    assert.ok(!withoutWeapon.items.some((item) => Number(item.selfId) === Number(weaponId)),
        'a plan must not keep an item that left the catalog');
} finally {
    DataCache.items = originalItems;
}
assert.deepStrictEqual(BotGear.planFor({ classId: 0, level: 15 }), second);

console.log('bot gear plan cache tests passed');
