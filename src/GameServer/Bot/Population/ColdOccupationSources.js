'use strict';

// One immutable catalogue per reader thread. Dynamic quotes and route
// expansion are streamed; no owner holds a recipe/town graph or whole board.
const Data = invoke('GameServer/DataCache');
const ItemIndex = require('../../Item/ItemTemplateIndex');
const StaticPricing = require('../Economy/StaticMerchantPricing');
const Routes = require('../Travel/TravelRoutes');
const Towns = require('../../World/TownRespawn');
const Production = require('../Economy/ProductionPolicy');
const { personalOfferAllowed } = require('./PartyAdmission');
const QUOTE_DEPTH = 5;
const EMPTY = Object.freeze([]);
let fixedBuy, npcByItem, mpRates, townByName, townOrdinal, gearByRank, npcSellerTowns;

function initialise() {
    if (fixedBuy) return;
    fixedBuy = new Map(); npcByItem = new Map(); mpRates = new Map(); npcSellerTowns = new Set();
    gearByRank = new Map();
    townByName = new Map(); townOrdinal = new Map();
    for (const town of Object.values(Towns.towns)) { townOrdinal.set(town.name, townOrdinal.size); townByName.set(town.name, town); }
    // allOffers() has prices but no town/source authority. Index actual static
    // seller spawns once, using TownServiceCatalog's same 7500-unit town bound.
    const Shops = require('../../World/Generics/NpcShopBuyLists'), sellers = new Set(Shops.npcIds());
    const nativeOffers = new Map();
    for (const zone of Data.npcSpawns || []) for (const spawn of zone.spawns || []) {
        const sourceId = Number(spawn.selfId);
        if (!sellers.has(sourceId)) continue;
        for (const loc of spawn.coords || []) {
            if (![loc.locX, loc.locY, loc.locZ].every(Number.isFinite)) continue;
            const town = Towns.getClosestTown(loc.locX, loc.locY, loc.locZ);
            if (!town || Math.hypot(town.locX - loc.locX, town.locY - loc.locY) > 7500) continue;
            npcSellerTowns.add(town.name);
            for (const row of Shops.fetchForNpc(sourceId)) {
                const key = `${row.selfId}:${town.name}`, held = nativeOffers.get(key);
                if (!held || Number(row.price) < held.price || Number(row.price) === held.price && sourceId < held.sourceId)
                    nativeOffers.set(key, Object.freeze({ selfId: Number(row.selfId), price: Number(row.price),
                        sourceId, sourceType: 'npc', town: town.name, repeatable: true }));
            }
        }
    }
    for (const row of nativeOffers.values()) {
        if (!npcByItem.has(row.selfId)) npcByItem.set(row.selfId, []);
        npcByItem.get(row.selfId).push(row);
    }
    for (const rows of npcByItem.values()) Object.freeze(rows);
    for (const item of Data.items || []) {
        invoke('GameServer/Bot/Economy/MarketCounters').counterOf(item.selfId);
        const crystals = Number(item.etc?.cristals), rank = String(item.etc?.rank || '');
        if (!(crystals > 0) || !/^(Weapon|Armor)\./.test(String(item.template?.kind || ''))) continue;
        if (!gearByRank.has(rank)) gearByRank.set(rank, []);
        gearByRank.get(rank).push(Object.freeze({ selfId: Number(item.selfId), crystals, rank }));
    }
    for (const [buyerName, store] of Object.entries(invoke('GameServer/Bot/MerchantStoreConfigs'))) {
        if (Number(store.storeType) !== 3 || !store.town) continue;
        for (const line of store.items || []) {
            const id = Number(line.selfId), price = StaticPricing.botPriceFor(store, line);
            if (!(price > 0) || !Number.isFinite(price)) continue;
            if (!fixedBuy.has(id)) fixedBuy.set(id, []);
            fixedBuy.get(id).push(Object.freeze({ type: 'static', buyerName, town: store.town,
                staticId: fixedBuy.get(id).length + 1, price, count: Math.max(0, Number(line.count || 0)), repeatable: true }));
        }
    }
    // Exact native seated recovery is static in class/level on this branch.
    const Rest = require('./ColdRest');
    for (const row of Data.classTemplates || []) {
        const rates = new Float64Array(81);
        for (let level = 1; level <= 80; level++) rates[level] = Rest.coldRestRegenPerTick({ level,
            stats: { classId: Number(row.classId) } }).mp * 1200;
        mpRates.set(Number(row.classId), rates);
    }
}

