'use strict';

// The economy model's cohort seeds twins by the maintainer's rule: an account
// whose main is a wealth type or has commitment >= 0.62 gets a dwarf crafter
// that knows the recipe scrolls the account holds (at the main's level, by the
// game's learning rule) and a shop seller and buyer; no other account gets
// any. A seeded cohort runs as the same cohort without twins.
const assert = require('node:assert/strict');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const Cohort = require('../scripts/economy-model/cohort');
const Weights = require('../scripts/economy-model/weights');
const BotPersona = require('../src/GameServer/Bot/AI/BotPersona');

const createItemAt = level => (level < 5 ? 0 : level < 20 ? 1 : level < 28 ? 2 : level < 36 ? 3 : level < 43 ? 4 : 5);
const twins = {};
for (let level = 1; level <= 60; level++) twins[level] = { classId: level < 40 ? 56 : 57, createItem: createItemAt(level) };
const recipe = (recipeId, recipeItemId, level, type = 'dwarven', productId = 900 + recipeId) => ({ type, recipeId, recipeItemId, level, productId });
const snapshot = {
    hours: { 9: { 1: { classId: 9 } } }, items: { 1463: { kind: 'Other.Shot' } }, twins,
    recipes: [recipe(1, 701, 2), recipe(2, 702, 3), recipe(3, 703, 4), recipe(4, 704, 1, 'common'), recipe(5, 705, 1, 'dwarven', 1463),
        recipe(6, 706, 1), recipe(7, 706, 2), recipe(8, 707, 5), recipe(9, 707, 1)]
};

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-save-')), file = path.join(folder, 'database.sqlite');
const save = new DatabaseSync(file);
save.exec(`CREATE TABLE characters (id INTEGER PRIMARY KEY, classId INTEGER);
    CREATE TABLE bot_life_state (characterId INTEGER PRIMARY KEY, accountName TEXT, level INTEGER, exp INTEGER, activity TEXT, spotId TEXT, statsJson TEXT);
    CREATE TABLE items (characterId INTEGER, selfId INTEGER, amount INTEGER, equipped INTEGER, slot INTEGER);
    CREATE TABLE warehouse_items (characterId INTEGER, selfId INTEGER, amount INTEGER);
    CREATE TABLE bot_personas (characterId INTEGER PRIMARY KEY, primaryDrive TEXT, traitsJson TEXT);
    CREATE TABLE bot_background_parties (partyId TEXT, memberIdsJson TEXT, status TEXT);`);
// id: [account, level, drive, commitment]
const mains = { 1: ['bot_1', 30, 'wealth', 0.1], 2: ['bot_2', 39, 'progression', 0.62], 3: ['bot_3', 30, 'progression', 0.61],
    4: ['bot_4', 40, 'social', 0.9], 5: ['bot_craft_1', 30, 'wealth', 0.9], 6: ['bot_6', 70, 'wealth', 0.1] };
for (const [id, [account, level, drive, commitment]] of Object.entries(mains)) {
    save.prepare('INSERT INTO characters VALUES (?, 9)').run(id);
    save.prepare('INSERT INTO bot_life_state VALUES (?, ?, ?, 0, ?, NULL, NULL)').run(id, account, level, 'hunting');
    save.prepare('INSERT INTO bot_personas VALUES (?, ?, ?)').run(id, drive, JSON.stringify({ commitment }));
}
const item = (id, selfId, amount) => save.prepare('INSERT INTO items VALUES (?, ?, ?, 0, NULL)').run(id, selfId, amount);
const stored = (id, selfId, amount) => save.prepare('INSERT INTO warehouse_items VALUES (?, ?, ?)').run(id, selfId, amount);
// Main 1 (Create Item 3): 701 twice in the bag, a duplicate learns once; 703 is a level above; 704 is common;
// 702 only in the warehouse is learned and its stored count drops; 701 also stored stays (the bag holds one).
item(1, 701, 2); item(1, 703, 1); item(1, 704, 1); stored(1, 702, 2); stored(1, 701, 1); stored(1, 705, 1);
item(2, 701, 1); item(2, 706, 1); item(1, 707, 1); item(3, 701, 1); item(4, 701, 1); item(5, 701, 1); item(6, 701, 1);
save.close();
const { accounts } = Cohort.fromSave(file, snapshot);
fs.rmSync(folder, { recursive: true });
const by = id => accounts.find(account => account.id === id);

