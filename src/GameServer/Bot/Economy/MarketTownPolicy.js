const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const TownRespawn = require('../../World/TownRespawn');
const OfferOrder = require('./OfferOrder');
const Karma = require('../../Karma');
const TripPayment = require('../Travel/TripPayment');
// A sale town whose gatekeeper fee the bot's money cannot cover is dropped.
const fareShort = (fees, state) => TripPayment.fareShort('sale_town', fees, require('./PurchaseFunding').budget(state));

const GLUDIO_D_GRADE_SHARE_PERCENT = 15;

// The starter villages and the captured plaza centre their market travel goes to.
const NO_GRADE_MARKETS = Object.freeze(['Talking Island', 'Elven Village', 'Dark Elven Village', 'Orc Village', 'Dwarven Village']
    .map((name) => ({ name, ...ShopPlaces.PLAZAS[name].travelCenter, radius: 12000 })));

// Markets outside TownPathfinder's geodata atlas still have their real town
// centre. Travel and board ads use it; a shop uses its captured polygon.
function marketTown(name) {
    const market = NO_GRADE_MARKETS.find((candidate) => candidate.name === name);
    if (market) return {
        name: market.name,
        center: { locX: market.locX, locY: market.locY, locZ: market.locZ || 0 }
    };
    const plaza = ShopPlaces.PLAZAS[name];
    if (plaza) return { name, center: { ...(plaza.center || ShopPlaces.fillCenter(name)), locZ: plaza.locZ } };
    const town = Object.values(TownRespawn.towns).find((candidate) => candidate.name === name);
    return town ? { name, center: { locX: town.locX, locY: town.locY, locZ: town.locZ } } : null;
}

