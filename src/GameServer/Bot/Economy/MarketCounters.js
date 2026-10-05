// What a bot can know of the board's past (group E, market-sim step 3.3): the
// counters of board purchases, one per sub-kind and grade (gear, shot,
// recipe, material x none..s: 24 numbers per world, +1 per deal), and the
// last deal prices of each item. The main thread counts every board deal
// (AfkTradeService) and replays the journal at start; the cold worker reads
// the same numbers from the 'market' table (ColdTableChannel). Static code
// otherwise: the counter of an item is a lookup built once.
//
// A counter holds: deals (all of them), the buyers per hour (an exponential
// rate over the last hour of uptime), the market index (the mean log of the
// deal price over the item's first price, the last ~32 deals), and its
// hourly move (how much the index changes in an hour of uptime). Each counter
// also keeps its buyers per hour in each town where it had deals (б7: the
// shop town, MarketTownPolicy.shopTown).
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Uptime = require('../Population/Uptime');
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');

const HOUR_MS = 60 * 60 * 1000;
const PRICES_KEPT = 21;
const INDEX_DEALS = 32;
const GRADE_IN_NAME = /(?:^|[\s:])(D|C|B|A|S)(?:[- ]?Grade|\b)/i;
// The starting hourly move of a counter no deal has measured yet: the median
// hourly move over the counters of the group E journal (e17, 44 h).
const STARTING_MOVE = 0.05;
const COUNTER_KEYS = Object.freeze(['gear', 'shot', 'recipe', 'material']
    .flatMap((kind) => ['none', 'd', 'c', 'b', 'a', 's'].map((grade) => `${kind} ${grade}`)));

let spotsSource = () => [];
const counterCache = new Map();
const counters = new Map();
const items = new Map();
// counter key -> town -> { rate, at }: the buyers per hour of the counter in
// each town (б7, the shop town), the same exponential rate as the counter's.
const towns = new Map();
let mirror = null;
let channel = null;

function template(selfId) {
    return ItemTemplateIndex.find(DataCache.items, Number(selfId)) || null;
}

function gradeInName(name) {
    const found = String(name || '').match(GRADE_IN_NAME);
    return found ? found[1].toLowerCase() : 'none';
}

// The grade of a recipe's product: its own rank, else the grade in its name (shots).
function productGrade(productId) {
    const product = template(productId);
    return String(product?.etc?.rank || gradeInName(product?.template?.name) || 'none').toLowerCase();
}

// The author's rule for parts (MarketTownPolicy): a material used only by
// products of one grade is of that grade; one shared by several grades has
// none. selfId -> Set of product grades, built once.
let productGradesByMaterial = null;
function partGrade(selfId) {
    if (!productGradesByMaterial) {
        productGradesByMaterial = new Map();
        for (const recipe of Object.values(C4RecipeItems.loadRecipeItems())) {
            const grade = productGrade(recipe.productId);
            for (const material of recipe.materials || []) {
                const id = Number(material.selfId);
                if (!productGradesByMaterial.has(id)) productGradesByMaterial.set(id, new Set());
                productGradesByMaterial.get(id).add(grade);
            }
        }
    }
    const grades = productGradesByMaterial.get(Number(selfId));
    return grades?.size === 1 ? [...grades][0] : 'none';
}

// The one static classifier of an item (E47): its counter 'kind grade', as
// 'gear d', 'shot d', 'recipe c', 'material b'. The market counters and the
// shop town (MarketTownPolicy) read it.
function counterOf(selfId) {
    const id = Number(selfId);
    const cached = counterCache.get(id);
    if (cached) return cached;
    const item = template(id);
    const kind = String(item?.template?.kind || '');
    let key;
    if (item?.etc?.slot !== undefined) key = `gear ${String(item.etc.rank || 'none').toLowerCase()}`;
    else if (kind === 'Other.Shot') key = `shot ${gradeInName(item.template.name)}`;
    else if (kind.startsWith('Other.Recipe') && C4RecipeItems.resolve(id)) {
        key = `recipe ${productGrade(C4RecipeItems.resolve(id).productId)}`;
    } else {
        const named = /^(Crystal|Gemstone)/.test(String(item?.template?.name || '')) ? gradeInName(item.template.name) : 'none';
        key = `material ${named === 'none' && kind.startsWith('Other.Material') ? partGrade(id) : named}`;
    }
    if (!/ (none|d|c|b|a|s)$/.test(key)) key = `${key.split(' ')[0]} none`;
    counterCache.set(id, key);
    return key;
}