for (const id of [1, 2, 4, 6]) {
    assert.deepEqual(by(id).twins.map(twin => twin.role === 'shop' ? `shop-${twin.side}` : twin.role), ['crafter', 'shop-sell', 'shop-buy'], `main ${id} gets a crafter and two shop twins`);
}
assert.deepEqual(by(3).twins, [], 'commitment 0.61 of a progression main gets none');
assert.deepEqual(by(5).twins, [], 'a station gets none');
assert.deepEqual(by(1).twins[0].recipes, [1, 2, 5], 'the crafter knows the held dwarven scrolls up to its Create Item level, each once');
assert.deepEqual(by(2).twins[0].recipes, [1, 6], 'a scroll teaches only the first recipe row with its id (706: 6, not 7); a first row above the level (707) teaches nothing')
assert.deepEqual(by(1).warehouse, { 701: 1, 702: 1 }, 'learning takes one stored scroll its bag does not hold (702 down by one, 705 gone), not 701');
assert.deepEqual(by(5).warehouse, {}, 'a station keeps no warehouse');
assert.deepEqual(by(3).persona, { primaryDrive: 'progression', traits: { caution: undefined, commitment: 0.61, ambition: undefined } });
assert.deepEqual(by(3).warehouse, {}, 'a main with no stored rows has an empty warehouse');
assert.equal(by(1).twins[0].level, 30);
assert.deepEqual([by(2).twins[0].level, by(2).twins[0].classId, by(4).twins[0].level, by(4).twins[0].classId], [39, 56, 40, 57], 'the crafter follows the main\'s level and class table');
assert.equal(by(6).twins[0].level, 60, 'above the highest twin level the crafter sits at it');
const crafter = by(1).twins[0];
assert.deepEqual([crafter.money, crafter.warehouse, crafter.town], [0, {}, null]);

// A seeded cohort runs as the same cohort without the seeded fields (plain plane).
const Engine = require('../scripts/economy-model/engine');
const Today = require('../scripts/economy-model/today');
const hour = { classId: 9, shotId: 1463, best: { spotId: 's1', kills: 10, exp: 50, adena: 100, shots: 20, dropLoot: 30, spoilLoot: 0, loot: 30, potions: 0, busyShare: 1, deaths: 0 }, top: [] };
const yields = { town: 'TownA', drop: { 57: 10, 200: 0.5 }, spoil: {} };
const run = { header: { levels: [1, 4], rates: { adena: 1 } }, exp: [0, 100, 300, 600], hours: { 9: { 1: hour, 2: hour, 3: hour, 4: hour } },
    kits: { 9: { 1: [{ selfId: 100, slot: 7 }], 2: [{ selfId: 100, slot: 7 }], 3: [{ selfId: 100, slot: 7 }], 4: [{ selfId: 100, slot: 7 }] } },
    yields: { 's1@1': yields, 's1@2': yields, 's1@3': yields, 's1@4': yields },
    items: { 100: { kind: 'Weapon.Sword', grade: 'NONE', ref: 1000, npcBuy: 500 }, 200: { kind: 'Other.Material', grade: 'NONE', ref: 10, npcBuy: 5 }, 1463: { kind: 'Other.Shot', grade: 'NONE', ref: 10, npcBuy: 5 } },
    shotFamilies: { grades: ['NONE', 'D', 'C', 'B', 'A', 'S'], ids: [[1835, 1463, 1464, 1465, 1466, 1467]] },
    npcOffers: { preset: {}, x1: {} }, recipes: [], fares: { TownA: { TownA: 0 } }, twins };