function nearestNoGradeMarket(loc = {}) {
    const x = Number(loc.locX || 0);
    const y = Number(loc.locY || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
    return NO_GRADE_MARKETS
        .map((market) => ({ ...market, distance: Math.hypot(x - market.locX, y - market.locY) }))
        .sort((a, b) => a.distance - b.distance)[0] || null;
}

// The grade of an item by the one static classifier (E47,
// MarketCounters.counterOf); a row without an item id keeps its own rank.
function rankOf(item) {
    if (Number(item?.selfId) > 0) return MarketCounters.gradeOf(item.selfId);
    return String(item?.rank || 'none').toLowerCase();
}

function dGradeMarketFor(state = {}) {
    // Gludio's compact D plaza holds roughly one hundred shops once its
    // permanent merchants are reserved.  Dion receives the overflow through
    // a stable character-id split, so bots do not oscillate between towns.
    const bucket = Math.abs(Number(state.characterId || 0)) % 100;
    return bucket < GLUDIO_D_GRADE_SHARE_PERCENT ? 'Gludio' : 'Dion';
}

function targetTownForItems(state, items = [], options = {}) {
    // A bot with karma trades in Floran (design 5.8, E48).
    if (Karma.closesTowns(state?.stats?.karma)) return Karma.TOWN_NAME;
    const ranks = items.map(rankOf);
    const hasHigherGrade = ranks.some((rank) => ['c', 'b', 'a', 's'].includes(rank));
    const hasDGrade = ranks.includes('d');
    const onlyNoGrade = ranks.length > 0 && ranks.every((rank) => rank === 'none');
    // No-grade stock belongs to the starter village nearest the bot's actual
    // farming location. Early hunting routes legitimately extend beyond a
    // village's immediate square, so a small-radius check funnels Elven,
    // Dark Elven, and Talking Island sellers into Giran incorrectly.
    // The farming location is the centre of the hunting spot: the bot's own
    // position wanders across village areas while it hunts, and following it
    // moved a listed shop between villages on nearly every review.
    if (onlyNoGrade) {
        const origin = OfferOrder.farmingOrigin(state, options.findSpot || ((spotId) => SpotService.findById(spotId)));
        return nearestNoGradeMarket(origin)?.name || 'Giran';
    }
    if (!hasHigherGrade && hasDGrade) return dGradeMarketFor(state);
    return 'Giran';
}

// One bounded town choice over the actual offered stock. Category counters
// are not item demand. Unsupported forecasts retain the grade prior; they
// cannot multiply the lot's asking value into imaginary receipts.
function* chooseTown(state, items = [], options = {}) {
    const { context: ctx = null, timestamp = Date.now(), rollKey = null, findSpot = null,
        prepareTrip = null, canOpenTown = () => true } = options;
    const towns = ShopPlaces.SHOP_TOWNS, groups = new Map();
    for (const item of items.slice(0, 8)) {
        const id = Number(item.selfId), enchant = Number(item.enchant || 0), count = Number(item.count), price = Number(item.price);
        if (!Number.isSafeInteger(count) || count <= 0 || !(price > 0) || !Number.isFinite(price)) continue;
        const key = `${id}:${enchant}`, previous = groups.get(key);
        if (previous) { previous.units += count; previous.joint &&= previous.price === price; }
        else groups.set(key, { id, enchant, units: count, price, joint: true });
        yield 'stock';
    }
    const seed = targetTownForItems(state, items, { findSpot });
    const trip = options.tripCost || ctx?.travel || invoke('GameServer/Bot/Economy/ColdMarketService').tripFrom(state, timestamp);
    const candidates = [], outcomes = [];
    let fallbackRoute = null;
    const Price = invoke('GameServer/Bot/Economy/PriceDecision');
    const Valuation = require('./EconomicValuation');
    if (!Karma.closesTowns(state?.stats?.karma) && ctx?.demandFor && groups.size && ctx.ownStock?.known !== false) {
        for (const town of towns) {
            if (!canOpenTown(town)) continue;
            let known = true, receipts = 0, residual = 0, input = 0;
            for (const row of groups.values()) {
                const demand = ctx.demandFor(row.id, row.enchant, town);
                const held = ctx.ownStock?.groups?.get(`${row.id}:${row.enchant}`);
                if (!row.joint || held?.prices?.size > 1 || demand?.known === false || !demand?.origin
                    || demand.origin === 'public_bid' || !demand.authority || demand.town !== town
                    || Number(demand.selfId) !== row.id || Number(demand.enchant || 0) !== row.enchant
                    || !(demand.availability?.from <= timestamp && demand.availability?.until >= timestamp)
                    || !Number.isFinite(demand.applicableUnits) || !Number.isFinite(demand.willingUnits)
                    || !Number.isFinite(demand.delayHours)) { known = false; break; }
                let cheaper = 0, seen = 0;
                const lines = ctx.board?.lines?.(row.id, 1, town) || ctx.board?.list(row.id, 1, town) || [];
                for (const line of lines) {
                    if (++seen > 20) { known = false; break; }
                    if (!line.town) { known = false; break; }
                    if (Number(line.ownerId) !== Number(state.characterId) && Number(line.enchant || 0) === row.enchant
                        && Number(line.price) < row.price) cheaper += Number(line.count);
                    yield 'quote';
                }
                if (!known) break;
                const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, row.id);
                const npc = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Number(template?.template?.price || 0));
                const units = Math.min(row.units, held?.units ?? row.units);
                const outcome = Price.saleOutcome({ units, applicableUnits: demand.applicableUnits,
                    willingUnits: demand.willingUnits, cheaperUnits: cheaper, price: row.price, residualUnitValue: npc,
                    delayHours: demand.delayHours, discountRate: Number(ctx.trader?.wait || 0) });
                if (!outcome.known) { known = false; break; }
                receipts += outcome.receipts; residual += outcome.residualValue; input += units * npc;
                yield 'utility';
            }
            if (!known) continue;
            if (prepareTrip) yield* prepareTrip(town);
            const route = ctx.travelDetails?.(town);
            if (!route?.known || fareShort(route.fees, state)) continue;
            const value = Valuation.opportunity({ moneyPrice: ctx.moneyPrice }, [{ probability: 1,
                receipts, monetaryResidual: residual, ownInputOpportunityValue: input,
                actualCashFees: route.fees, foregoneBenefitHours: route.hours, cycleHours: route.hours }]);
            if (value.known) {
                outcomes.push({ action: town, value: value.valueHours, tripHours: route.hours, tripFees: route.fees });
                if (value.valueHours > 0) candidates.push({ action: town, value: value.valueHours });
            }
            yield 'candidate';
        }
    }
    const key = rollKey || ['shop_town', Number(state?.characterId || 0), timestamp];
    let town = candidates.length ? Price.chooseByWeight(candidates, key)?.action : null;
    let reason = town ? 'supported_item_forecast' : 'grade_fallback';
    if (!town) {
        // A known losing opportunity does not become a grade-based sale.
        if (outcomes.some(row => row.action === seed && row.value <= 0)) reason = 'known_town_loss';
        else if (canOpenTown(seed)) {
            if (prepareTrip) yield* prepareTrip(seed);
            const route = ctx?.travelDetails?.(seed) || trip.details?.(seed);
            if (Number.isFinite(trip(seed)) && (!route || route.known
                && !fareShort(route.fees, state))) { town = seed; fallbackRoute = route; }
        } else {
            const alternatives = [];
            for (const candidate of towns) {
                if (!canOpenTown(candidate) || Karma.closesTowns(state?.stats?.karma) && candidate !== Karma.TOWN_NAME) continue;
                if (prepareTrip) yield* prepareTrip(candidate);
                const cost = trip(candidate);
                const route = ctx?.travelDetails?.(candidate) || trip.details?.(candidate);
                if (Number.isFinite(cost) && (!route || route.known && !fareShort(route.fees, state)))
                    alternatives.push({ action: candidate, value: -cost, route });
                yield 'candidate';
            }
            const chosen = Price.chooseByWeight(alternatives, key);
            town = chosen?.action || null; fallbackRoute = chosen?.route || null;
            reason = 'observed_plaza_full';
        }
    }
    if (options.onDecision) {
        const selected = outcomes.find(row => row.action === town);
        options.onDecision({ town, reason, tripHours: selected?.tripHours ?? fallbackRoute?.hours,
            tripFees: selected?.tripFees ?? fallbackRoute?.fees, candidates: outcomes.sort((a, b) => b.value - a.value).slice(0, 3) });
    }
    return { town, reason };
}
function shopTown(state, items = [], options = {}) {
    const iterator = chooseTown(state, items, options);
    let next; do { next = iterator.next(); } while (!next.done);
    return next.value.town;
}

