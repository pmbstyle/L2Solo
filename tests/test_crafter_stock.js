// A supplier's gear stock for the board: the reserve sells C/B/A gear to the crafter
// and spoiler line (crafter rows) and to the station traders (trader rows), each at
// 0.6 x the price anchor, never to another bot; a crafter restocks the pieces its
// Create Item level crafts at a town visit (its town's demand first, else one display
// piece per weapon type and armour slot), at most six pieces a grade a game hour, and
// lists them between its cost and the anchor. A station trader does the same
// with no level gate, half the volume and no shots.
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
const Price = require('../src/GameServer/Bot/Economy/PriceAnchor');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ItemTemplateIndex = invoke('GameServer/Item/ItemTemplateIndex');
const HOUR_MS = 3600000;

const warsmith = (extra = {}) => ({ characterId: 996001, accountName: 'bot_996001', name: 'Smith', level: 50, phase: 'cold',
    activity: 'shopping', currentRegion: 'Giran', adena: 500000000, inventory: {},
    stats: { classId: 57, generatedCold: true }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, ...extra });
const fighter = { level: 50, stats: { classId: 1 } };

// 1. A reserve C weapon: the crafter row stocks a Warsmith on consignment, not a
// fighter, at 0.6 x the anchor; no row sells it to anyone else (the valve rows are
// gone), the Warsmith never buys it there for itself, and the crafter's ask ceiling is
// the anchor.
const Anchor = invoke('GameServer/Bot/Economy/PriceAnchor');
const offers = Stock.townOffers(warsmith());
const weapon = offers.find(offer => offer.grade === 'c' && offer.group.startsWith('Weapon.') && offer.recipeLevel > 0);
assert(weapon, 'Giran sells a Warsmith a C weapon it can craft');
const rows = Fixed.offers(weapon.selfId);
const crafterRow = rows.find(row => Array.isArray(row.buyerClasses));
assert(crafterRow, 'each reserve piece has a crafter row');
assert(rows.every(row => row.buyerClasses || row.buyerRole), 'no open (valve) row sells a reserve piece');
assert(!Object.values(invoke('GameServer/Bot/MerchantStoreConfigs')).some(store => (store.items || []).some(line => 'valve' in line)),
    'no store line is a valve row');
assert.strictEqual(Production.allowsFixed(crafterRow, warsmith(), { consignment: true }), true, 'a Warsmith restocks at the crafter row');
assert.strictEqual(Production.allowsFixed(crafterRow, warsmith()), false, 'a Warsmith buys nothing for itself at the crafter row');
assert.strictEqual(Fixed.offers(weapon.selfId, warsmith()).length, 0, 'a Warsmith buys its own C weapon at no store');
assert.strictEqual(Production.allowsFixed(crafterRow, fighter), false, 'a fighter is refused the crafter row');
assert.strictEqual(Fixed.offers(weapon.selfId, fighter).length, 0, 'a fighter buys no reserve piece at a store');
assert(Math.abs(crafterRow.price - 0.6 * Anchor.anchor(weapon.selfId)) <= 1, `crafter cost ${crafterRow.price} = 0.6 x anchor`);
assert.strictEqual(weapon.ceiling, Anchor.anchor(weapon.selfId), 'the crafter ask ceiling is the anchor');

// 1b. A station trader in Giran (a B/A hub) stocks a B weapon from its trader row with
// no level gate and lists it at an ask within [0.6, 1.0] x the anchor; a crafter and a
// fighter cannot buy the trader row.
const trader = (extra = {}) => warsmith({ characterId: 996101, name: 'Trader', level: 20,
    stats: { classId: 53, generatedCold: true, stationTrader: { slot: 0, town: 'Giran' } }, ...extra });
const traderOffers = Stock.townOffers(trader());
assert(traderOffers.length && traderOffers.every(offer => ['b', 'a'].includes(offer.grade) && offer.group !== 'Shot'),
    'a Giran trader is offered B and A gear only, no shots');
