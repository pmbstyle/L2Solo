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
// hourly move (how much the index changes in an hour of uptime).
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
let mirror = null;
let channel = null;

function template(selfId) {
    return ItemTemplateIndex.find(DataCache.items, Number(selfId)) || null;
}

function gradeInName(name) {
    const found = String(name || '').match(GRADE_IN_NAME);
    return found ? found[1].toLowerCase() : 'none';
}

// The counter of an item: 'gear d', 'shot none', 'recipe c', 'material b'.
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
        const product = template(C4RecipeItems.resolve(id).productId);
        const rank = product?.etc?.rank || gradeInName(product?.template?.name);
        key = `recipe ${String(rank || 'none').toLowerCase()}`;
    } else key = `material ${/^(Crystal|Gemstone)/.test(String(item?.template?.name || '')) ? gradeInName(item.template.name) : 'none'}`;
    if (!/ (none|d|c|b|a|s)$/.test(key)) key = `${key.split(' ')[0]} none`;
    counterCache.set(id, key);
    return key;
}

function firstPriceOf(selfId, timestamp) {
    return invoke('GameServer/Bot/Economy/FirstPrice').cachedFirstPrice(selfId, { spots: spotsSource(), timestamp });
}

function counterRow(key, counter) {
    return [`c:${key}`, counter.deals, Math.round(counter.rate * 1000) / 1000, counter.at,
        Math.round(counter.index * 10000) / 10000, counter.indexed ? 1 : 0,
        counter.move === null ? null : Math.round(counter.move * 10000) / 10000];
}

function itemRow(selfId, item) {
    return [`i:${selfId}`, item.deals, ...item.prices];
}

// One board deal: +1 on its counter and the item's price list.
function deal(selfId, unitPrice, quantity, timestamp = Date.now()) {
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
        item = { deals: 0, prices: [] };
        items.set(id, item);
    }
    item.deals += 1;
    item.prices.push(price);
    if (item.prices.length > PRICES_KEPT) item.prices.shift();
    if (channel) {
        channel.changed('market', counterRow(key, counter));
        channel.changed('market', itemRow(id, item));
    }
}

// The journal of the last day at start (oldest first): the same deals again.
function load(rows = []) {
    for (const row of rows) deal(row.selfId, row.unitPrice, row.quantity, Number(row.occurredAt));
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

// The item's deals so far and its last prices, oldest first.
function itemDeals(selfId) {
    const id = Number(selfId);
    if (mirror) {
        const row = mirror().get(`i:${id}`);
        return row ? { deals: row[1], prices: row.slice(2) } : { deals: 0, prices: [] };
    }
    const item = items.get(id);
    return item ? { deals: item.deals, prices: item.prices } : { deals: 0, prices: [] };
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
            ...[...items].map(([id, value]) => itemRow(id, value))
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
    mirror = null;
}

module.exports = { STARTING_MOVE, COUNTER_KEYS, counterOf, deal, load, counter, moveOf, itemDeals, firstPrice, publish, useTable,
    useSpots, reset };
