'use strict';
// A crafter's gear stock for the board (our rule, standing for the dwarf craft and
// resale a C4 server runs on): an Artisan or Warsmith (classId 56/57) buys C/B/A
// pieces at a town visit from the reserve rows sold to its line only
// (MerchantStoreConfigs reserveGear, ProductionPolicy.allowsFixed) and lists them
// as ordinary bot sell lines (ItemDisposition.gnomeStock: never deposited, never
// sold to an NPC; ask between its cost and the item's price anchor, PriceAnchor.anchor:
// what a bot of the grade can afford, so no supplier asks above it).
// The same path stocks every supplier role at one cost and ask (SupplierRoles: its
// share of the supply volume, its gate and extra lines): a spoiler (Scavenger/Bounty Hunter) from the crafter rows, a
// station trader (SupplierRoles.isStationTrader) from its town's trader rows. Their
// intake stands for the drops the hunters bring to market, so each keeps the hourly pace.
// - Gating: a crafter only a piece whose recipe level its Create Item level reaches
//   (CraftEligibility.craftLevelFor; a piece without a recipe is never stocked); a
//   spoiler a piece of a grade its level wears (GearGradeRule); a trader any piece.
// - Demand first: the pieces its town wants (MarketDemand.forecast: public buy lines,
//   recent trades and the bots' funded plans there, PlanDemand) less the units other sellers already list there (townSupply:
//   the board's sell lines of the item in its town but its own), up to the units still
//   wanted; weapons before armour (a bot saves for its weapon first), then the most
//   wanted. The crafters, spoilers and traders of one town so share its demand instead
//   of all listing its most wanted piece, and a sold-out line may be followed by
//   another item.
// - Display: each weapon type and armour slot with no wanted piece, and none another
//   seller in its town lists (townSupply), keeps one piece of its top unlocked recipe
//   level (a spoiler or trader: in each grade), so new demand finds a listing.
// - Pace: PIECES_PER_HOUR x its role's share pieces a grade a game hour, refilled at the read, at most
//   STOCK_HOURS hours' worth held (stats.gnomeAllowance { grade: { pieces, at } }).
// - Consignment: the restock costs no adena; stats.gnomeStock[selfId] records
//   { cost, ceiling, owed } (consignPatch, written with the purchase) and the crafter
//   pays the store its cost for each owed unit it no longer holds at its next town
//   visit (settlement), as far as its adena reaches (the rest stays owed). Its wallet
//   no longer limits its range (run 6eb3afb37: no B/A weapon on the board, a B weapon
//   cost a crafter 5.2-7.9M against 4M wallets).
// - Owed limit (our choice): at most OWED_PIECES x its role's share gear units and
//   OWED_MONEY adena owed per supplier (its rows are priced on the anchor, PriceAnchor)
//   (one supplier never holds an unbounded share of the store); a restock row
//   past it is cut (hit: a crafter at the limit stocks nothing until it pays; each cut
//   row counted `crafter_stock:owed_limit:<pieces|money>`).
// Shots (C4: dwarves craft soulshots and spiritshots and sell them in private stores;
// the consignment stands for that craft, our choice): the graded soulshots,
// spiritshots and blessed spiritshots whose recipe level its Create Item level reaches
// (no-grade shots: the NPC sells them), in every town, on the same consignment at the
// suppliers' one cost, COST_RATE x the shot's anchor (PriceAnchor.shotAnchor), listed at
// the anchor (shotCeiling; ItemDisposition.gnomeAsk: a consumable keeps one price, as an
// NPC's does, our choice). The crafters are the bots' only graded shot seller (no static
// shot row sells to a bot), so their stock does not run out: each restock tops every
// shot up to SHOT_STOCK_UNITS (our choice: a private store's lot, some ten hunters' hour;
// an unsold unit is owed nothing), neither its town's past sales nor the hourly
// allowance sizes it, and the owed limit alone bounds it.
// Held = its bag's unequipped units plus its own board sell lines (listed items leave the bag).
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Diagnostics = require('./EconomyDiagnostics');