// The town a bot without a shop opens one in: the decision it already made
// (stats.shopTown, kept until it is back on its spot) or a new roll
// (shopTown). Returns { town, shopTown } with shopTown the decision to keep
// when one was made now.
function openingTown(state, items, timestamp = Date.now()) {
    if (state?.stats?.shopTown?.town) return { town: state.stats.shopTown.town, shopTown: null };
    const town = shopTown(state, items, { timestamp });
    return { town, shopTown: { town, at: timestamp } };
}

// Where a bot's sale trip goes: the town of a buyer bidding on its bag (the
// static and buy-ad buyers, until step 3.6); else the town of its shop, which
// never moves (N51, E46); else the town its shop will open in (openingTown).
function saleTown(state, timestamp = Date.now()) {
    if (Karma.closesTowns(state?.stats?.karma)) return { town: Karma.TOWN_NAME, shopTown: null };
    const buyerTown = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService').bestTownFor(state)?.town
        || invoke('GameServer/Bot/Economy/StaticBuyerService').bestTownFor(state)?.town;
    if (buyerTown) return { town: buyerTown, shopTown: null };
    const shop = invoke('GameServer/AfkTrade/AfkTradeService').findOwnerProjection(state?.characterId)?.shop;
    if (shop?.town) return { town: shop.town, shopTown: null };
    return openingTown(state, ItemDisposition.saleCandidates(state), timestamp);
}

function targetTownForSale(state) {
    return saleTown(state).town;
}

module.exports = {
    GLUDIO_D_GRADE_SHARE_PERCENT,
    NO_GRADE_MARKETS,
    dGradeMarketFor,
    marketTown,
    nearestNoGradeMarket,
    openingTown,
    saleTown,
    shopTown,
    chooseTown,
    targetTownForItems,
    targetTownForSale
};