const plain = { id: 1, station: false, classId: 9, line: '9', level: 2, exp: 100, money: 10000, shots: {}, held: [100], worn: { 7: 100 } };
const seededAccount = (() => {
    const cohort = [plain];
    return cohort.map(account => ({ ...account, persona: { primaryDrive: 'wealth', traits: { caution: 0.5, commitment: 0.9 } }, warehouse: { 1: 1 },
        twins: [{ role: 'crafter', id: '1:crafter', classId: 56, level: 2, recipes: [], money: 0, warehouse: {}, town: null }] }));
})();
const simulate = accountsIn => {
    const view = Engine.viewOf(run), today = Today.plane({ view, hunter: Today.hunter(view) });
    return Engine.simulate({ view, plane: { ...today, start: context => ({ ...today.start(context), nextArrival: (main, { event, now, roll }) => now + (event === 'start' ? roll : 1) }) },
        accounts: accountsIn, bands: [['low', 1], ['high', 2]], rates: { default: { huntShare: 1, visitsPerBotHour: 1 } }, hours: 5, seed: 3 });
};
assert.deepEqual(simulate(seededAccount), simulate([plain]), 'twins, persona and warehouse change no number of a run');

// A synthetic cohort is the one it was before the fresh world's builder
// shared its account builder (its records hashed at ce622ce43): lines by the
// class weights, levels in the range, every kit piece worn and held, no money.
{
    const crypto = require('node:crypto');
    const pieces = [{ selfId: 2369, slot: 7 }, { selfId: 1146, slot: 10 }, { selfId: 882, slot: 13 }, { selfId: 882, slot: 14 }];
    const synSnapshot = { hours: { 9: { 1: { classId: 0 }, 2: { classId: 0 }, 3: { classId: 0 } }, 12: { 1: { classId: 10 }, 2: { classId: 10 }, 3: { classId: 10 } },
        55: { 1: { classId: 53 }, 2: { classId: 53 }, 3: { classId: 53 } } },
    kits: { 9: { 1: pieces, 2: pieces, 3: pieces }, 12: { 1: pieces.slice(0, 2) } }, exp: [0, 68, 363], items: {},
    twins: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i + 1, { classId: i + 1 < 40 ? 56 : 57, createItem: i + 1 < 5 ? 0 : 1 }])), recipes: [] };
    const accounts = Cohort.synthetic({ count: 30, low: 1, high: 3, seed: 7 }, synSnapshot).accounts;
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(accounts)).digest('hex').slice(0, 16), 'd2e5042dbf00f1e2', 'a synthetic cohort is unchanged (its persona carries ambition)');
}

// A fresh world: every account a new character at level 1 on a beneficiary
// line, in its line's base class, wearing the game's character-creation kit,
// with 0 adena and the game's starter shots of its class (the C4 tutorial
// reward every generated bot gets at creation: 600 Soulshots for Beginners for
// a fighter, 300 Spiritshots for Beginners for a caster). The game's lines and
// their classes below 20.
const Boot = require('../scripts/economy-model/boot');
const Data = Boot.boot('x50'), Table = invoke('GameServer/Bot/AI/SpotValueTable');
const freshSnapshot = { hours: Object.fromEntries(Table.roles().map(line => [line, { 1: { classId: Table.roleClass(line, 1) } }])),
    kits: {}, exp: Data.experience, items: {}, twins, recipes: snapshot.recipes };
