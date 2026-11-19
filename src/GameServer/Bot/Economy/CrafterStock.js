'use strict';
// A crafter's gear stock for the board (our rule, standing for the dwarf craft and
// resale a C4 server runs on): an Artisan or Warsmith (classId 56/57) buys C/B/A
// pieces at a town visit from the reserve rows sold to its line only
// (MerchantStoreConfigs reserveGear, ProductionPolicy.allowsFixed) and lists them
// as ordinary bot sell lines (ItemDisposition.gnomeStock: never deposited, never
// sold to an NPC; ask between its cost and the open valve row's price).
// - Gating: only a piece whose recipe level its Create Item level reaches
//   (CraftEligibility.craftLevelFor; a piece without a recipe is never stocked).
// - Demand first: the pieces its town wants (MarketDemand.forecast: public buy lines
//   and recent trades), up to the units wanted; weapons before armour (a bot saves
//   for its weapon first), then the most wanted.
// - Display: each weapon type and armour slot with no wanted piece keeps one piece of
//   its top unlocked recipe level, so new demand finds a listing.
// - Pace: PIECES_PER_HOUR pieces a grade a game hour, refilled at the read, at most
//   STOCK_HOURS hours' worth held (stats.gnomeAllowance { grade: { pieces, at } }).
// - Consignment: the restock costs no adena; stats.gnomeStock[selfId] records
//   { cost, ceiling, owed } (consignPatch, written with the purchase) and the crafter
//   pays the store its cost for each owed unit it no longer holds at its next town
//   visit (settlement), as far as its adena reaches (the rest stays owed). Its wallet
//   no longer limits its range (run 6eb3afb37: no B/A weapon on the board, a B weapon
//   cost a crafter 5.2-7.9M against 4M wallets).
// - Owed limit (our choice): at most OWED_PIECES gear units and OWED_MONEY adena owed
//   per crafter (one crafter never holds an unbounded share of the store); a restock row
//   past it is cut (hit: a crafter at the limit stocks nothing until it pays).
// Shots (C4: dwarves craft soulshots and spiritshots and sell them in private stores;
// the consignment stands for that craft, our choice): the graded soulshots,
// spiritshots and blessed spiritshots whose recipe level its Create Item level reaches
// (no-grade shots: the NPC sells them), in every town (no store row needed there), on
// the same consignment at the cheapest store price a bot pays
// (StaticMerchantPricing.cheapestPurchase), listed up to SHOT_ASK_RATE x that price
// (our choice: the premium for not walking to a store town). Units: its town's demand
// plus SHOT_DISPLAY_UNITS of each (our choice: about an hour of a town's use), at most
// SHOT_STOCK_UNITS of each (our choice: a town's demand counts every hunter's hour, and
// each crafter there stocks it; ten hunters' hour is a private store's lot), one stack
// one listing line; a bot fires its shots each fight at any drop rate, so neither the
// hourly allowance nor the rate scales them, and OWED_MONEY alone bounds them.
// Held = its bag's unequipped units plus its own board sell lines (listed items leave the bag).
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');

const CRAFTER_CLASSES = Object.freeze([56, 57]);
const GEAR_GRADES = new Set(['c', 'b', 'a']);
const PIECES_PER_HOUR = 6, STOCK_HOURS = 2, HOUR_MS = 3600000, OWED_PIECES = 12, OWED_MONEY = 60000000;
const SHOT_GROUP = 'Shot', SHOT_DISPLAY_UNITS = 2000, SHOT_STOCK_UNITS = 20000, SHOT_ASK_RATE = 1.5;
const isShot = selfId => require('./ProductionPolicy').GRADED_SHOTS.has(Number(selfId));

function isCrafter(state) {
    return CRAFTER_CLASSES.includes(Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(state)));
}