// The grade part of an item's counter: 'none', 'd'..'s'.
function gradeOf(selfId) {
    return counterOf(selfId).split(' ')[1];
}

function firstPriceOf(selfId, timestamp) {
    return invoke('GameServer/Bot/Economy/FirstPrice').cachedFirstPrice(selfId, { spots: spotsSource(), timestamp });
}

function counterRow(key, counter) {
    return [`c:${key}`, counter.deals, Math.round(counter.rate * 1000) / 1000, counter.at,
        Math.round(counter.index * 10000) / 10000, counter.indexed ? 1 : 0,
        counter.move === null ? null : Math.round(counter.move * 10000) / 10000];
}

// [key, deals, units per deal, prices..., sellers..., buyers...]: the last
// prices, who sold and who bought at each, oldest first.
function itemRow(selfId, item) {
    return [`i:${selfId}`, item.deals, Math.round(item.units * 100) / 100, ...item.prices, ...item.sellers, ...item.buyers];
}

// [key, town, rate, at, town, rate, at, ...]: the counter's buyers per town.
function townRow(key, byTown) {
    const row = [`t:${key}`];
    for (const [town, value] of byTown) row.push(town, Math.round(value.rate * 1000) / 1000, value.at);
    return row;
}

function countTown(key, town, timestamp) {
    let byTown = towns.get(key);
    if (!byTown) {
        byTown = new Map();
        towns.set(key, byTown);
    }
    const kept = byTown.get(town) || { rate: 0, at: timestamp };
    byTown.set(town, { rate: kept.rate * Math.exp(-Uptime.between(kept.at, timestamp) / HOUR_MS) + 1, at: timestamp });
    return byTown;
}

// One board deal: +1 on its counter (and on its town, where the deal was
// made) and the item's price list.
function deal(selfId, unitPrice, quantity, timestamp = Date.now(), sellerId = 0, town = null, buyerId = 0) {
    const id = Number(selfId);
    const price = Number(unitPrice);
    if (!id || id === 57 || !(price > 0) || !(Number(quantity) > 0)) return;
    const key = counterOf(id);
    let counter = counters.get(key);
    if (!counter) {
        counter = { deals: 0, rate: 0, at: timestamp, index: 0, indexed: false, move: null, hourAt: 0, hourIndex: 0 };
        counters.set(key, counter);
    }
    counter.rate = counter.rate * Math.exp(-Uptime.between(counter.at, timestamp) / HOUR_MS) + 1;
    counter.at = timestamp;
    counter.deals += 1;
    const first = firstPriceOf(id, timestamp);
    if (first > 0) {
        const value = Math.log(price / first);
        counter.index = counter.indexed ? counter.index + (value - counter.index) / INDEX_DEALS : value;
        counter.indexed = true;
        if (!counter.hourAt) {
            counter.hourAt = timestamp;
            counter.hourIndex = counter.index;
        } else if (Uptime.between(counter.hourAt, timestamp) >= HOUR_MS) {
            const hours = Uptime.between(counter.hourAt, timestamp) / HOUR_MS;
            const step = Math.abs(counter.index - counter.hourIndex) / hours;
            counter.move = counter.move === null ? step : (counter.move + step) / 2;
            counter.hourAt = timestamp;
            counter.hourIndex = counter.index;
        }
    }
    let item = items.get(id);
    if (!item) {
        item = { deals: 0, units: Number(quantity), prices: [], sellers: [], buyers: [] };
        items.set(id, item);
    }
    item.deals += 1;
    item.units += (Number(quantity) - item.units) / INDEX_DEALS;
    item.prices.push(price);
    item.sellers.push(Number(sellerId) || 0);
    item.buyers.push(Number(buyerId) || 0);
    if (item.prices.length > PRICES_KEPT) {
        item.prices.shift();
        item.sellers.shift();
        item.buyers.shift();
    }
    const byTown = town ? countTown(key, String(town), timestamp) : null;
    if (channel) {
        channel.changed('market', counterRow(key, counter));
        channel.changed('market', itemRow(id, item));
        if (byTown) channel.changed('market', townRow(key, byTown));
    }
}

