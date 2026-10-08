const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('economy-thresholds');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Karma = invoke('GameServer/Karma');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const WealthCraft = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const { captureAndRead } = require('./helpers/nativeEconomyPolicyAssertions');
const NOW = 1791343645000;

// ARCH-NOTE: FX-E1 removed the level/percentage floor. Sum the native hourly
// stock deficits and escape cost independently; no wish network is built here.
function reserveInputs(state) {
    const base = Economy.basics(state, { timestamp: NOW });
    const stocks = ['shots', 'potions'].map(kind => {
        const stock = base.stock(kind);
        return { selfId: stock.itemId, perHour: stock.usePerHour,
            held: Number(state.inventory?.[stock.itemId]?.amount || 0), unitPrice: base.price(stock.itemId) };
    });
    const escape = { held: Number(state.inventory?.[736]?.amount || 0), unitPrice: base.price(736),
        usable: !Karma.closesTowns(state.stats?.karma) };
    const expected = stocks.reduce((sum, row) => sum + Math.max(0, row.perHour - row.held) * row.unitPrice, 0)
        + (escape.usable ? Math.max(0, 1 - escape.held) * escape.unitPrice : 0);
    assert.strictEqual(base.survivalReserve, expected, 'native E1 reserve is the explicit hourly kit plus escape deficit');
    assert.strictEqual(Gear.operationalAdenaReserve(state), expected, 'gear reads the same E1 reserve');
    console.log(JSON.stringify({ reserveInputs: { level: state.level, wallet: Funding.budget(state), stocks, escape }, expected }));
    return { expected, stocks, escape };
}