// A grade's allowance at `now`: one hour's worth for a crafter that never stocked it.
// PIECES_PER_HOUR is the x50 pace; the server's drop rate scales it (supplyScale).
function allowance(state, grade, now) {
    const pace = PIECES_PER_HOUR * invoke('GameServer/Bot/Economy/RateScale').supplyScale();
    const held = state?.stats?.gnomeAllowance?.[grade];
    if (!held) return { pieces: pace, at: now };
    const hours = Math.max(0, (now - Number(held.at || 0)) / HOUR_MS);
    // At least one piece held, so a slow pace (x1) still reaches a whole piece.
    return { pieces: Math.min(Math.max(1, pace * STOCK_HOURS), Number(held.pieces || 0) + pace * hours), at: now };
}

// The crafter's offers in its town, as plain offers { selfId, price, ceiling,
// recipeLevel, grade, group }: the reserve's crafter rows there (ceiling: the price
// without a buyer, the valve row) and the graded shots (group SHOT_GROUP, no grade
// allowance; price: the cheapest store price a bot pays, ceiling SHOT_ASK_RATE x it;
// none while the store sells no such shot to bots).
function townOffers(state) {
    const Fixed = require('./FixedShotOffers');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const items = invoke('GameServer/DataCache').items;
    const gear = Fixed.offers(null, state).filter(row => Array.isArray(row.buyerClasses) && row.town === state.currentRegion)
        .flatMap(row => {
            const found = ItemTemplateIndex.find(items, row.selfId);
            const grade = String(found?.etc?.rank || '').toLowerCase(), kind = String(found?.template?.kind || '');
            if (!GEAR_GRADES.has(grade) || !(kind.startsWith('Weapon.') || kind.startsWith('Armor.'))) return [];
            const ceiling = Fixed.lowestPrice(row.selfId);
            return [{ selfId: Number(row.selfId), price: Number(row.price), ceiling: Number.isFinite(ceiling) ? ceiling : Number(row.price),
                recipeLevel: Number(Recipes.resolveByProductId(row.selfId)?.level || 0), grade,
                group: kind.startsWith('Weapon.') ? kind : `Armor:${Number(found?.etc?.slot || 0)}` }];
        });
    const Pricing = require('./StaticMerchantPricing');
    const shots = [...require('./ProductionPolicy').GRADED_SHOTS].flatMap(id => {
        const price = Pricing.cheapestPurchase(id, { forBot: true });
        if (!(Number.isFinite(price) && price > 0)) return [];
        return [{ selfId: id, price, ceiling: Math.floor(price * SHOT_ASK_RATE),
            recipeLevel: Number(Recipes.resolveByProductId(id)?.level || 0), group: SHOT_GROUP }];
    });
    return [...gear, ...shots];
}

// The crafter's offer a consigned purchase of `selfId` at `unitPrice` executes
// against while it still stands in its town, else null (the quote changed).
function consignOffer(state, selfId, unitPrice) {
    return townOffers(state).find(offer => offer.selfId === Number(selfId) && offer.price === Number(unitPrice)) || null;
}

// The gear units and adena a crafter owes the store: { pieces, money } (shot units
// count in the money only).
function owed(state) {
    let pieces = 0, money = 0;
    for (const [id, row] of Object.entries(state?.stats?.gnomeStock || {})) {
        const units = Math.max(0, Number(row?.owed || 0));
        if (!isShot(id)) pieces += units;
        money += units * Number(row.cost || 0);
    }
    return { pieces, money };
}

// The stats a consigned purchase of `units` from a crafter offer (consignOffer's: its
// selfId, price and ceiling) writes with it: its gnomeStock row with the units added
// to what it owes.
function consignPatch(state, offer, units) {
    const id = Number(offer.selfId);
    const owedUnits = Math.max(0, Number(state?.stats?.gnomeStock?.[id]?.owed || 0));
    return { gnomeStock: { [id]: { cost: Number(offer.price), ceiling: Number(offer.ceiling) || Number(offer.price),
        owed: owedUnits + Number(units) } } };
}