const { ROLES, COST_RATE, roleOf, isStationTrader } = require('./SupplierRoles');
const CRAFTER_CLASSES = ROLES.crafter.classes;
const GEAR_GRADES = new Set(['c', 'b', 'a']);
const PIECES_PER_HOUR = 6, STOCK_HOURS = 2, HOUR_MS = 3600000, OWED_PIECES = 12, OWED_MONEY = 60000000;
const SHOT_GROUP = 'Shot', SHOT_STOCK_UNITS = 20000;
const isShot = selfId => require('./ProductionPolicy').GRADED_SHOTS.has(Number(selfId));

function isCrafter(state) {
    return CRAFTER_CLASSES.includes(Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(state)));
}
// The most a crafter or trader asks for a piece: its price anchor, what a bot of the
// grade can afford.
function askCeiling(selfId) {
    return require('./PriceAnchor').anchor(selfId);
}

// A grade's allowance at `now`: one hour's worth for a crafter that never stocked it.
// PIECES_PER_HOUR is the x50 pace; the server's drop rate scales it (supplyScale).
function allowance(state, grade, now) {
    const pace = PIECES_PER_HOUR * (ROLES[roleOf(state)]?.share ?? 1) * invoke('GameServer/Bot/Economy/RateScale').supplyScale();
    const held = state?.stats?.gnomeAllowance?.[grade];
    if (!held) return { pieces: pace, at: now };
    const hours = Math.max(0, (now - Number(held.at || 0)) / HOUR_MS);
    // At least one piece held, so a slow pace (x1) still reaches a whole piece.
    return { pieces: Math.min(Math.max(1, pace * STOCK_HOURS), Number(held.pieces || 0) + pace * hours), at: now };
}

// A supplier's offers in its town, as plain offers { selfId, price, ceiling,
// recipeLevel, grade, group }: the reserve rows there sold to its role (a trader the
// trader rows, the others the crafter rows; ceiling: askCeiling) and, for a role with
// shots, the graded shots (group SHOT_GROUP, no grade allowance; price: the shot's
// anchor, ceiling shotCeiling; none while the switch removes the reserve,
// ProductionPolicy.shotsDisabled).
// A C/B/A weapon's or armour piece's display slot: { grade, group } (group: its weapon
// type, or Armor:<slot>), else null.
function gearSlot(selfId) {
    const found = ItemTemplateIndex.find(invoke('GameServer/DataCache').items, selfId);
    const grade = String(found?.etc?.rank || '').toLowerCase(), kind = String(found?.template?.kind || '');
    if (!GEAR_GRADES.has(grade) || !(kind.startsWith('Weapon.') || kind.startsWith('Armor.'))) return null;
    return { grade, group: kind.startsWith('Weapon.') ? kind : `Armor:${Number(found?.etc?.slot || 0)}` };
}
function townOffers(state) {
    const role = roleOf(state);
    if (!role) return [];
    const Fixed = require('./FixedShotOffers');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const ownRow = role === 'trader' ? row => row.buyerRole === 'trader' : row => Array.isArray(row.buyerClasses);
    const gear = Fixed.offers(null, state, { consignment: true }).filter(row => ownRow(row) && row.town === state.currentRegion)
        .flatMap(row => {
            const slot = gearSlot(row.selfId);
            if (!slot) return [];
            return [{ selfId: Number(row.selfId), price: Number(row.price), ceiling: askCeiling(row.selfId),
                recipeLevel: Number(Recipes.resolveByProductId(row.selfId)?.level || 0), ...slot }];
        });
    if (!ROLES[role].shots) return gear;
    const Production = require('./ProductionPolicy');
    const shots = Production.shotsDisabled() ? [] : [...Production.GRADED_SHOTS].flatMap(id => {
        const anchor = require('./PriceAnchor').shotAnchor(id);
        if (!(anchor > 0)) return [];
        return [{ selfId: id, price: Math.max(1, Math.floor(anchor * COST_RATE)), ceiling: shotCeiling(id),
            recipeLevel: Number(Recipes.resolveByProductId(id)?.level || 0), group: SHOT_GROUP }];
    });
    return [...gear, ...shots];
}

