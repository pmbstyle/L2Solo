const assert = require('assert');

require('../src/Global');

// Personal ammunition must survive a smaller restock forecast: otherwise
// a bot buys at retail, sells below retail and buys the same stock again.
// An older weapon grade stays spare; native crafters can sell production.
const DataCache = invoke('GameServer/DataCache');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ColdShotEconomyService = invoke('GameServer/Bot/Economy/ColdShotEconomyService');

DataCache.init();

const D_SWORD = 126; // Artisan's Sword, D grade
const D_SOULSHOT = 1463;
const NG_SOULSHOT = 1835;
const WARRIOR = 1;

function stateWith(ownShots, extra = {}) {
    return {
        characterId: 9600001, name: 'ShotKeeper', level: 40, adena: 10000000,
        phase: 'cold', activity: 'shopping',
        stats: { classId: WARRIOR, ...(extra.stats || {}) },
        inventory: {
            57: { selfId: 57, amount: 10000000 },
            [D_SWORD]: { selfId: D_SWORD, amount: 1, equipped: true, equippedCount: 1, slot: 7, stackable: false },
            [D_SOULSHOT]: { selfId: D_SOULSHOT, amount: ownShots, stackable: true },
            [NG_SOULSHOT]: { selfId: NG_SOULSHOT, amount: 2000, stackable: true }
        }
    };
}

const counts = (lines) => new Map(lines.map((line) => [Number(line.selfId), Number(line.count)]));

// ARCH-NOTE: E5/E9 replaces 3000 with ceil(native use/h * bag-fill hours).
// The absent own stack must reserve its future slot, so the real refill
// cannot reduce its own target and immediately sell shots back to the NPC.
const target = ShotStock.keptAmounts(stateWith(0))[D_SOULSHOT];
assert(target > 0);
const full = stateWith(target);
assert.strictEqual(ShotStock.keptAmounts(full)[D_SOULSHOT], target,
    'empty and physically filled own stack use the same planned bag interval');
assert.strictEqual(ShotStock.planForState(full).selfId, D_SOULSHOT, 'a warrior with a D sword fires D soulshots');

// Cold: the sale set (listings) and the NPC cleanup set (forced inventory
// cleanup, a closed store) keep the restocked own shot and sell the old grade.
const sale = counts(ItemDisposition.saleCandidates(full, { unlimited: true }));
assert.strictEqual(sale.get(D_SOULSHOT), undefined, 'a freshly restocked own shot is not for sale');
assert.strictEqual(sale.get(NG_SOULSHOT), 2000, 'shots of an older grade are spare');
const npc = counts(ItemDisposition.npcLiquidationCandidates(full));
assert.strictEqual(npc.get(D_SOULSHOT), undefined, 'inventory cleanup does not sell the own shot to the NPC');
assert.strictEqual(npc.get(NG_SOULSHOT), 2000, 'inventory cleanup sells the old-grade shots to the NPC');

assert.strictEqual(counts(ItemDisposition.saleCandidates(stateWith(target + 500), { unlimited: true })).get(D_SOULSHOT), undefined,
    'an ordinary bot keeps all current ammunition above the restock target');
assert.strictEqual(counts(ItemDisposition.npcLiquidationCandidates(stateWith(target + 500))).get(D_SOULSHOT), undefined,
    'a smaller restock target cannot sell current ammunition to the NPC');

// Round trip: a native restock from an empty stack leaves no own shot to sell.
const low = stateWith(0);
const restock = ShotStock.restockPlan(low, { unitPrice: 10, potionUnitPrice: 0, offers: [] });
assert.strictEqual(restock.amount, target, 'the restock fills the own shot to its target');
const restocked = stateWith(restock.amount);
assert.strictEqual(counts(ItemDisposition.saleCandidates(restocked, { unlimited: true })).get(D_SOULSHOT), undefined,
    'what the restock bought is not sold back');

// Hot: a bot in the world is judged on its live bag by the same sale set.
const items = Object.values(full.inventory).map((item) => ({ ...item }));
const session = {
    actor: {
        fetchId: () => full.characterId,
        fetchLevel: () => full.level,
        fetchClassId: () => WARRIOR,
        backpack: { fetchItems: () => items }
    },
    coldLifeState: { ...full, phase: 'hot' }
};
const hotSale = counts(ItemDisposition.saleCandidates(MarketListingPolicy.actorState(session), { unlimited: true }));
assert.strictEqual(hotSale.get(D_SOULSHOT), undefined, 'a hot bot does not offer its restocked own shot either');
assert.strictEqual(hotSale.get(NG_SOULSHOT), 2000, 'a hot bot offers its old-grade shots');

// A shot crafter's surplus of its own shot starts above the same target.
// T43 table: below 44 this crafter's D shots have no purchase target (they do not pay); at 50 they do.
const crafter = (amount) => ({ ...stateWith(amount, { stats: { classId: 57, shotCraft: { productId: D_SOULSHOT } } }), level: 50 });
const crafterWithout = (state) => {
    const inventory = { ...state.inventory };
    delete inventory[NG_SOULSHOT];
    return { ...state, inventory };
};
// Removing an old-grade stack increases native bag room; derive this
// crafter's target from the same inventory used by the surplus decision.
const crafterTarget = ShotStock.keptAmounts(crafterWithout(crafter(0)))[D_SOULSHOT];
assert.strictEqual(ColdShotEconomyService.hasShotSurplus(crafterWithout(crafter(crafterTarget))), false,
    'a crafter holding its own shot up to the restock target has no surplus');
