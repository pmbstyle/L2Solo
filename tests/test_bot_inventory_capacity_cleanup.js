'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const now = 1791825000000;
const bag = (slots, race = 4, expansion = 0) => ({ characterId: 990010, level: 55,
    phase: 'cold', activity: 'hunting', vitals: { hp: 100, mp: 100 },
    // The sale retry: the last visit could not place these scrolls, and nothing new came since.
    stats: { race, classId: race === 4 ? 55 : 2, marketSellSeen: { items: [951], buyers: null },
        coldCombat: { classId: race === 4 ? 55 : 2, skillSource: 'native',
            skills: expansion ? [{ selfId: 1372, level: expansion }] : [] } },
    inventory: { 951: { selfId: 951, amount: slots, kind: 'Other.Scroll', stackable: false,
        instances: Array.from({ length: slots }, (_, index) => ({ id: 9900000 + index,
            amount: 1, equipped: false, enchant: 0 })) } } });

assert.equal(Disposition.inventorySlotCount(bag(86)), 86);
assert.equal(Disposition.inventoryCleanupNeed(bag(86), { now }), null,
    '86 of 100 dwarf slots respect the sale cooldown instead of looping through town');
assert.equal(Floor.forState(bag(86), now), null, 'the native survival floor agrees');
assert.equal(Disposition.inventoryCleanupNeed(bag(101), { now })?.limit, 100,
    'actual dwarf overflow bypasses the cooldown');
assert.equal(Floor.forState(bag(100), now)?.reason, 'no_slot', 'a genuinely full dwarf bag still unloads');
assert.equal(Disposition.inventoryCleanupNeed(bag(45, 0), { now }), null, 'a half-full bag waits through the sale retry');
const newGoods = bag(30, 0);
newGoods.inventory[1864] = { selfId: 1864, amount: 5, kind: 'Other.Material' };
assert.equal(Disposition.inventoryCleanupNeed(newGoods, { now }), null,
    'a new kind ends the retry, but the unsold scrolls do not count towards the half-full bag');
for (let id = 1865; id < 1904; id++) newGoods.inventory[id] = { selfId: id, amount: 1, kind: 'Other.Material' };
assert.equal(Disposition.inventoryCleanupNeed(newGoods, { now })?.reason, 'inventory_half_full',
    'forty slots of goods the last visit did not try send the bot to sell');
assert.equal(Disposition.inventoryCleanupNeed(bag(81, 0), { now })?.limit, 80,
    'ordinary characters retain the native 80-slot limit');
assert.equal(Disposition.inventoryCleanupNeed(bag(101, 4, 1), { now }), null,
    'learned Expand Inventory adds six usable slots');
assert.equal(Floor.forState(bag(101, 4, 1), now), null, 'the native floor counts the expansion too');
assert.equal(Floor.forState(bag(106, 4, 1), now)?.limit, 106);
assert.equal(Disposition.inventoryCleanupNeed(bag(87, 0, 2), { now }), null,
    'ordinary characters also keep their learned expansion');

const items = bag(101).inventory[951].instances;
const actor = { fetchRace: () => 4, fetchMaxLoad: () => 1000000,
    backpack: { fetchItems: () => items, fetchTotalLoad: () => 0 },
    skillset: { fetchSkill: id => id === 1372 ? { fetchLevel: () => 1 } : null } };
assert.equal(Floor.bagMarks(actor).full, 0, 'hot bag flags use the same expanded native limit');
actor.skillset.fetchSkill = () => null;
assert.equal(Floor.bagMarks(actor).full, 1, 'removing the expansion makes the hot bag full');
// E308: a hot solo hunter keeps the cold rule. Weight penalty 1 waits through the
// sale retry kept in its session life state; penalty 2 and a full bag stay the floor.
const heavy = (load) => ({ ...actor, fetchId: () => 990010, isDead: () => false, fetchHp: () => 100, fetchMp: () => 100,
    fetchMaxLoad: () => 1000, skillset: { fetchSkills: () => [], fetchSkill: () => null },
    backpack: { fetchItems: () => [], fetchTotalLoad: () => load } });
const retrying = { stats: { marketSellSeen: { items: [951], buyers: null } } };
const retryOver = { stats: { marketSellSeen: null } };
assert.equal(Floor.forActor(heavy(550), null, now)?.weightPenalty, 1, 'a hot bag at 55 % load is weight penalty 1');
assert.equal(Floor.forActor(heavy(550), retrying, now), null, 'hot penalty 1 waits during the sale retry');
assert.equal(Floor.forActor(heavy(550), retryOver, now)?.reason, 'overweight', 'hot penalty 1 unloads without a retry');
assert.equal(Floor.forActor(heavy(700), retrying, now)?.weightPenalty, 2, 'hot penalty 2 stays the floor during the retry');
console.log('test_bot_inventory_capacity_cleanup: ok');