// The journal of the last day at start (oldest first): the same deals again.
function load(rows = []) {
    for (const row of rows) {
        deal(row.selfId, row.unitPrice, row.quantity, Number(row.occurredAt), row.sellerCharacterId, row.town || null,
            row.buyerCharacterId);
    }
    return rows.length;
}

// A counter as its readers see it at `timestamp`: buyers per hour now,
// deals so far, the index (null before a first price) and the hourly move.
function counter(key, timestamp = Date.now()) {
    let deals = 0;
    let rate = 0;
    let at = timestamp;
    let index = null;
    let move = null;
    const row = mirror ? mirror().get(`c:${key}`) : null;
    const kept = mirror ? null : counters.get(key);
    if (row) {
        deals = row[1];
        rate = row[2];
        at = row[3];
        index = row[5] ? row[4] : null;
        move = row[6] ?? null;
    } else if (kept) {
        deals = kept.deals;
        rate = kept.rate;
        at = kept.at;
        index = kept.indexed ? kept.index : null;
        move = kept.move;
    }
    const perHour = rate * Math.exp(-Uptime.between(at, timestamp) / HOUR_MS);
    return { key, deals, perHour, index, move };
}

// The hourly move of a counter: its own, else the mean of the counters that
// have one, else the starting value.
function moveOf(key, timestamp = Date.now()) {
    const own = counter(key, timestamp).move;
    if (own !== null) return own;
    let sum = 0;
    let count = 0;
    for (const other of COUNTER_KEYS) {
        const move = counter(other, timestamp).move;
        if (move === null) continue;
        sum += move;
        count += 1;
    }
    return count ? sum / count : STARTING_MOVE;
}

// The buyers per hour of a counter in each town at `timestamp`: [{ town,
// perHour }], the towns where it has had deals.
function townDemand(key, timestamp = Date.now()) {
    const result = [];
    if (mirror) {
        const row = mirror().get(`t:${key}`);
        for (let at = 1; row && at + 2 < row.length; at += 3) {
            result.push({ town: row[at], perHour: row[at + 1] * Math.exp(-Uptime.between(row[at + 2], timestamp) / HOUR_MS) });
        }
        return result;
    }
    for (const [town, value] of towns.get(key) || []) {
        result.push({ town, perHour: value.rate * Math.exp(-Uptime.between(value.at, timestamp) / HOUR_MS) });
    }
    return result;
}

// The item's deals so far, the units a deal takes on average and its last
// prices with their sellers and buyers, oldest first.
const NO_DEALS = Object.freeze({ deals: 0, units: 1, prices: Object.freeze([]), sellers: Object.freeze([]),
    buyers: Object.freeze([]) });
function itemDeals(selfId) {
    const id = Number(selfId);
    if (mirror) {
        const row = mirror().get(`i:${id}`);
        if (!row) return NO_DEALS;
        const kept = (row.length - 3) / 3;
        return { deals: row[1], units: row[2], prices: row.slice(3, 3 + kept), sellers: row.slice(3 + kept, 3 + 2 * kept),
            buyers: row.slice(3 + 2 * kept) };
    }
    const item = items.get(id);
    return item ? { deals: item.deals, units: item.units, prices: item.prices, sellers: item.sellers, buyers: item.buyers }
        : NO_DEALS;
}

function firstPrice(selfId, timestamp = Date.now()) {
    return firstPriceOf(selfId, timestamp);
}

// Main thread: the counters go to the workers as the 'market' table.
function publish(tableChannel) {
    channel = tableChannel;
    channel.register('market', {
        key: (row) => row[0],
        allRows: () => [
            ...[...counters].map(([key, value]) => counterRow(key, value)),
            ...[...items].map(([id, value]) => itemRow(id, value)),
            ...[...towns].map(([key, value]) => townRow(key, value))
        ]
    });
}

// Worker: the rows of its 'market' table (a Map), read when asked.
function useTable(rows) {
    mirror = rows;
}

// Where the spots for first prices come from in this thread.
function useSpots(source) {
    spotsSource = source || (() => []);
}

function reset() {
    counters.clear();
    items.clear();
    towns.clear();
    mirror = null;
}

module.exports = { STARTING_MOVE, COUNTER_KEYS, counterOf, gradeOf, deal, load, counter, moveOf, itemDeals, townDemand, firstPrice,
    publish, useTable, useSpots, reset };