// The most a crafter asks for a graded shot, its anchor (Infinity
// while the switch removes the reserve): the bots' price of the shot
// (StaticMerchantPricing.cheapestPurchase).
function shotCeiling(selfId) {
    if (require('./ProductionPolicy').shotsDisabled()) return Infinity;
    const price = require('./PriceAnchor').shotAnchor(selfId);
    return price > 0 ? price : Infinity;
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

// A role's gate on a gear offer: 'craft' its recipe level within the Create Item level,
// 'wear' its grade at most the grade the level wears, 'none' every piece.
function gated(state, gate) {
    if (gate === 'craft') {
        const craftLevel = Number(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state) || 0);
        return offer => offer.recipeLevel > 0 && offer.recipeLevel <= craftLevel;
    }
    if (gate === 'wear') {
        const Grades = invoke('GameServer/Bot/AI/GearGradeRule'), worn = Grades.rankOf(Grades.gradeForLevel(state?.level));
        return offer => Grades.rankOf(offer.grade) <= worn;
    }
    return () => true;
}

// What the other sellers of a town list (board: the board index; its sell lines in
// `town`, an unplaced record's in every town, all but ownerId's): listedFor(selfId) the
// units of an item, shown the display slots of the C/B/A gear listed (each as its group
// and as grade|group). One walk of the town's sell items for the slots, one of an
// item's lines per item asked.
function townSupply(board, town, ownerId) {
    const SELL = 1, own = Number(ownerId), units = new Map(), shown = new Set();
    const others = function* (selfId) {
        for (const line of board?.lines?.(selfId, SELL, town) || []) if (line.ownerId !== own) yield line;
    };
    for (const selfId of board?.itemIds?.(SELL, town) || []) {
        const slot = gearSlot(selfId);
        if (!slot || others(selfId).next().done) continue;
        shown.add(slot.group).add(`${slot.grade}|${slot.group}`);
    }
    const listedFor = (selfId) => {
        const id = Number(selfId);
        if (!units.has(id)) {
            let count = 0;
            for (const line of others(id)) count += Number(line.count || 0);
            units.set(id, count);
        }
        return units.get(id);
    };
    return { listedFor, shown };
}