const traderRow = Fixed.offers(traderOffers[0].selfId).find(row => row.buyerRole === 'trader' && row.town === 'Giran');
assert(traderRow, 'a trader row in Giran');
assert.strictEqual(Production.allowsFixed(traderRow, trader(), { consignment: true }), true, 'a station trader restocks at the trader row');
assert.strictEqual(Production.allowsFixed(traderRow, warsmith(), { consignment: true }), false, 'a crafter is refused the trader row');
assert.strictEqual(Production.allowsFixed(traderRow, fighter), false, 'a fighter is refused the trader row');
const traderPlan = Stock.restock(trader(), { offers: traderOffers, now: 10 * HOUR_MS });
const bWeapon = traderPlan.rows.find(row => {
    const offer = traderOffers.find(entry => entry.selfId === row.selfId);
    return offer.grade === 'b' && offer.group.startsWith('Weapon.');
});
assert(bWeapon, 'a level-20 station trader stocks a B weapon (no level gate)');
assert.strictEqual(traderPlan.rows.filter(row => row.grade === 'b').length, 3, 'half the crafter pace: three B pieces an hour');
const traderStock = trader({ inventory: { [bWeapon.selfId]: { selfId: bWeapon.selfId, amount: 1 } },
    stats: { ...trader().stats, gnomeStock: { [bWeapon.selfId]: { cost: bWeapon.unit, ceiling: bWeapon.ceiling, owed: 1 } } } });
const traderAsk = invoke('GameServer/Bot/Economy/ItemDisposition').gnomeAsk(traderStock, bWeapon.selfId, Number.MAX_SAFE_INTEGER);
const bAnchor = Anchor.anchor(bWeapon.selfId);
assert(traderAsk >= bAnchor * 0.6 - 1 && traderAsk <= bAnchor, `trader ask ${traderAsk} within [cost, anchor ${bAnchor}]`);
assert.deepStrictEqual(Stock.materialBids(trader()), [], 'a station trader posts no material bids');

// 2. A level-50 Warsmith with money and no town demand keeps one display piece of each
// weapon type it crafts (its top recipe level), never a piece above its craft level.
const craftLevel = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(warsmith());
assert.strictEqual(craftLevel, 6, 'a level-50 Warsmith has Create Item 6');
const t0 = 10 * HOUR_MS;
const shotIds = new Set(offers.filter(offer => offer.group === 'Shot').map(offer => offer.selfId));
const gear = plan => plan.rows.filter(row => !shotIds.has(row.selfId));
const first = { ...Stock.restock(warsmith(), { offers, now: t0 }) };
first.rows = gear(first);
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
assert.strictEqual(gear(slow).length, 0, 'x1: no gear in the first hour');
const later = Stock.restock(warsmith({ stats: { classId: 57, generatedCold: true, gnomeAllowance: slow.allowance } }), { offers, now: t0 + 9 * HOUR_MS });
assert.strictEqual(gear(later).filter(row => gradeOf(row) === 'b').length, 1, 'x1: one B piece after nine hours');
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
assert(gear(again).every(row => !held.has(row.selfId)), 'a held display piece is not restocked');

// 3. The allowance: six pieces a grade a game hour, refilled at the read, two hours held.
const demanded = Stock.restock(warsmith(), { offers, now: t0, demandFor: id => id === weapon.selfId ? 20 : 0 });
assert.deepStrictEqual(gear(demanded).filter(row => gradeOf(row) === 'c').map(row => [row.selfId, row.amount]), [[weapon.selfId, 6]],
    'town demand first, six a grade an hour');
const spent = warsmith({ stats: { classId: 57, gnomeAllowance: demanded.allowance } });
assert.strictEqual(gear(Stock.restock(spent, { offers, now: t0, demandFor: () => 20 })).length, 0, 'the seventh piece in the hour is refused');
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