assert.strictEqual(ColdShotEconomyService.hasShotSurplus(crafterWithout(crafter(crafterTarget + 1))), true,
    'a crafter holding more than the restock target has a surplus');
assert.strictEqual(counts(ItemDisposition.saleCandidates(crafter(crafterTarget + 500), { unlimited: true })).get(D_SOULSHOT) > 0, true,
    'a native crafter can still offer its current-grade production surplus');

// oONetManaOo: Orc Shaman, Scalpel, D soulshots bought at 500 A. A changed
// hunting hour must not make them available for a cheaper WTB or NPC sale.
const orc = stateWith(350, { stats: { classId: 50 } });
orc.name = 'oONetManaOo'; orc.level = 27;
delete orc.inventory[D_SWORD];
orc.inventory[167] = { selfId: 167, amount: 1, equipped: true, slot: 7 };
assert.strictEqual(ShotStock.planForState(orc).selfId, D_SOULSHOT);
assert.strictEqual(ShotStock.isPersonalShot(orc, D_SOULSHOT), true);
for (const reducedTarget of [80, 1, 0]) {
    const economy = { stock: () => ({ itemId: D_SOULSHOT, target: reducedTarget }) };
    const keptAmounts = ShotStock.keptAmounts(orc, economy);
    assert.strictEqual(keptAmounts[D_SOULSHOT], 350);
    assert.strictEqual(counts(ItemDisposition.saleCandidates(orc, { keptAmounts, unlimited: true })).get(D_SOULSHOT), undefined,
        `a reserve recalculated to ${reducedTarget} does not sell purchased D shots`);
}
assert.strictEqual(ShotStock.isPersonalShot({ ...orc, stats: { ...orc.stats, shotCraft: { productId: D_SOULSHOT } } }, D_SOULSHOT), true,
    'a saved production marker cannot turn an Orc into a native crafter');
assert.strictEqual(ShotStock.isPersonalShot(orc, 2510), false, 'an unused shot kind remains spare');
const caster = stateWith(350, { stats: { classId: 11 } });
caster.inventory[2510] = { selfId: 2510, amount: 350, stackable: true };
assert.strictEqual(ShotStock.isPersonalShot(caster, 2510), true, 'a caster retains its current spiritshots');
assert.strictEqual(counts(ItemDisposition.saleCandidates(caster, { unlimited: true })).get(2510), undefined);
assert.strictEqual(counts(ItemDisposition.saleCandidates(caster, { unlimited: true })).get(D_SOULSHOT), 350,
    'the unused physical shot kind stays available for sale');
assert.strictEqual(counts(ItemDisposition.saleCandidates(orc, { keptAmounts: {}, unlimited: true })).get(D_SOULSHOT), undefined,
    'a prepared warehouse or escrow projection cannot bypass personal ammunition protection');
const upgraded = structuredClone(orc);
delete upgraded.inventory[167];
upgraded.inventory[228] = { selfId: 228, amount: 1, equipped: true, slot: 7 }; // C-grade weapon
assert.strictEqual(ShotStock.planForState(upgraded).rank, 'c');
assert.strictEqual(counts(ItemDisposition.saleCandidates(upgraded, { unlimited: true })).get(D_SOULSHOT), 350,
    'changing to a C weapon releases the old D shots');

const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const board = new BoardIndex();
board.put({ id: 9600010, ownerId: 9600011, kind: 'buy_ad', storeType: 3, town: 'Dion', custodyPolicy: 1,
    lines: [{ lineId: 9600012, selfId: D_SOULSHOT, count: 350, price: 188 }] });
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
const economy = { hourAdena: 1000, moneyPrice: .001, network: {},
    persona: { traits: {}, understanding: .3 }, stock: kind => kind === 'shots'
        ? { itemId: D_SOULSHOT, target: 0 } : { itemId: 1060, target: 0 } };
const policy = MarketListingPolicy.evaluate(orc, { economy, board, tripCost: trip, npcOffersFor: () => [] });
for (const rows of [policy.listings, policy.npc, policy.answers]) {
    assert.strictEqual(rows.some(row => Number(row.selfId || row.item?.selfId) === D_SOULSHOT), false,
        'a cheap WTB cannot nominate the Orc\'s personal shots for sale');
}
for (const custodyPolicy of [0, 1]) {
    const legacyLine = { ownerId: orc.characterId, recordId: 9600020, lineId: 9600021, selfId: D_SOULSHOT,
        storeType: 1, custodyPolicy, count: 350, price: 188, revision: 1,
        pricing: { seenCounter: 0, seenAt: Date.now() } };
    // Backed stock lives in escrow, outside the personal bag.
    const owner = structuredClone(orc);
    if (custodyPolicy === 0) delete owner.inventory[D_SOULSHOT];
    const ctx = Pricing.traderContext(owner, { economy, board, tripCost: trip });
    assert.strictEqual(ctx.canSell(legacyLine), false);
    const seen = new (invoke('GameServer/Bot/Economy/BoardLook').SeenLines)();
    const withdrawals = [];
    for (let step = 0; step < 2; step++) withdrawals.push(...(Pricing.lookOwn(owner, [legacyLine], ctx, seen)?.withdrawals || []));
    assert(withdrawals.some(row => row.lineId === legacyLine.lineId),
        'natural review withdraws both backed and conditional legacy personal shots without a new fill');
}

console.log('test_bot_own_shot_reserve: ok');
process.exit(0);
