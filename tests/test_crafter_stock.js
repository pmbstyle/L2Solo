// A crafter's gear stock for the board: the reserve sells C/B/A gear to the
// Artisan/Warsmith line at its crafter ref and to anyone else at the valve; a
// crafter restocks the pieces its Create Item level crafts at a town visit (its
// town's demand first, else one display piece per weapon type and armour slot),
// at most six pieces a grade a game hour, and lists them between its cost and the valve.
const assert = require('assert');

// Pins the x50 pace (the x1 pace is checked below).
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('crafter-stock');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const World = invoke('GameServer/World/World');
World.user = { sessions: [], revision: 0 };

const Production = invoke('GameServer/Bot/Economy/ProductionPolicy');
const Fixed = invoke('GameServer/Bot/Economy/FixedShotOffers');
const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ItemTemplateIndex = invoke('GameServer/Item/ItemTemplateIndex');
const HOUR_MS = 3600000;

const warsmith = (extra = {}) => ({ characterId: 996001, accountName: 'bot_996001', name: 'Smith', level: 50, phase: 'cold',
    activity: 'shopping', currentRegion: 'Giran', adena: 500000000, inventory: {},
    stats: { classId: 57, generatedCold: true }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, ...extra });
const fighter = { level: 50, stats: { classId: 1 } };

// 1. A reserve C weapon: the crafter row sells to a Warsmith, not to a fighter; the
// valve row (2.5x the crafter ref) sells to both and is the price without a buyer.
const offers = Stock.townOffers(warsmith());
const weapon = offers.find(offer => offer.grade === 'c' && offer.group.startsWith('Weapon.') && offer.recipeLevel > 0);
assert(weapon, 'Giran sells a Warsmith a C weapon it can craft');
const rows = Fixed.offers(weapon.selfId);
const crafterRow = rows.find(row => Array.isArray(row.buyerClasses));
const valveRow = rows.find(row => !row.buyerClasses);
assert(crafterRow && valveRow, 'each reserve piece has a crafter row and a valve row');
assert.strictEqual(Production.allowsFixed(crafterRow, warsmith()), true, 'a Warsmith buys at the crafter row');
assert.strictEqual(Production.allowsFixed(crafterRow, fighter), false, 'a fighter is refused the crafter row');
assert.strictEqual(Production.allowsFixed(valveRow, fighter), true, 'a fighter buys at the valve row');
assert(Math.abs(valveRow.price - 2.5 * crafterRow.price) <= 2, `valve ${valveRow.price} = 2.5 x crafter ${crafterRow.price}`);
assert.strictEqual(Fixed.lowestPrice(weapon.selfId), valveRow.price, 'a price without a buyer reads the valve row');

// 2. A level-50 Warsmith with money and no town demand keeps one display piece of each
// weapon type it crafts (its top recipe level), never a piece above its craft level.
const craftLevel = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(warsmith());
assert.strictEqual(craftLevel, 6, 'a level-50 Warsmith has Create Item 6');
const t0 = 10 * HOUR_MS;
const first = Stock.restock(warsmith(), { offers, now: t0 });
// Giran sells every C, B and A reserve row: a Create Item 6 Warsmith stocks the B
// weapons it crafts there (their types' top unlocked level), six an hour.
const gradeOf = row => offers.find(offer => offer.selfId === row.selfId).grade;
assert.strictEqual(first.rows.filter(row => gradeOf(row) === 'b').length, 6, 'one hour of allowance: six B pieces in Giran');
const groups = first.rows.map(row => offers.find(offer => offer.selfId === row.selfId).group);
assert.strictEqual(new Set(groups).size, groups.length, 'one piece per weapon type');
assert(groups.every(group => group.startsWith('Weapon.')), 'weapons first');
// At x1 the pace is a fiftieth: a fresh crafter stocks nothing in its first hour and
// its first B piece after about eight and a half hours.
process.env.L2NODE_PROGRESSION_RATE = 'x1';
invoke('GameServer/ProgressionRates').reset();
const slow = Stock.restock(warsmith(), { offers, now: t0 });
assert.strictEqual(slow.rows.length, 0, 'x1: nothing in the first hour');
const later = Stock.restock(warsmith({ stats: { classId: 57, generatedCold: true, gnomeAllowance: slow.allowance } }), { offers, now: t0 + 9 * HOUR_MS });
assert.strictEqual(later.rows.filter(row => gradeOf(row) === 'b').length, 1, 'x1: one B piece after nine hours');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
invoke('GameServer/ProgressionRates').reset();
for (const row of first.rows) {
    const offer = offers.find(entry => entry.selfId === row.selfId);
    assert.strictEqual(row.amount, 1, 'display stock is one piece');
    assert(offer.recipeLevel <= craftLevel, `piece ${row.selfId} at recipe level ${offer.recipeLevel}`);
    assert(!offers.some(other => other.group === offer.group && other.recipeLevel <= craftLevel && other.recipeLevel > offer.recipeLevel),
        `piece ${row.selfId} is its type's top unlocked recipe level`);
    assert.strictEqual(row.unit, offers.find(entry => entry.selfId === row.selfId).price);
}
// Held display pieces are not bought again.
const held = new Set(first.rows.map(row => row.selfId));
const again = Stock.restock(warsmith(), { offers, now: t0 + 5 * HOUR_MS, heldFor: id => held.has(id) ? 1 : 0 });
assert(again.rows.every(row => !held.has(row.selfId)), 'a held display piece is not restocked');