function* reservations(state) {
    const reserved = {}, plan = state.stats?.equipmentPlan;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const role = Planner.roleFor(state), classId = Number(state.stats?.classId || state.classId || 0);
    const allowed = Disposition.gradeIndex(Planner.gradeForLevel(state.level));
    const equipped = new Map(), staged = new Map();
    for (const key in state.inventory || {}) {
        const item = state.inventory[key], template = ItemIndex.find(Data.items, Number(item.selfId));
        const slot = Number(template?.etc?.slot || 0), rank = Disposition.gradeIndex(template?.etc?.rank);
        if ([6, 9, 10, 11, 12, 15].includes(slot)) {
            const candidate = { selfId: Number(item.selfId), rank, score: Planner.itemScore(template, role, classId) };
            if (item.equipped || Number(item.equippedCount || 0) > 0) equipped.set(slot, candidate);
            else if (Number(item.amount) > 0 && rank <= allowed && Planner.suitable(template, state, role, template.etc.rank)) {
                const current = staged.get(slot);
                if (!current || rank > current.rank || rank === current.rank && candidate.score > current.score) staged.set(slot, candidate);
            }
        }
        // Books are never ingredients of this catalogue. Keeping them also
        // prevents a captured, untrained first-rank book from being allocated.
        if (String(template?.template?.kind || '').startsWith('Other.Spellbook')) reserved[item.selfId] = 1;
        yield 'stock';
    }
    for (const [slot, candidate] of staged) {
        let worn = equipped.get(slot) || ([10, 11].includes(slot) ? equipped.get(15) : null);
        if (slot === 15) for (const number of [10, 11]) {
            const other = equipped.get(number);
            if (other && (!worn || other.rank > worn.rank || other.rank === worn.rank && other.score > worn.score)) worn = other;
        }
        if (!worn || candidate.rank > worn.rank || candidate.rank === worn.rank && candidate.score > worn.score) reserved[candidate.selfId] = 1;
        yield 'owned';
    }
    if (plan?.combine && ['active', 'component_ready', 'ready_to_craft', 'blocked'].includes(plan.status)) {
        for (const row of plan.combine.requirements || []) {
            reserved[row.selfId] = Math.max(Number(reserved[row.selfId] || 0), Number(row.amount || 0)); yield 'ingredient';
        }
    }
    if (['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) && plan.strategy === 'craft') {
        // ARCH-NOTE: accepted clan/provider allocations belong to their existing
        // owner. Missing immutable allocation adapter makes this forecast unknown.
        if (plan.clanGoal?.clanId && plan.recipeId) return null;
        const Recipes = invoke('GameServer/Items/C4RecipeItems');
        const stack = [{ rows: plan.materials || [], at: 0, multiplier: 1, seen: new Set(), depth: 0 }];
        while (stack.length) {
            const node = stack[stack.length - 1];
            if (node.at >= node.rows.length) { stack.pop(); yield 'edge'; continue; }
            const row = node.rows[node.at++], id = Number(row.selfId), required = Number(row.amount) * node.multiplier;
            if (id && !node.seen.has(id)) {
                reserved[id] = Number(reserved[id] || 0) + required;
                const missing = Math.max(0, required - Number(state.inventory?.[id]?.amount ?? row.owned ?? 0));
                const recipe = missing > 0 ? Recipes.resolveByProductId(id) : null;
                if (recipe && node.depth < 5) stack.push({ rows: recipe.materials || [], at: 0,
                    multiplier: Math.ceil(missing / Math.max(1, Number(recipe.productCount))), seen: new Set([...node.seen, id]), depth: node.depth + 1 });
                else if (recipe && node.depth >= 5) return null;
            }
            yield 'edge';
        }
    }
    const target = Number(plan?.target?.selfId || 0);
    if (target && Number(state.inventory?.[target]?.amount) > 0 && !state.inventory[target].equipped) reserved[target] = 1;
    return reserved;
}

function* feasibility(state, { board, read = () => {} }, reserved = null) {
    reserved ||= yield* reservations(state);
    if (!reserved || !board) return null;
    const Look = require('../Economy/BoardLook'), lines = board.ownerLines(state.characterId);
    if (lines.length > Look.MAX_OWNED_LINES) return null;
    let hash = 0x811c9dc5, blocked = 0, at = 0;
    for (const line of lines) {
        read(line.selfId); hash = Look.lineFingerprint(hash, line);
        if (line.storeType === 1 && Look.indexedFeasibility(state, line, reserved) === false) blocked |= 1 << at;
        at++; yield 'owned';
    }
    return [hash, blocked, lines.length];
}

const EconomicTrip = require('../Economy/EconomicTrip');
const { regionalTown, details: tripDetails } = EconomicTrip;
function recipeIndex(board) {
    initialise();
    return require('../Economy/RecipeProductionIndex').forBoard(board, {
        accept: recipe => !String(ItemIndex.find(Data.items, recipe.productId)?.template?.kind || '').startsWith('Other.Shot'),
        fixedBuyer: recipe =>
        !Production.buyersDisabled() && String(ItemIndex.find(Data.items, recipe.productId)?.template?.kind || '').startsWith('Other.Material')
        && !!fixedBuy.get(Number(recipe.productId))?.length });
}

// The same enabled fixed material buyers feed production actions and the
// finite wish graph. These are supported authored exits, not player forecasts.
function fixedBuyerOffersFor(id) {
    initialise();
    return Production.buyersDisabled() ? EMPTY : fixedBuy.get(Number(id)) || EMPTY;
}

// One value of an owned item for the wish and the producer (user 2026-10-10,
// Q1): what the bot gets selling one unit now. NPC buyback, the top
// QUOTE_DEPTH board bids of others and the enabled fixed buyers.
function* exitValue(state, id, board = null) {
    initialise();
    const item = ItemIndex.find(Data.items, Number(id));
    let value = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Number(item?.template?.price || 0));
    let count = 0;
    for (const line of board?.list(Number(id), 3) || []) {
        if (count++ === QUOTE_DEPTH) break;
        if (Number(line.ownerId) === Number(state.characterId)) { yield 'quote'; continue; }
        value = Math.max(value, Number(line.price || 0)); yield 'quote';
    }
    for (const exit of fixedBuyerOffersFor(id)) { value = Math.max(value, exit.price); yield 'quote'; }
    return Number.isFinite(value) ? Math.max(0, value) : NaN;
}