// The payments of one visit: [{ selfId, units, money, cost }], each owed unit the
// crafter no longer holds (sold through any channel), as far as its adena reaches.
// heldFor(selfId): units it holds (bag and own sell lines).
function settlement(state, heldFor = () => 0) {
    let adena = Math.max(0, Number(state?.adena || 0));
    const rows = [];
    for (const [id, row] of Object.entries(state?.stats?.gnomeStock || {})) {
        const cost = Number(row?.cost || 0);
        const gone = Math.max(0, Number(row?.owed || 0)) - Math.max(0, Number(heldFor(Number(id)) || 0));
        const units = cost > 0 ? Math.min(gone, Math.floor(adena / cost)) : 0;
        if (!(units > 0)) continue;
        rows.push({ selfId: Number(id), units, money: units * cost, cost });
        adena -= units * cost;
    }
    return rows;
}

// The purchases of one visit: [{ selfId, amount, money, unit, ceiling, grade }] (a shot
// row has no grade) and the gear allowance after them. offers: townOffers';
// demandFor(selfId): units its town wants; heldFor(selfId): units it holds (bag and own
// sell lines).
function restock(state, { offers = [], demandFor = () => 0, heldFor = () => 0, now = Date.now() } = {}) {
    if (!isCrafter(state)) return { rows: [], allowance: null };
    const craftLevel = Number(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state) || 0);
    const reached = offers.filter(offer => offer.recipeLevel > 0 && offer.recipeLevel <= craftLevel && offer.price > 0);
    const unlocked = reached.filter(offer => offer.group !== SHOT_GROUP);
    const targets = [];
    const wanted = new Set();
    for (const offer of unlocked) {
        const units = Math.floor(Number(demandFor(offer.selfId) || 0));
        if (units > 0) { targets.push({ offer, units }); wanted.add(offer.group); }
    }
    const armourOf = offer => (offer.group.startsWith('Weapon.') ? 0 : 1);
    targets.sort((a, b) => armourOf(a.offer) - armourOf(b.offer) || b.units - a.units || a.offer.selfId - b.offer.selfId);
    const top = new Map();
    for (const offer of unlocked) {
        if (wanted.has(offer.group)) continue;
        const held = top.get(offer.group);
        if (!held || offer.recipeLevel > held.recipeLevel
            || offer.recipeLevel === held.recipeLevel && (offer.price > held.price || offer.price === held.price && offer.selfId < held.selfId))
            top.set(offer.group, offer);
    }
    // Weapons first (most of the board's gear demand), then armour, by item id.
    const armour = offer => Number(offer.group.startsWith('Armor:'));
    for (const offer of [...top.values()].sort((a, b) => armour(a) - armour(b) || a.selfId - b.selfId)) targets.push({ offer, units: 1 });
    // Shots after the gear, by item id: its town's demand plus the display units.
    for (const offer of reached.filter(entry => entry.group === SHOT_GROUP).sort((a, b) => a.selfId - b.selfId))
        targets.push({ offer, units: Math.min(SHOT_STOCK_UNITS, Math.max(0, Math.floor(Number(demandFor(offer.selfId) || 0))) + SHOT_DISPLAY_UNITS) });
    const allowances = {};
    let { pieces, money } = owed(state);
    const rows = [];
    for (const { offer, units } of targets) {
        const shot = offer.group === SHOT_GROUP;
        const pool = shot ? null : allowances[offer.grade] ||= allowance(state, offer.grade, now);
        const amount = Math.min(units - Math.max(0, Number(heldFor(offer.selfId) || 0)), shot ? Infinity : Math.floor(pool.pieces),
            shot ? Infinity : OWED_PIECES - pieces, Math.floor((OWED_MONEY - money) / offer.price));
        if (!(amount > 0)) continue;
        rows.push({ selfId: offer.selfId, amount, money: amount * offer.price, unit: offer.price, ceiling: offer.ceiling, grade: offer.grade });
        money += amount * offer.price;
        if (shot) continue;
        pool.pieces -= amount;
        pieces += amount;
    }
    return { rows, allowance: { ...(state.stats?.gnomeAllowance || {}), ...allowances } };
}