// 3b. Two crafters of one town share its demand: the town wants 2 of a C weapon X and
// nothing else. The first lists X x2 and displays other types; the second, reading the
// board (Stock.townSupply: other sellers' lines in its town), lists no X and displays
// only types the first does not; had the first listed one X, the second lists the
// unmet one.
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const twoX = id => id === weapon.selfId ? 2 : 0;
const firstSmith = warsmith(), secondSmith = warsmith({ characterId: 996002, accountName: 'bot_996002', name: 'Smith2' });
const firstPlan = Stock.restock(firstSmith, { offers, now: t0, demandFor: twoX,
    ...Stock.townSupply(new BoardIndex(), 'Giran', firstSmith.characterId) });
const firstGear = gear(firstPlan);
assert.deepStrictEqual(firstGear.filter(row => row.selfId === weapon.selfId).map(row => row.amount), [2], 'the first crafter lists the 2 X wanted');
const shopOf = (ownerId, rows) => {
    const board = new BoardIndex();
    board.put({ id: 1, ownerId, storeType: 1, town: 'Giran', botOwned: true,
        lines: rows.map((row, at) => ({ lineId: at + 1, selfId: row.selfId, count: row.amount, price: row.ceiling })) });
    return board;
};
const groupOf = row => offers.find(offer => offer.selfId === row.selfId).group;
const secondPlan = gear(Stock.restock(secondSmith, { offers, now: t0, demandFor: twoX,
    ...Stock.townSupply(shopOf(firstSmith.characterId, firstGear), 'Giran', secondSmith.characterId) }));
assert(!secondPlan.some(row => row.selfId === weapon.selfId), 'the first covered the demand: the second lists no X');
const firstGroups = new Set(firstGear.map(groupOf));
assert(secondPlan.length > 0 && secondPlan.every(row => !firstGroups.has(groupOf(row))),
    `the second displays only types the first does not (${secondPlan.map(groupOf)})`);
const unmet = gear(Stock.restock(secondSmith, { offers, now: t0, demandFor: twoX,
    ...Stock.townSupply(shopOf(firstSmith.characterId, [{ ...firstGear[0], amount: 1 }]), 'Giran', secondSmith.characterId) }));
assert.deepStrictEqual(unmet.filter(row => row.selfId === weapon.selfId).map(row => row.amount), [1], 'the second lists the unmet one X');
assert.deepStrictEqual(gear(Stock.restock(firstSmith, { offers, now: t0, demandFor: twoX,
    ...Stock.townSupply(shopOf(firstSmith.characterId, firstGear), 'Giran', firstSmith.characterId) })).filter(row => row.selfId === weapon.selfId)
    .map(row => row.amount), [2], 'its own lines are no other seller\'s: they count as held, not as listed');

// 4. Its stock is listed on the board between its cost and its ceiling, never sent to an NPC.
const template = ItemTemplateIndex.find(DataCache.items, weapon.selfId);
const stocked = warsmith({ inventory: { [weapon.selfId]: { selfId: weapon.selfId, name: template.template.name, amount: 1,
    kind: template.template.kind, rank: template.etc.rank } },
stats: { classId: 57, generatedCold: true, gnomeStock: { [weapon.selfId]: { cost: weapon.price, ceiling: weapon.ceiling } } } });
const market = ListingPolicy.evaluate(stocked, { now: t0, decisionPoint: 'stock' });
const decision = market.decisions.find(entry => Number(entry.item?.selfId) === weapon.selfId);
assert(decision && decision.action === 'list', `the stock piece is listed (${decision?.action}/${decision?.reason})`);
const listing = market.listings.find(entry => Number(entry.selfId) === weapon.selfId);
assert(listing.price >= weapon.price && listing.price <= weapon.ceiling,
    `ask ${listing.price} within [cost ${weapon.price}, ceiling ${weapon.ceiling}]`);