// Seated MP recovery per hour, one reader for the wish and the producer.
function mpPerHour(state) {
    initialise();
    return mpRates.get(Number(state.stats?.classId ?? state.classId))?.[Number(state.level)];
}

// The native craft executor's facts, one reader for the wish and the
// producer: a hot bot crafts one batch per command; a cold command is bound
// by the MP cap the executor's vitals carry (the combat profile only when
// none is stored); seated recovery prices the labour.
function craftLabour(state, timestamp = Date.now(), profile = null) {
    if (state.phase === 'hot') return { executor: 'hot', mpCapacity: Infinity, mpPerHour: mpPerHour(state) };
    const stored = Number(state.vitals?.maxMp);
    const mpCapacity = stored > 0 ? stored : Number((profile ? profile()
        : invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(state, timestamp))?.maxMp);
    return { executor: 'cold', mpCapacity, mpPerHour: mpPerHour(state) };
}

function* prepare(state, { board, timestamp, read = () => {}, readScope = () => {}, stock = null, economy = null,
    routeRows = null, routeKey = null } = {}) {
    const packet = state.stats?.money;
    if (!board || !Array.isArray(packet) || packet.length < 4 || !(packet[0] > 0) || !(packet[1] > 0)) return null;
    const admission = recipeIndex(board);
    const craftLevel = invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor(state);
    readScope(admission.scopeFor(craftLevel));
    const reserved = yield* reservations(state);
    if (!reserved) return null;
    const preparedFeasibility = yield* feasibility(state, { board, read }, reserved);
    const ownStock = new Map(), routes = [];
    const key = EconomicTrip.key(state);
    const directRows = routeKey === key && Array.isArray(routeRows) && routeRows.length === EconomicTrip.towns.length
        ? routeRows : null;
    const readyRows = directRows || (economy?.routeKey === key ? economy.routeRows : null);
    const readyTrip = Array.isArray(readyRows) && readyRows.length === EconomicTrip.towns.length
        ? EconomicTrip.preparedReader(readyRows, { hourAdena: Number(packet[0]) }) : null;
    const context = { timestamp, state, insideContext: true, hourAdena: Number(packet[0]), moneyPrice: Number(packet[1]),
        survivalReserve: Number(packet[2]), ...craftLabour(state, timestamp),
        independentPrice: id => ownStock.get(Number(id))?.unitValue ?? NaN, worth: id => ownStock.get(Number(id))?.unitValue ?? NaN };
    const ensureTrip = function* (town) {
        const index = townOrdinal.get(town);
        if (index === undefined) return { known: false, hours: NaN, fees: NaN };
        if (!routes[index]) routes[index] = readyTrip ? readyTrip.details(town) : yield* tripDetails(state, town);
        return routes[index];
    };
    const trip = town => {
        const row = routes[townOrdinal.get(town)];
        return row?.known ? row.hours * context.hourAdena + row.fees : Infinity;
    };
    trip.details = town => routes[townOrdinal.get(town)] || { known: false, hours: NaN, fees: NaN };
    context.trip = trip;
    for (const key in state.inventory || {}) {
        const id = Number(state.inventory[key].selfId || key); read(id);
        const value = yield* exitValue(state, id, board);
        let amount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory[key], reserved);
        if (Number(stock?.itemId) === id) amount = Math.max(0, amount - Math.min(amount,
            Math.max(0, Number(stock.target || 0))));
        ownStock.set(id, { count: amount, unitValue: value }); yield 'stock';
    }
    const prepareExits = function* (owner, recipe, template) {
        const result = []; read(recipe.productId); let count = 0;
        for (const line of board?.list(recipe.productId, 3) || []) {
            if (count++ === QUOTE_DEPTH) break;
            if (Number(line.ownerId) === Number(owner.characterId) || Number(line.enchant || 0)
                || !personalOfferAllowed(line, owner)) { yield 'quote'; continue; }
            const details = yield* ensureTrip(line.town);
            result.push({ type: 'afk', conditional: line.custodyPolicy === 1, offer: line, price: Number(line.price), count: Number(line.count), town: line.town,
                trip: trip(line.town), tripDetails: details, repeatable: false });
            yield 'quote';
        }
        if (!Production.buyersDisabled() && String(template?.template?.kind || '').startsWith('Other.Material')) {
            for (const exit of fixedBuyerOffersFor(recipe.productId)) {
                const details = yield* ensureTrip(exit.town);
                result.push({ ...exit, trip: trip(exit.town), tripDetails: details }); yield 'quote';
            }
        }
        for (const exit of result) {
            if (exit.type !== 'afk') { yield 'exit'; continue; }
            let cheaper = 0, depth = 0, tailUnknown = false;
            for (const line of board?.list(recipe.productId, 1) || []) {
                if (Number(line.price) >= exit.price) break;
                if (Number(line.ownerId) !== Number(owner.characterId) && !Number(line.enchant || 0)) {
                    if (depth === QUOTE_DEPTH) { tailUnknown = cheaper < exit.count; break; }
                    cheaper += Math.max(0, Number(line.count)); depth++;
                }
                yield 'quote';
                if (cheaper >= exit.count) break;
            }
            exit.cheaperUnits = cheaper;
            if (tailUnknown) exit.applicableUnits = NaN;
            Object.assign(exit, invoke('GameServer/Bot/Economy/PriceDecision').prospectiveExit(state, exit, { board, timestamp }));
            yield 'exit';
        }
        return result;
    };
    const preparePurchase = function* (owner, id, amount, query = {}) {
        read(id);
        const towns = []; let depth = 0;
        for (const line of board?.list(id, 1) || []) {
            if (depth++ === QUOTE_DEPTH) break;
            if (Number(line.ownerId) === Number(owner.characterId) || Number(line.enchant || 0)
                || !personalOfferAllowed(line, owner)) { yield 'quote'; continue; }
            const index = townOrdinal.get(line.town);
            if (index === undefined) { yield 'quote'; continue; }
            let held = towns[index]; if (!held) towns[index] = held = { town: line.town, lines: [], npcPrice: 0 };
            held.lines.push(line); yield 'quote';
        }
        // Static NPC stock is the only unlimited ingredient source admitted here.
        if (query.npc === true && Production.allowsNpcShot(id)) for (const offer of npcByItem.get(Number(id)) || []) {
            const index = townOrdinal.get(offer.town);
            if (index === undefined) { yield 'quote'; continue; }
            let held = towns[index]; if (!held) towns[index] = held = { town: offer.town, lines: [], npcPrice: 0 };
            const price = Number(offer.price);
            if (price > 0) held.npcPrice = held.npcPrice ? Math.min(held.npcPrice, price) : price;
            yield 'quote';
        }
        let best = null;
        for (const held of towns) {
            if (!held) { yield 'trip'; continue; }
            const town = held.town;
            const details = yield* ensureTrip(town);
            if (!details.known) continue;
            let remaining = amount, cost = 0, npc = 0; const lines = [];
            for (const line of held.lines) {
                const price = Number(line.price), units = Math.min(remaining, Number(line.count));
                if (price > 0 && (!held.npcPrice || price <= held.npcPrice) && units > 0) {
                    lines.push({ line, count: units, price }); remaining -= units; cost += units * price;
                }
                yield 'quote';
            }
            if (remaining > 0 && held.npcPrice > 0) { npc = remaining; cost += npc * held.npcPrice; remaining = 0; }
            const units = amount - remaining, landed = cost + trip(town), whole = remaining === 0;
            if (units > 0 && (!best || whole && !best.whole || whole === best.whole
                && (landed / units < best.landed / best.units || landed / units === best.landed / best.units && String(town) < String(best.town)))) {
                best = { town, lines, npc, npcPrice: held.npcPrice, units, cost, trip: trip(town), landed, whole,
                    tripDetails: details, repeatable: npc === amount, routeKey: town };
            }
            yield 'candidate';
        }
        return best;
    };
    const gearRowsFor = function* (rank) {
        for (const gear of gearByRank.get(rank) || []) {
            // Null is one static adjacency edge. The consumer yields before
            // skipping it, including catalogue entries with no observed quote.
            yield null; read(gear.selfId);
            for (const offer of npcByItem.get(gear.selfId) || []) {
                const price = Number(offer.price);
                if (price > 0) yield { ...gear, source: 'npc', price, cash: price, count: 1,
                    town: offer.town, ownerId: 0, repeatable: true };
                else yield null;
            }
            let depth = 0;
            for (const line of board?.list(gear.selfId, 1) || []) {
                if (depth++ === QUOTE_DEPTH) break;
                if (Number(line.ownerId) !== Number(state.characterId) && !Number(line.enchant || 0) && Number(line.price) > 0
                    && personalOfferAllowed(line, state)) {
                    yield { ...gear, source: 'afk', price: Number(line.price), cash: Number(line.price), count: Number(line.count),
                        town: line.town, ownerId: Number(line.ownerId), offer: line, repeatable: false };
                } else yield null;
            }
        }
    };
    return { context, feasibility: preparedFeasibility, options: { reserved, ownStock, prepareExits, preparePurchase, prepareTrip: ensureTrip, gearRowsFor,
        unknownRecipes: () => admission.rowsFor(craftLevel),
        ownLines: board?.ownerLines(Number(state.characterId)) || [] } };
}

module.exports = { initialise, prepare, exitValue, craftLabour, reservations, feasibility, tripDetails, regionalTown, QUOTE_DEPTH, recipeIndex,
    fixedBuyerOffersFor,
    hasNpcSellerInTown: town => { initialise(); return npcSellerTowns.has(town); },
    npcOffersFor: id => npcByItem?.get(Number(id)) || [],
    catalogCounts: () => ({ npcItems: npcByItem?.size || 0,
        npcQuotes: [...(npcByItem?.values() || [])].reduce((sum, rows) => sum + rows.length, 0),
        staticBuyItems: fixedBuy?.size || 0, teleportEdges: Routes.teleportPoints().length, townPairs: townByName?.size || 0 }) };
