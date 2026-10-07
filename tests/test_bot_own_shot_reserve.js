const assert = require('assert');

require('../src/Global');

// E33: a bot keeps its own shot up to the amount its restock buys it to
// (the native stock target for its hunting hour). Inventory cleanup, the NPC sale and the
// listings must not sell what the restock has just bought, or the bot buys at
// the NPC price, sells back at the NPC buy-back and buys again. Shots of
// another grade (left over from an older weapon) stay spare and are sold.
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

// Above the restock target the own shot is spare too.
assert.strictEqual(counts(ItemDisposition.saleCandidates(stateWith(target + 500), { unlimited: true })).get(D_SOULSHOT), 500,
    'own shots above the restock target are spare');

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
const crafter = (amount) => stateWith(amount, { stats: { shotCraft: { productId: D_SOULSHOT } } });
const crafterWithout = (state) => ({ ...state, inventory: { ...state.inventory, [NG_SOULSHOT]: undefined } });
// Removing an old-grade stack increases native bag room; derive this
// crafter's target from the same inventory used by the surplus decision.
const crafterTarget = ShotStock.keptAmounts(crafterWithout(crafter(0)))[D_SOULSHOT];
assert.strictEqual(ColdShotEconomyService.hasShotSurplus(crafterWithout(crafter(crafterTarget))), false,
    'a crafter holding its own shot up to the restock target has no surplus');
assert.strictEqual(ColdShotEconomyService.hasShotSurplus(crafterWithout(crafter(crafterTarget + 1))), true,
    'a crafter holding more than the restock target has a surplus');

console.log('test_bot_own_shot_reserve: ok');
process.exit(0);