assert(!market.npc.some(entry => Number(entry.selfId) === weapon.selfId), 'never sold to an NPC');

// 5. Shots: a crafter in Giran stocks each graded shot its Create Item level crafts at
// 0.6 x the shot's anchor (PriceAnchor.shotAnchor: no static shot row sells to a bot), each topped
// up to its lot whatever its town's demand, never a grade above its craft level, at any drop rate.
const D_SS = 1463, C_SS = 1464, B_SS = 1465, D_BSPS = 3948;
const shotRows = plan => new Map(plan.rows.filter(row => shotIds.has(row.selfId)).map(row => [row.selfId, row]));
const journeyman = warsmith({ level: 40 });
assert.strictEqual(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(journeyman), 4, 'a level-40 Warsmith has Create Item 4');
const stockedShots = shotRows(Stock.restock(journeyman, { offers, now: t0, demandFor: id => id === D_SS ? 500 : 0 }));
assert.deepStrictEqual([...stockedShots.keys()].sort((a, b) => a - b), [1463, 1464, 2510, 2511, 3948, 3949],
    'Create Item 4: the D and C soulshots, spiritshots and blessed spiritshots, no B');
assert(!stockedShots.has(B_SS), 'a B shot is not stocked below its recipe level');
assert.strictEqual(stockedShots.get(D_SS).amount, Stock.SHOT_STOCK_UNITS, 'a town demand of 500: the whole lot');
assert.strictEqual(stockedShots.get(C_SS).amount, Stock.SHOT_STOCK_UNITS, 'no demand: the whole lot');
assert.strictEqual(shotRows(Stock.restock(journeyman, { offers, now: t0, demandFor: id => id === D_SS ? 1000000 : 0 })).get(D_SS).amount,
    Stock.SHOT_STOCK_UNITS, 'a store town\'s whole demand is not one crafter\'s lot');
// x50: a D hunter's hour pays far more than an hour of D shots at datapack, so the anchor
// is above the datapack price and keeps the datapack ratio between the grade's shots.
const dAnchor = Price.shotAnchor(D_SS), dUnit = Math.floor(0.6 * dAnchor);
assert(dAnchor > 5 * 10, `x50: a D soulshot's anchor ${dAnchor} is several times its datapack 10`);
assert(Math.abs(Price.shotAnchor(D_BSPS) - 4.5 * dAnchor) <= 3, 'a D blessed spiritshot keeps 45/10 of the soulshot\'s anchor');
assert.deepStrictEqual([stockedShots.get(D_SS).unit, stockedShots.get(D_SS).ceiling], [dUnit, dAnchor],
    'a D soulshot costs the suppliers\' one cost, 0.6 x its anchor, and asks the anchor');
assert.strictEqual(stockedShots.get(D_BSPS).unit, Math.floor(0.6 * Price.shotAnchor(D_BSPS)), 'a D blessed spiritshot at 0.6 x its anchor');
assert.strictEqual(invoke('GameServer/Bot/Economy/StaticMerchantPricing').cheapestPurchase(D_SS, { forBot: true }), dAnchor,
    'a bot\'s D soulshot price is the crafters\' ask ceiling');
assert(!Fixed.offers(D_SS).length && !Fixed.offers(1835).length, 'no static shot row sells to a bot');
assert(shotRows(Stock.restock(warsmith(), { offers, now: t0 })).has(B_SS), 'Create Item 6 stocks the B shots');
// Held units count against the target.
assert.strictEqual(shotRows(Stock.restock(journeyman, { offers, now: t0, heldFor: id => id === C_SS ? 1500 : 0 })).get(C_SS).amount,
    Stock.SHOT_STOCK_UNITS - 1500, 'a crafter holding 1500 C soulshots tops up to its lot');