// The purchases of one visit: [{ selfId, amount, money, unit, ceiling, grade }] (a shot
// row has no grade) and the gear allowance after them. offers: townOffers';
// demandFor(selfId): units its town wants; heldFor(selfId): units it holds (bag and own
// sell lines); listedFor(selfId) and shown: what other sellers list in its town
// (townSupply).
function restock(state, { offers = [], demandFor = () => 0, heldFor = () => 0, listedFor = () => 0, shown = new Set(),
    now = Date.now() } = {}) {
    const role = roleOf(state), terms = ROLES[role];
    if (!role) return { rows: [], allowance: null };
    const gate = gated(state, terms.gate);
    const reached = offers.filter(offer => offer.price > 0 && (offer.group !== SHOT_GROUP || terms.shots) && gate(offer));
    const unlocked = reached.filter(offer => offer.group !== SHOT_GROUP);
    const targets = [];
    const wanted = new Set();
    // A display slot: the weapon type or armour slot, a spoiler's or trader's within each grade.
    const slot = terms.gate === 'craft' ? offer => offer.group : offer => `${offer.grade}|${offer.group}`;
    const listed = offer => Math.max(0, Math.floor(Number(listedFor(offer.selfId) || 0)));
    for (const offer of unlocked) {
        const units = Math.floor(Number(demandFor(offer.selfId) || 0)) - listed(offer);
        if (units > 0) { targets.push({ offer, units }); wanted.add(slot(offer)); }
    }
    const armourOf = offer => (offer.group.startsWith('Weapon.') ? 0 : 1);
    targets.sort((a, b) => armourOf(a.offer) - armourOf(b.offer) || b.units - a.units || a.offer.selfId - b.offer.selfId);
    const top = new Map();
    for (const offer of unlocked) {
        if (wanted.has(slot(offer)) || shown.has(slot(offer))) continue;
        const held = top.get(slot(offer));
        if (!held || offer.recipeLevel > held.recipeLevel
            || offer.recipeLevel === held.recipeLevel && (offer.price > held.price || offer.price === held.price && offer.selfId < held.selfId))
            top.set(slot(offer), offer);
    }
    // Weapons first (most of the board's gear demand), then armour, by item id.
    const armour = offer => Number(offer.group.startsWith('Armor:'));
    for (const offer of [...top.values()].sort((a, b) => armour(a) - armour(b) || a.selfId - b.selfId)) targets.push({ offer, units: 1 });
    // Shots after the gear, by item id: each topped up to its lot.
    for (const offer of reached.filter(entry => entry.group === SHOT_GROUP).sort((a, b) => a.selfId - b.selfId))
        targets.push({ offer, units: SHOT_STOCK_UNITS });
    const allowances = {};
    let { pieces, money } = owed(state);
    const rows = [];
    for (const { offer, units } of targets) {
        const shot = offer.group === SHOT_GROUP;
        const pool = shot ? null : allowances[offer.grade] ||= allowance(state, offer.grade, now);
        const wanted = Math.min(units - Math.max(0, Number(heldFor(offer.selfId) || 0)), shot ? Infinity : Math.floor(pool.pieces));
        const piecesRoom = shot ? Infinity : Math.floor(OWED_PIECES * terms.share) - pieces, moneyRoom = Math.floor((OWED_MONEY - money) / offer.price);
        const amount = Math.min(wanted, piecesRoom, moneyRoom);
        if (wanted > 0 && amount < wanted && Diagnostics.active())
            Diagnostics.count('crafter_stock', 'owed_limit', moneyRoom < piecesRoom ? 'money' : 'pieces');
        if (!(amount > 0)) continue;
        rows.push({ selfId: offer.selfId, amount, money: amount * offer.price, unit: offer.price, ceiling: offer.ceiling, grade: offer.grade });
        money += amount * offer.price;
        if (shot) continue;
        pool.pieces -= amount;
        pieces += amount;
    }
    return { rows, allowance: { ...(state.stats?.gnomeAllowance || {}), ...allowances } };
}

