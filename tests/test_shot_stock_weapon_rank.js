const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

// U30: the shot a bot loads comes from its equipped weapon's grade, found by two
// near-copies: weaponRankFromRows (item rows from the database; planForRows, used by
// ensureCharacterStock for new characters and seeded cold bots) and
// equippedWeaponInState (the cold inventory summary; planForState). These checks pin
// what each does today, including where they differ, before any unification.

const SWORD_D = 129; // Sword of Revolution, one-handed (slot 7), D grade, 3 shots per charge
const CLAYMORE_D = 70; // two-handed (slot 14), D grade
const FLAMBERGE_C = 71; // two-handed (slot 14), C grade
const BONE_STAFF_D = 178; // two-handed (slot 14), D grade, 2 shots per charge
const SHIELD = 18; // slot 8
const FIGHTER = 0;
const MYSTIC = 10;

const rowsShot = (rows, classId = FIGHTER) => ShotStock.planForRows(rows, classId).selfId;
const stateShot = (inventory, classId = FIGHTER) => ShotStock.planForState({ stats: { classId }, inventory });

// Rows: an equipped (1 or true) row in a weapon slot (7 or 14) decides the grade.
assert.strictEqual(rowsShot([{ selfId: SWORD_D, equipped: 1, slot: 7 }]), 1463, 'D sword: D soulshot');
assert.strictEqual(rowsShot([{ selfId: CLAYMORE_D, equipped: true, slot: 14 }]), 1463, 'two-handed slot counts');
assert.strictEqual(rowsShot([{ selfId: SWORD_D, equipped: 0, slot: 7 }]), 1835, 'an unequipped weapon: no-grade shot');
assert.strictEqual(rowsShot([{ selfId: SHIELD, equipped: 1, slot: 8 }]), 1835, 'a shield is not a weapon');
assert.strictEqual(rowsShot([{ selfId: BONE_STAFF_D, equipped: 1, slot: 14 }], MYSTIC), 2510, 'a mystic loads spiritshots');
assert.strictEqual(rowsShot([]), 1835);
// Difference 1: rows ignore equippedCount (database rows never carry it).
assert.strictEqual(rowsShot([{ selfId: SWORD_D, equipped: 0, equippedCount: 1, slot: 7 }]), 1835,
    'rows: equippedCount without the equipped flag is not equipped');
// Difference 2: with two equipped weapons the first row wins.
assert.strictEqual(rowsShot([{ selfId: SWORD_D, equipped: 1, slot: 7 }, { selfId: FLAMBERGE_C, equipped: 1, slot: 14 }]), 1463,
    'rows: the first equipped weapon row wins');

// State: the same, plus how many shots the weapon takes per charge.
const equippedSword = stateShot({ [SWORD_D]: { selfId: SWORD_D, amount: 1, equipped: true, equippedCount: 1, slot: 7 } });
assert.deepStrictEqual([equippedSword.selfId, equippedSword.perAction], [1463, 3]);
const staff = stateShot({ [BONE_STAFF_D]: { selfId: BONE_STAFF_D, amount: 1, equipped: true, equippedCount: 1, slot: 14 } }, MYSTIC);
assert.deepStrictEqual([staff.selfId, staff.perAction], [2510, 2]);
const unequipped = stateShot({ [SWORD_D]: { selfId: SWORD_D, amount: 1, equipped: false, equippedCount: 0, slot: 7 } });
assert.deepStrictEqual([unequipped.selfId, unequipped.perAction], [1835, 0], 'no weapon: no shot loads');
assert.strictEqual(stateShot({ [SHIELD]: { selfId: SHIELD, amount: 1, equipped: true, slot: 8 } }).selfId, 1835);
assert.strictEqual(ShotStock.planForState({ classId: MYSTIC, inventory: { [BONE_STAFF_D]:
    { selfId: BONE_STAFF_D, equipped: true, slot: 14 } } }).selfId, 2510, 'classId from the state when stats has none');
// Difference 1: the state counts equippedCount even without the equipped flag.
assert.strictEqual(stateShot({ [SWORD_D]: { selfId: SWORD_D, amount: 1, equipped: false, equippedCount: 1, slot: 7 } }).selfId, 1463,
    'state: equippedCount alone counts as equipped');
// Difference 2: with two equipped weapons the lowest item id wins (object key order).
assert.strictEqual(stateShot({
    [SWORD_D]: { selfId: SWORD_D, amount: 1, equipped: true, slot: 7 },
    [FLAMBERGE_C]: { selfId: FLAMBERGE_C, amount: 1, equipped: true, slot: 14 }
}).selfId, 1464, 'state: the equipped weapon with the lowest item id wins');

// The rows caller: a new character's starter shots follow its equipped weapon.
const original = { fetchItems: Database.fetchItems, setItem: Database.setItem, updateItemAmount: Database.updateItemAmount };
(async () => {
    const inserted = [];
    Database.fetchItems = async () => [{ id: 1, selfId: SWORD_D, amount: 1, equipped: 1, slot: 7 }];
    Database.setItem = async (_id, item) => { inserted.push([item.selfId, item.amount]); return { insertId: 5 }; };
    Database.updateItemAmount = async () => { throw new Error('no update expected'); };
    const starter = await ShotStock.ensureCharacterStock(100, { classId: FIGHTER, targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT });
    assert.deepStrictEqual([starter.plan.selfId, inserted], [1463, [[1463, 1000]]], 'starter shots at the weapon grade');
    inserted.length = 0;
    Database.fetchItems = async () => [{ id: 1, selfId: SWORD_D, amount: 1, equipped: 0, equippedCount: 1, slot: 7 }];
    await ShotStock.ensureCharacterStock(100, { classId: FIGHTER, targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT });
    assert.deepStrictEqual(inserted, [[1835, 1000]], 'rows caller ignores equippedCount');
    console.log('Shot stock weapon grade checks passed');
})().finally(() => Object.assign(Database, original)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