// A crafter's standing material bids (our rule: the hunters' materials go to the
// gnomes' buy lines, the fixed buyers take them from gnomes only,
// ProductionPolicy.sellsToFixedBuyer): an Artisan or Warsmith bids for the materials
// of the C/B recipes its Create Item level reaches (their material trees, down to the
// basic materials), MATERIAL_BID_RATE x the NPC buy-back, up to MATERIAL_BID_UNITS
// held of each; the list runs from the materials most of those recipes take, and each
// crafter starts it at its characterId. Plain lines [{ selfId, count, price }]: BuyAdPolicy.linesFor
// posts them after the wish's bids, within the bot's buy lines and its adena budget
// (no consignment). The materials of a craft level are static data, kept per level.
const MATERIAL_BID_RATE = 1.2, MATERIAL_BID_UNITS = 300, BID_GRADES = new Set(['c', 'b']);
const materialsByLevel = new Map();
function bidMaterials(level) {
    if (materialsByLevel.has(level)) return materialsByLevel.get(level);
    const items = invoke('GameServer/DataCache').items, uses = new Map();
    const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    for (const recipe of require('../../Knowledge/RecipeCatalog').recipeItemRows(Recipes)) {
        if (recipe?.type !== 'dwarven' || !(Number(recipe.level) > 0) || Number(recipe.level) > level
            || !Array.isArray(recipe.materials) || !Sources.allowsRecipe(recipe)
            || !BID_GRADES.has(String(ItemTemplateIndex.find(items, recipe.productId)?.etc?.rank || '').toLowerCase())) continue;
        // The recipe's material tree: an input the crafter crafts itself (a dwarven recipe
        // its level reaches) adds its own materials.
        const seen = new Set(), open = recipe.materials.map(input => Number(input.selfId));
        while (open.length) {
            const id = open.pop();
            if (seen.has(id)) continue;
            seen.add(id); uses.set(id, (uses.get(id) || 0) + 1);
            const own = Recipes.resolveByProductId(id);
            if (own?.type === 'dwarven' && Number(own.level) <= level && Array.isArray(own.materials)) {
                for (const input of own.materials) open.push(Number(input.selfId));
            }
        }
    }
    const NpcSell = invoke('GameServer/Items/NpcSellRules');
    const rows = Object.freeze([...uses].flatMap(([selfId, count]) => {
        const template = ItemTemplateIndex.find(items, selfId)?.template;
        const price = Math.floor(MATERIAL_BID_RATE * NpcSell.npcBuyPrice(Number(template?.price || 0)));
        return String(template?.kind || '').startsWith('Other.Material') && price > 0 ? [{ selfId, price, count }] : [];
    }).sort((a, b) => b.count - a.count || a.selfId - b.selfId).map(({ selfId, price }) => Object.freeze({ selfId, price })));
    materialsByLevel.set(level, rows);
    return rows;
}
function materialBids(state) {
    if (!isCrafter(state)) return [];
    const level = Number(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state)) || 0;
    if (!(level > 0)) return [];
    // Each crafter starts at its characterId (mod the list, wrapping), so the crafters
    // of one level together bid on the whole list, not all on its first lines.
    const rows = bidMaterials(level), start = Math.abs(Number(state?.characterId) || 0) % (rows.length || 1);
    return [...rows.slice(start), ...rows.slice(0, start)].flatMap(({ selfId, price }) => {
        const count = MATERIAL_BID_UNITS - Math.max(0, Number(state?.inventory?.[String(selfId)]?.amount || 0));
        return count > 0 ? [{ selfId, count, price }] : [];
    });
}

module.exports = { isCrafter, allowance, townOffers, consignOffer, restock, owed, consignPatch, settlement, materialBids, CRAFTER_CLASSES, PIECES_PER_HOUR, STOCK_HOURS,
    OWED_PIECES, OWED_MONEY, SHOT_DISPLAY_UNITS, SHOT_STOCK_UNITS, SHOT_ASK_RATE, MATERIAL_BID_RATE, MATERIAL_BID_UNITS };