(async () => {
try {
Data.init();
// ARCH-NOTE: supply the native main market spot catalogue before its first
// price read, matching AfkTrade.init and the worker catalogue input.
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
MarketCounters.useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure() || []);
const reserveStates = [{ level: 1, adena: 0 }, { level: 10, adena: 0 }, { level: 10, adena: 100000 },
    { level: 10, inventory: { 57: { amount: 100001 } } }];
for (const state of reserveStates) reserveInputs(state);
assert.strictEqual(Funding.budget(reserveStates[3]), 100001, 'adena carried only in the inventory counts too');

const weapon = Data.items.find(row => row.etc?.rank === 'd' && Number(row.etc?.slot) === 7 && Number(row.etc?.soulshot) > 0);
assert(weapon, 'authored D weapon with a nonzero soulshot charge');
const kitState = { characterId: 9104, name: 'ReserveInputs', phase: 'cold', activity: 'hunting',
    level: 30, exp: Number(Data.experience[29]), adena: 100000, updatedAt: NOW, currentRegion: 'Giran',
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
    vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
    inventory: { [weapon.selfId]: { selfId: weapon.selfId, amount: 1, equipped: true, equippedCount: 1, slot: 7, enchant: 0 } },
    stats: { classId: 1, classProgressionClassId: 1, classProgressionLevel: 30 } };
const emptyKit = reserveInputs(kitState);
assert(emptyKit.stocks.some(row => row.perHour > 0), 'the native table must exercise an actual consumable deficit');
const partialKit = { ...kitState, inventory: { ...kitState.inventory, 736: { selfId: 736, amount: 1 },
    ...Object.fromEntries(emptyKit.stocks.map((row, index) => [row.selfId, { selfId: row.selfId, amount: index ? 1 : 3 }])) } };
assert.strictEqual(reserveInputs(partialKit).escape.held, 1, 'one held escape scroll removes its deficit');
const coveredKit = { ...kitState, inventory: { ...kitState.inventory, 736: { selfId: 736, amount: 1 },
    ...Object.fromEntries(emptyKit.stocks.map(row => [row.selfId, { selfId: row.selfId, amount: Math.ceil(row.perHour) }])) } };
assert.strictEqual(reserveInputs(coveredKit).expected, 0, 'a full native hourly kit needs no second reserve');
assert.strictEqual(reserveInputs({ ...kitState, stats: { ...kitState.stats, karma: 1 } }).escape.usable, false,
    'closed towns do not reserve an unusable escape purchase');

// ARCH-NOTE: C1 cold readers defer on a missing decision. Actual worker
// capture/accept checks the selected native activity; it need not be selling.
const reserveCapture = await captureAndRead(kitState, { timestamp: NOW });
// Main and worker have separate counter/catalogue snapshots. Derive the
// packet oracle from the actual worker's price/use inputs, never its saved R.
const nativeReserve = reserveCapture.captured.reserveInputs;
assert(nativeReserve && nativeReserve.stocks.length === 2);
const workerReserve = nativeReserve.stocks.reduce((sum, row) =>
    sum + Math.max(0, row.perHour - row.held) * row.unitPrice, 0)
    + (nativeReserve.escape.usable ? Math.max(0, 1 - nativeReserve.escape.held) * nativeReserve.escape.unitPrice : 0);
assert.strictEqual(reserveCapture.state.stats.money[2], Math.round(workerReserve), 'the genuine packet stores E1 derived from its native worker inputs');
console.log(JSON.stringify({ mainReserve: emptyKit.expected, nativeReserveInputs: nativeReserve, expectedWorkerReserve: workerReserve }));
assert.strictEqual(Gear.operationalAdenaReserve(reserveCapture.state), reserveCapture.captured.statsPacket.money[2],
    'a reader uses the genuine saved worker reserve');
const material = Data.items.find(row => Number(row.selfId) === 1864);
assert(material, 'the declared sale stock has an authored C4 item');
await captureAndRead({ characterId: 9101, level: 20, exp: Number(Data.experience[19]), adena: 100000,
    name: 'NativeSaleInput', phase: 'cold', activity: 'hunting', updatedAt: NOW,
    currentRegion: 'Giran', loc: kitState.loc, timing: {},
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    inventory: { 1864: { selfId: 1864, name: material.template.name, amount: 3, stackable: !!material.etc.stackable } },
    stats: { classId: 0, classProgressionClassId: 0, classProgressionLevel: 20 } }, { timestamp: NOW });

// The reference price is the lower of the rate-scaled base price and the
// NPC price. No listing floor (group E): a WTB bid is the mirror of the
// bot's ask, at or under what the item is worth to it.
const BOW = 274;
const item = { selfId: BOW, basePrice: 1000000 };
const scaledBase = BotEconomyPricing.scalePrice(item.basePrice);
BotMarketPricing.useNpcOfferSnapshot([{ selfId: BOW, price: Math.floor(scaledBase / 2) }]);
assert.strictEqual(BotMarketPricing.referencePrice(item), Math.floor(scaledBase / 2), 'a cheaper NPC price is the reference');
BotMarketPricing.useNpcOfferSnapshot([]);
assert.strictEqual(BotMarketPricing.referencePrice(item), scaledBase, 'without NPC stock the scaled base price is the reference');
assert.strictEqual(BotMarketPricing.listingFloor, undefined, 'no listing floor');
const bid = (adena) => BuyStore.bidFor({ characterId: 9102, adena: 1000000000, inventory: {} },
    { type: 'upgrade_gear', target: { itemId: BOW, adena }, plan: { priceSource: 'offer' } });
const low = bid(1000);
assert(!low || low.price <= 1000, 'a bid stays at or under what the item is worth to the buyer');
// FX-E1: a requested amount does not create usefulness. Preserve the
// original bare buyer and Bow274. Its native grade excludes this Bow from
// both the wish values and demands, so even the high requested price has
// no profitable bid. N79 covers a positive native own-worth bid separately.
const originalBidBuyer = { characterId: 9102, adena: 1000000000, inventory: {} };
const originalBidContext = invoke('GameServer/Bot/Economy/MarketListingPolicy').traderContext(originalBidBuyer, { timestamp: NOW });
const bowTemplate = Data.items.find(row => Number(row.selfId) === BOW);
assert(bowTemplate);
assert.strictEqual(Gear.suitable(bowTemplate, originalBidBuyer, Gear.roleFor(originalBidBuyer), Gear.gradeForLevel(originalBidBuyer.level)), false,
    'the unchanged bare buyer has no native suitable Bow274');
assert.strictEqual(originalBidContext.economy.projection.values.get(BOW) || 0, 0);
assert.strictEqual(originalBidContext.economy.network.demands.get(`item:${BOW}`) || 0, 0);
assert.strictEqual(originalBidContext.economy.worth(BOW), 0, 'no native usefulness means zero own worth at a positive money price');
assert.strictEqual(bid(scaledBase), null, 'a caller\'s reference amount cannot create a profitable bid for an unsuitable item');

// A wealth crafter does not craft while it holds its own WTB.
const crafter = { characterId: 9103, accountName: 'bot_pop_test', name: 'Crafter', phase: 'cold',
    activity: 'hunting', level: 60, adena: 500000, vitals: { mp: 100 }, inventory: {},
    stats: { classId: 57, generatedIndex: 1787947094937 }, persona: { primaryDrive: 'wealth' } };
assert.strictEqual(WealthCraft.eligible(crafter), true);
const ownerRecords = AfkTrade.ownerRecords;
try {
    AfkTrade.ownerRecords = (id) => Number(id) === 9103
        ? [{ kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: 1000, lines: [] }] : [];
    assert.strictEqual(WealthCraft.eligible(crafter), false, 'its own buy ad comes first');
} finally {
    AfkTrade.ownerRecords = ownerRecords;
}

console.log('test_bot_economy_thresholds passed');
} finally {
    Economy.reset();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