// A line the snapshot holds no level-1 class for has no class to start in: the builder says so.
assert.throws(() => Cohort.fresh({ count: 1, seed: 1 }, { ...freshSnapshot, hours: { ...freshSnapshot.hours, 9: { 20: { classId: 7 } } } }), /line 9 has no level-1 class/);
const COUNT = 4000;
const freshWorld = Cohort.fresh({ count: COUNT, seed: 1 }, freshSnapshot).accounts;
const creation = new Map(Data.newbieItems.map(row => [row.classId, row.items]));
const ShotStock = invoke('GameServer/Inventory/ShotStock');
for (const account of freshWorld) {
    const starter = ShotStock.planFor({ classId: account.classId }).kind === 'spiritshot' ? { 5790: 300 } : { 5789: 600 };
    assert.deepEqual([account.level, account.exp, account.money, account.shots], [1, 0, 0, starter], `account ${account.id} starts at level 1 with 0 exp, 0 adena and its class's beginner shots`);
    assert.equal(account.classId, Table.roleClass(account.line, 1), `account ${account.id} starts in its line's base class`);
    const items = creation.get(account.classId);
    assert.deepEqual(Object.values(account.worn).sort((a, b) => a - b), items.filter(item => item.equipped).map(item => item.selfId).sort((a, b) => a - b), `account ${account.id} wears its class's equipped creation items`);
    assert.deepEqual([...account.held].sort((a, b) => a - b), items.map(item => item.selfId).sort((a, b) => a - b), `account ${account.id} carries every creation item`);
}
// An orc fighter wears its Training Gloves in both hands and carries the Squire's Sword in its bag.
const orc = freshWorld.find(account => account.classId === 44);
// A human fighter fires soulshots and a human mystic spiritshots: each starts with its kind's beginner shots.
assert.deepEqual(freshWorld.find(account => account.classId === 0).shots, { 5789: 600 }, 'a fresh fighter starts with 600 Soulshots for Beginners');
assert.deepEqual(freshWorld.find(account => account.classId === 10).shots, { 5790: 300 }, 'a fresh caster starts with 300 Spiritshots for Beginners');
assert.ok(orc && orc.worn[14] === 2368 && !Object.values(orc.worn).includes(2369) && orc.held.includes(2369), 'an orc fighter wears its gloves and carries its sword');
const freshLines = new Set(freshWorld.map(account => account.line));
assert.ok(!freshWorld.some(account => account.classId === 53), 'no account starts on the dwarf line');
for (const line of ['17', '21', '34', '51', '52']) assert.ok(freshLines.has(line), `buffer line ${line} starts`);
// Line shares follow the class weights over the beneficiary lines (every weighted line but the dwarf's).
const beneficiary = Object.keys(freshSnapshot.hours).filter(line => Weights.CLASS_WEIGHTS[line] > 0 && freshSnapshot.hours[line][1].classId !== 53);
const weightSum = beneficiary.reduce((sum, line) => sum + Weights.CLASS_WEIGHTS[line], 0);
assert.deepEqual([...freshLines].sort(), [...beneficiary].sort(), 'every beneficiary line starts and no other');
for (const line of beneficiary) {
    const share = Weights.CLASS_WEIGHTS[line] / weightSum, seen = freshWorld.filter(account => account.line === line).length;
    assert.ok(Math.abs(seen - COUNT * share) <= 4 * Math.sqrt(COUNT * share * (1 - share)), `line ${line}: ${seen} accounts against ${(COUNT * share).toFixed(0)} by its weight`);
}
assert.deepEqual(Cohort.fresh({ count: COUNT, seed: 1 }, freshSnapshot).accounts, freshWorld, 'one seed gives one world');
assert.notDeepEqual(Cohort.fresh({ count: COUNT, seed: 2 }, freshSnapshot).accounts.map(account => account.line), freshWorld.map(account => account.line), 'two seeds differ');

// A fresh cohort is seeded by the game's generated personas, with no recipes (it holds no scrolls).
const fresh = freshWorld;
const counts = {};
let expected = 0;
for (const account of fresh) {
    const persona = BotPersona.generate({ characterId: account.id, classId: account.classId, stats: { generatedIndex: account.id - 1 } }, { counts, total: COUNT });
    counts[persona.archetype] = (counts[persona.archetype] || 0) + 1;
    // every fresh account carries a persona drawn by the game's rule
    assert.deepEqual(account.persona, { primaryDrive: persona.primaryDrive, traits: { caution: persona.traits.caution, commitment: persona.traits.commitment, ambition: persona.traits.ambition } }, `account ${account.id} carries its generated persona`);
    if (persona.primaryDrive === 'wealth' || persona.traits.commitment >= 0.62) expected++;
}
assert.ok(expected > 0 && expected < COUNT, 'the generated personas split');
assert.equal(fresh.filter(account => account.twins.length === 3).length, expected, 'a fresh account gets twins when its generated persona is wealth or committed');
assert.ok(fresh.every(account => account.twins.length === 0 || account.twins[0].recipes.length === 0), 'a fresh cohort holds no scrolls, so no crafter knows a recipe');
console.log('economy model cohort ok');