// Other sellers' shots in its town do not shrink its lot: the shots do not run out.
const otherShots = new BoardIndex();
otherShots.put({ id: 2, ownerId: 996003, storeType: 1, town: 'Giran', botOwned: true, lines: [{ lineId: 1, selfId: D_SS, count: 1500, price: 600 }] });
assert.strictEqual(shotRows(Stock.restock(journeyman, { offers, now: t0, demandFor: id => id === D_SS ? 500 : 0,
    ...Stock.townSupply(otherShots, 'Giran', journeyman.characterId) })).get(D_SS).amount, Stock.SHOT_STOCK_UNITS,
'another seller\'s 1500 D soulshots in its town: the whole lot still');
// Neither the gear allowance nor the drop rate paces shots.
process.env.L2NODE_PROGRESSION_RATE = 'x1';
invoke('GameServer/ProgressionRates').reset();
assert.strictEqual(shotRows(Stock.restock(journeyman, { offers, now: t0 })).get(D_SS).amount, Stock.SHOT_STOCK_UNITS, 'x1: the same shot units');
// At x1 an hour's income is about a fiftieth: SHOT_SHARE of it buys less than an hour of
// shots at datapack, so a shot's anchor falls to its datapack price, and the ceiling with it.
assert.strictEqual(Price.shotAnchor(D_SS), 10, 'x1: a D soulshot\'s anchor is its datapack price');
assert.strictEqual(Stock.shotCeiling(D_SS), 10, 'x1: the crafters ask at most 10');
// The owed limit is OWED_MONEY at x1: 1000 adena below it buys 166 D soulshots at their cost 6 (0.6 x the anchor 10).
const nearMoneyX1 = warsmith({ level: 40, stats: { classId: 57, gnomeStock: { 1: { cost: Stock.OWED_MONEY - 1000, ceiling: 1, owed: 1 } } } });
assert.deepStrictEqual([...shotRows(Stock.restock(nearMoneyX1, { offers: Stock.townOffers(nearMoneyX1), now: t0 })).values()].map(row => [row.selfId, row.amount]),
    [[D_SS, 166]], 'x1: 1000 adena below the owed money, 166 D soulshots, then nothing');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
invoke('GameServer/ProgressionRates').reset();
// Owed: shot units are not gear pieces; the owed adena bounds them.
const owesGear = warsmith({ level: 40, stats: { classId: 57, gnomeStock: { 1: { cost: 1, ceiling: 2, owed: Stock.OWED_PIECES } } } });
const owedPlan = Stock.restock(owesGear, { offers, now: t0 });
assert(shotRows(owedPlan).size === 6 && gear(owedPlan).length === 0, 'at the gear owed limit it still stocks shots, no gear');
const owesShots = warsmith({ stats: { classId: 57, gnomeStock: { [D_SS]: { cost: 10, ceiling: 15, owed: 100000 } } } });
assert.strictEqual(Stock.owed(owesShots).pieces, 0, '100000 owed shots are no gear piece');
assert(gear(Stock.restock(owesShots, { offers, now: t0 })).length > 0, 'owed shots leave the gear restock open');
// At x50 the owed limit is OWED_MONEY too.
// Its gear owed pieces are at their limit (a gear piece at 0.6 x the anchor would fit the 7000).
const nearMoney = warsmith({ level: 40, stats: { classId: 57, gnomeStock: { 1: { cost: Stock.OWED_MONEY - 7000, ceiling: 1, owed: 1 },
    2: { cost: 0, ceiling: 1, owed: Stock.OWED_PIECES - 1 } } } });
// Each row the owed money cuts is counted (developer diagnostics).
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
const moneyCuts = () => Diagnostics.metrics().counts?.['crafter_stock:owed_limit:money'] || 0;
const cutsBefore = moneyCuts();
const nearMoneyRows = [...shotRows(Stock.restock(nearMoney, { offers, now: t0 })).values()];
assert.deepStrictEqual(nearMoneyRows.map(row => [row.selfId, row.amount]), [[D_SS, Math.floor(7000 / dUnit)]],
    `7000 adena below the x50 owed money: the D soulshots it buys at their cost ${dUnit}, then nothing`);