// 3. The allowance: six pieces a grade a game hour, refilled at the read, two hours held.
const demanded = Stock.restock(warsmith(), { offers, now: t0, demandFor: id => id === weapon.selfId ? 20 : 0 });
assert.deepStrictEqual(demanded.rows.filter(row => gradeOf(row) === 'c').map(row => [row.selfId, row.amount]), [[weapon.selfId, 6]],
    'town demand first, six a grade an hour');
const spent = warsmith({ stats: { classId: 57, gnomeAllowance: demanded.allowance } });
assert.strictEqual(Stock.restock(spent, { offers, now: t0, demandFor: () => 20 }).rows.length, 0, 'the seventh piece in the hour is refused');
assert.strictEqual(Stock.restock(spent, { offers, now: t0 + HOUR_MS / 2, demandFor: id => id === weapon.selfId ? 20 : 0 }).rows[0].amount, 3,
    'half an hour refills three');
assert.strictEqual(Stock.restock(spent, { offers, now: t0 + 5 * HOUR_MS, demandFor: id => id === weapon.selfId ? 20 : 0 }).rows[0].amount, 12,
    'at most two hours held');
// Consignment: its wallet does not limit the restock; what it owes does (OWED_PIECES units).
const poor = warsmith({ adena: 0 });
assert.deepStrictEqual(Stock.restock(poor, { offers: [weapon], now: t0, demandFor: () => 20 }).rows.map(row => row.amount), [6],
    'a crafter without adena stocks its allowance');
const owing = warsmith({ adena: 0, stats: { classId: 57, gnomeStock: { 1: { cost: 1, ceiling: 2, owed: Stock.OWED_PIECES - 2 } } } });
assert.deepStrictEqual(Stock.restock(owing, { offers: [weapon], now: t0, demandFor: () => 20 }).rows.map(row => row.amount), [2],
    'a crafter two units below its owed limit stocks two');
assert.strictEqual(Stock.restock(warsmith({ stats: { classId: 1 } }), { offers, now: t0 }).rows.length, 0, 'a fighter stocks nothing');

// 4. Its stock is listed on the board between its cost and the valve, never sent to an NPC.
const template = ItemTemplateIndex.find(DataCache.items, weapon.selfId);
const stocked = warsmith({ inventory: { [weapon.selfId]: { selfId: weapon.selfId, name: template.template.name, amount: 1,
    kind: template.template.kind, rank: template.etc.rank } },
stats: { classId: 57, generatedCold: true, gnomeStock: { [weapon.selfId]: { cost: weapon.price, ceiling: weapon.ceiling } } } });
const market = ListingPolicy.evaluate(stocked, { now: t0, decisionPoint: 'stock' });
const decision = market.decisions.find(entry => Number(entry.item?.selfId) === weapon.selfId);
assert(decision && decision.action === 'list', `the stock piece is listed (${decision?.action}/${decision?.reason})`);
const listing = market.listings.find(entry => Number(entry.selfId) === weapon.selfId);
assert(listing.price >= weapon.price && listing.price <= weapon.ceiling,
    `ask ${listing.price} within [cost ${weapon.price}, valve ${weapon.ceiling}]`);
assert(!market.npc.some(entry => Number(entry.selfId) === weapon.selfId), 'never sold to an NPC');

console.log('crafter stock: ok');
process.exit(0);