// A crafter's standing material bids (our rule: the hunters' materials, the spoilers'
// recipe parts first among them, go to the crafters' buy lines; the fixed buyers take
// nothing from bots, TradeService.acceptsSellerItem): an Artisan or Warsmith
// bids for the materials of the C/B/A recipes its Create Item level reaches whose
// product it stocks (a stats.gnomeStock row) or some town wants (MarketDemand.towns:
// recent trades or public buy lines; one board read per recipe of its level, both
// threads reading the same tables), with their material trees down to the basic
// materials, MATERIAL_BID_RATE x the NPC buy-back (the drop rate already multiplies
// the units, so the price does not follow the Adena rate) and, like the fixed buy line,
// never above StaticMerchantPricing.buyCeiling (0.9 of the cheapest supply), up to
// MATERIAL_BID_UNITS held of each; the list runs from the materials most of those
// recipes take, and each crafter starts it at its characterId. A crafter whose pieces
// nobody wants and who stocks none bids for nothing (run c8e33afec: 147 of 192 bid lines
// over every recipe of the level never filled). Plain lines [{ selfId, count, price }]:
// BuyAdPolicy.linesFor posts them after the wish's bids, within the bot's buy lines and
// its adena budget (no consignment). A recipe's material tree and a material's x1 bid
// are static data, kept per craft level; demand applies when the bids are read.
const MATERIAL_BID_RATE = 1.2, MATERIAL_BID_UNITS = 300;
const recipesByLevel = new Map();
// The bid recipes a craft level reaches: [{ productId, materials: [{ selfId, price }] }].
function bidRecipes(level) {
    if (recipesByLevel.has(level)) return recipesByLevel.get(level);
    const items = invoke('GameServer/DataCache').items;
    const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const NpcSell = invoke('GameServer/Items/NpcSellRules');
    const bidOf = selfId => {
        const template = ItemTemplateIndex.find(items, selfId)?.template;
        const price = Math.floor(MATERIAL_BID_RATE * NpcSell.npcBuyPrice(Number(template?.price || 0)));
        return String(template?.kind || '').startsWith('Other.Material') && price > 0 ? price : 0;
    };
    const rows = [];
    for (const recipe of require('../../Knowledge/RecipeCatalog').recipeItemRows(Recipes)) {
        if (recipe?.type !== 'dwarven' || !(Number(recipe.level) > 0) || Number(recipe.level) > level
            || !Array.isArray(recipe.materials) || !Sources.allowsRecipe(recipe)
            || !GEAR_GRADES.has(String(ItemTemplateIndex.find(items, recipe.productId)?.etc?.rank || '').toLowerCase())) continue;
        // The recipe's material tree: an input the crafter crafts itself (a dwarven recipe
        // its level reaches) adds its own materials.
        const seen = new Set(), open = recipe.materials.map(input => Number(input.selfId)), materials = [];
        while (open.length) {
            const id = open.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            const price = bidOf(id);
            if (price > 0) materials.push(Object.freeze({ selfId: id, price }));
            const own = Recipes.resolveByProductId(id);
            if (own?.type === 'dwarven' && Number(own.level) <= level && Array.isArray(own.materials)) {
                for (const input of own.materials) open.push(Number(input.selfId));
            }
        }
        if (materials.length) rows.push(Object.freeze({ productId: Number(recipe.productId), materials: Object.freeze(materials) }));
    }
    const frozen = Object.freeze(rows);
    recipesByLevel.set(level, frozen);
    return frozen;
}
// board: the board the bids are read with (its public buy lines are demand).
function materialBids(state, { board = null, timestamp = Date.now() } = {}) {
    if (!ROLES[roleOf(state)]?.bids) return [];
    const level = Number(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state)) || 0;
    if (!(level > 0)) return [];
    const Demand = require('./MarketDemand');
    const stocked = state?.stats?.gnomeStock || {}, uses = new Map();
    for (const recipe of bidRecipes(level)) {
        if (!(Number(stocked[recipe.productId]?.cost) > 0) && !Demand.towns(recipe.productId, board, timestamp).length) continue;
        for (const material of recipe.materials) {
            const use = uses.get(material.selfId);
            if (use) use.count++; else uses.set(material.selfId, { ...material, count: 1 });
        }
    }
    const rows = [...uses.values()].sort((a, b) => b.count - a.count || a.selfId - b.selfId);
    // Each crafter starts at its characterId (mod the list, wrapping), so the crafters
    // of one level together bid on the whole list, not all on its first lines.
    const start = Math.abs(Number(state?.characterId) || 0) % (rows.length || 1);
    const Static = require('./StaticMerchantPricing');
    return [...rows.slice(start), ...rows.slice(0, start)].flatMap(({ selfId, price }) => {
        const count = MATERIAL_BID_UNITS - Math.max(0, Number(state?.inventory?.[String(selfId)]?.amount || 0));
        return count > 0 ? [{ selfId, count, price: Math.min(price, Static.buyCeiling(selfId)) }] : [];
    });
}

module.exports = { isCrafter, isStationTrader, roleOf, askCeiling, allowance, gearSlot, townOffers, townSupply, shotCeiling, consignOffer, restock, owed, consignPatch, settlement, materialBids, CRAFTER_CLASSES, PIECES_PER_HOUR, STOCK_HOURS,
    OWED_PIECES, OWED_MONEY, SHOT_STOCK_UNITS, MATERIAL_BID_RATE, MATERIAL_BID_UNITS };