assert(moneyCuts() - cutsBefore >= 6, 'each row the owed money cuts is counted (the six shot rows among them)');
const freeBefore = moneyCuts();
Stock.restock(warsmith({ level: 40 }), { offers, now: t0 });
assert.strictEqual(moneyCuts() - freeBefore, 0, 'a crafter that owes nothing has no row cut by the owed money');

// The bots' funded purchase plans in its town are demand too (PlanDemand, read by the
// crafter restock only): three bots planning to buy a C weapon in Giran with half its
// price saved make the Warsmith stock three; an unfunded plan or one for another town
// counts nothing, and a plan dropped leaves the count.
{
    const PlanDemand = invoke('GameServer/Bot/Economy/PlanDemand');
    const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
    const smith = warsmith({ characterId: 996101 });
    const craftLevel = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(smith);
    const target = Stock.townOffers(smith).find(offer => offer.grade === 'c' && offer.group.startsWith('Weapon.')
        && offer.recipeLevel > 0 && offer.recipeLevel <= craftLevel);
    assert(target, 'Giran\'s reserve sells a C weapon the Warsmith reaches');
    const planner = (characterId, adena, town = 'Giran') => ({ characterId, adena, stats: { equipmentPlan: { status: 'active', strategy: 'market',
        target: { selfId: target.selfId }, market: { town, price: 2000000 } } } });
    const at = Date.now();
    const forecast = () => Demand.forecast(target.selfId, 'Giran', { board: null, timestamp: at, plans: PlanDemand.units });
    assert.strictEqual(forecast(), null, 'no trade, no bid and no plan: no demand');
    for (const id of [996201, 996202, 996203]) PlanDemand.observe({ characterId: id, state: planner(id, 1000000), kind: 'put' });
    PlanDemand.observe({ characterId: 996204, state: planner(996204, 999999), kind: 'put' });
    PlanDemand.observe({ characterId: 996205, state: planner(996205, 5000000, 'Dion'), kind: 'put' });
    assert.strictEqual(forecast()?.applicableUnits, 3, 'the forecast counts the three funded plans in Giran');
    assert.strictEqual(Demand.forecast(target.selfId, 'Giran', { board: null, timestamp: at }), null,
        'a reader that passes no plans sees the public market alone');
    const restocked = plans => Stock.restock(smith, { offers: Stock.townOffers(smith), now: at,
        demandFor: id => Demand.forecast(id, 'Giran', { board: null, timestamp: at, plans })?.applicableUnits || 0 })
        .rows.find(row => row.selfId === target.selfId)?.amount || 0;
    assert.strictEqual(restocked(PlanDemand.units), 3, 'the Warsmith stocks the three planned weapons');
    assert(restocked(null) <= 1, 'without the plans it stocks at most a display piece');
    PlanDemand.observe({ characterId: 996201, state: { ...planner(996201, 1000000), stats: {} }, kind: 'put' });
    assert.strictEqual(forecast()?.applicableUnits, 2, 'a dropped plan leaves the count');
    PlanDemand.reset();
}
// Boot computes every anchor (PriceAnchor.warmup, main and each cold worker): the first
// anchor read after it reads no spot table row.
{
    const Table = invoke('GameServer/Bot/AI/SpotValueTable'), best = Table.best;
    Price.warmup();
    const expected = [Price.anchor(71), Price.anchor(6364), Price.shotAnchor(1467)];
    try {
        Table.best = () => { throw new Error('a spot table read after the boot warm-up'); };
        assert.deepStrictEqual([Price.anchor(71), Price.anchor(6364), Price.shotAnchor(1467)], expected,
            'after the warm-up every anchor is a cache hit');
    } finally { Table.best = best; }
}
console.log('crafter stock: ok');
process.exit(0);
