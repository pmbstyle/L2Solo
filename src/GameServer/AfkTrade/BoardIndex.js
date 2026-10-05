// The board's offer index (б8), one module for the main thread and the
// background workers: every line of every record with stock, by side (sell
// or buy), item and town, each list sorted best first. The main thread feeds
// it from its records (AfkTradeService), a worker from its 'board' table
// (ColdTableChannel rows, rowOf/recordOf below). A change of one record
// removes and inserts its lines by binary search: O(L (log n + n)), n the
// lines of one item in one town (or on the whole board, for the list of
// every town). A reader walks a list from its head and stops at the first
// line it accepts; an owner is skipped, never copied out.
//
// Order of a side's list: the better price first (cheaper for a sell line,
// higher for a buy line); at the same price a player's line before a bot's;
// then the record id and the line id, so equal lines keep a stable order.
const SELL = 1;
const BUY = 3;
const EMPTY = Object.freeze([]);

function compareLines(left, right) {
    const price = left.storeType === BUY ? right.price - left.price : left.price - right.price;
    return price
        || Number(left.botOwned) - Number(right.botOwned)
        || left.recordId - right.recordId
        || left.lineId - right.lineId;
}

// The first position whose line does not come before `line`.
function position(list, line) {
    let low = 0;
    let high = list.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (compareLines(list[middle], line) < 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

function insert(list, line) {
    list.splice(position(list, line), 0, line);
}

function removeFrom(list, line) {
    const at = position(list, line);
    if (list[at] === line) list.splice(at, 1);
}

// A record as the table carries it: [id, kind, storeType, ownerId, town,
// botOwned, lines[[lineId, selfId, enchant, count, price, pricing, fills]], revision], lines with stock
// only. `record` has the main thread's fields (AfkTradeService projectionStore
// or a database record).
function rowOf(record) {
    const lines = [];
    for (const line of record.lines || record.items || []) {
        const count = Number(line.count);
        if (!(count > 0)) continue;
        lines.push([Number(line.afkTradeLineId ?? line.id), Number(line.selfId), Number(line.enchant || 0), count,
            Number(line.price), line.pricing || null, Number(line.fills || 0)]);
    }
    return [Number(record.shopId ?? record.id), String(record.kind || 'shop'), Number(record.storeType),
        Number(record.ownerId), record.town || null, record.botOwned === true ? 1 : 0, lines,
        Number(record.revision ?? record.afkTradeRevision) || null];
}

function recordOf(row) {
    return {
        id: Number(row[0]), kind: row[1], storeType: Number(row[2]), ownerId: Number(row[3]), town: row[4] || null,
        botOwned: row[5] === 1 || row[5] === true,
        revision: row[7] ?? null,
        lines: (row[6] || []).map(([lineId, selfId, enchant, count, price, pricing, fills]) => ({ lineId, selfId, enchant,
            count, price, ...(pricing ? { pricing } : {}), fills: Number(fills || 0) }))
    };
}

// A line as an offer of the board, the fields every thread reads; the main
// thread adds the record's store and stall (AfkTradeService).
function offerFields(line, town = null) {
    const selling = line.storeType === SELL;
    return {
        sourceType: selling
            ? (line.botOwned ? 'afk_bot_store' : 'afk_player_store')
            : (line.botOwned ? 'afk_bot_buy_store' : 'afk_player_buy_store'),
        sourceId: line.ownerId,
        sellerKind: line.botOwned ? 'bot' : 'player',
        playerPriority: !line.botOwned,
        town: line.town || town,
        recordKind: line.kind,
        recordId: line.recordId,
        expectedRevision: line.revision,
        lineId: line.lineId,
        selfId: line.selfId,
        price: line.price,
        count: line.count,
        enchant: line.enchant,
        available: true
    };
}

class BoardIndex {
    // groupOf(selfId): the group of an item whose open sell lines are counted
    // (the market counters, MarketCounters.counterOf); none by default.
    constructor({ groupOf = null } = {}) {
        // storeType -> itemId -> { all: [line], towns: Map(town -> [line]) }
        this.sides = new Map([[SELL, new Map()], [BUY, new Map()]]);
        // record id -> its indexed lines
        this.records = new Map();
        // owner id -> its record ids
        this.owners = new Map();
        this.groupOf = groupOf;
        // group -> open sell lines
        this.groupLines = new Map();
        // counter -> priced bot owner -> number of surviving lines, on both sides
        this.counterOwners = new Map();
    }

    clear() {
        this.sides.forEach((items) => items.clear());
        this.records.clear();
        this.owners.clear();
        this.groupLines.clear();
        this.counterOwners.clear();
    }

    countGroup(line, step) {
        if (!this.groupOf || line.storeType !== SELL) return;
        const group = this.groupOf(line.selfId);
        this.groupLines.set(group, (this.groupLines.get(group) || 0) + step);
    }

    countPricedOwner(line, step) {
        if (!this.groupOf || !line.botOwned || !line.pricing) return;
        const counter = this.groupOf(line.selfId);
        let owners = this.counterOwners.get(counter);
        if (!owners) {
            if (step < 0) return;
            owners = new Map();
            this.counterOwners.set(counter, owners);
        }
        const count = (owners.get(line.ownerId) || 0) + step;
        if (count > 0) owners.set(line.ownerId, count);
        else owners.delete(line.ownerId);
        if (!owners.size) this.counterOwners.delete(counter);
    }

    // record: { id, kind, storeType, ownerId, town, botOwned, lines: [{ lineId,
    // selfId, enchant, count, price }] }; `ref` is what the caller wants back
    // with each line (the main thread's board entry). Replaces the record.
    put(record, ref = null) {
        const id = Number(record.id);
        this.remove(id);
        const storeType = Number(record.storeType);
        const items = this.sides.get(storeType);
        if (!items) return;
        const indexed = [];
        for (const source of record.lines || []) {
            const count = Number(source.count);
            const price = Number(source.price);
            if (!(count > 0)) continue;
            const line = {
                recordId: id,
                revision: record.revision ?? null,
                lineId: Number(source.lineId),
                kind: String(record.kind || 'shop'),
                storeType,
                ownerId: Number(record.ownerId),
                town: record.town || null,
                botOwned: record.botOwned === true,
                selfId: Number(source.selfId),
                enchant: Number(source.enchant || 0),
                count,
                price,
                ...(source.pricing ? { pricing: source.pricing } : {}),
                fills: Number(source.fills || 0),
                ref
            };
            let item = items.get(line.selfId);
            if (!item) {
                item = { all: [], towns: new Map() };
                items.set(line.selfId, item);
            }
            let town = item.towns.get(line.town);
            if (!town) {
                town = [];
                item.towns.set(line.town, town);
            }
            insert(item.all, line);
            insert(town, line);
            indexed.push(line);
            this.countGroup(line, 1);
            this.countPricedOwner(line, 1);
        }
        if (!indexed.length) return;
        this.records.set(id, indexed);
        const ownerId = Number(record.ownerId);
        if (!this.owners.has(ownerId)) this.owners.set(ownerId, new Set());
        this.owners.get(ownerId).add(id);
    }

    remove(recordId) {
        const id = Number(recordId);
        const indexed = this.records.get(id);
        if (!indexed) return;
        this.records.delete(id);
        const owned = this.owners.get(indexed[0].ownerId);
        owned?.delete(id);
        if (owned && !owned.size) this.owners.delete(indexed[0].ownerId);
        for (const line of indexed) {
            this.countGroup(line, -1);
            this.countPricedOwner(line, -1);
            const items = this.sides.get(line.storeType);
            const item = items.get(line.selfId);
            if (!item) continue;
            removeFrom(item.all, line);
            const town = item.towns.get(line.town);
            if (town) {
                removeFrom(town, line);
                if (!town.length) item.towns.delete(line.town);
            }
            if (!item.all.length) items.delete(line.selfId);
        }
    }

    // The sorted lines of one item on one side: in `town` (a record without a
    // town counts in every town, as the author's offers did), or every town.
    // The caller must not change the list.
    list(selfId, storeType, town = null) {
        const item = this.sides.get(Number(storeType))?.get(Number(selfId));
        if (!item) return EMPTY;
        if (!town) return item.all;
        const own = item.towns.get(town) || EMPTY;
        const unplaced = item.towns.get(null);
        if (!unplaced?.length) return own;
        const merged = [...own, ...unplaced];
        merged.sort(compareLines);
        return merged;
    }

    // The first line of the list the caller accepts, skipping `excludeOwner`
    // and, when given, lines of another enchant; null when none.
    first(selfId, storeType, { town = null, excludeOwner = 0, enchant = null, accept = null } = {}) {
        for (const line of this.list(selfId, storeType, town)) {
            if (excludeOwner && line.ownerId === Number(excludeOwner)) continue;
            if (enchant !== null && line.enchant !== Number(enchant)) continue;
            if (accept && !accept(line)) continue;
            return line;
        }
        return null;
    }

    // The best line of each town the caller accepts (BoardIndex order), skipping
    // `excludeOwner`: in `towns`, with the records without a town, or in every
    // town. At most one line per town: O(T log n) for a buyer who weighs
    // every town.
    heads(selfId, storeType, { towns = null, excludeOwner = 0, accept = null } = {}) {
        const item = this.sides.get(Number(storeType))?.get(Number(selfId));
        if (!item) return [];
        const keys = towns ? [...new Set([...towns, null])] : [...item.towns.keys()];
        const heads = [];
        for (const key of keys) {
            for (const line of item.towns.get(key) || EMPTY) {
                if (excludeOwner && line.ownerId === Number(excludeOwner)) continue;
                if (accept && !accept(line)) continue;
                heads.push(line);
                break;
            }
        }
        return heads;
    }

    // The items with at least one line on a side.
    selfIds(storeType) {
        return [...(this.sides.get(Number(storeType))?.keys() || [])];
    }

    // The towns with lines of an item on a side (null for unplaced records).
    towns(selfId, storeType) {
        return [...(this.sides.get(Number(storeType))?.get(Number(selfId))?.towns.keys() || [])];
    }

    get size() {
        return this.records.size;
    }

    // The lines of an owner's records with stock, as indexed: O(its lines).
    ownerLines(ownerId) {
        const lines = [];
        for (const id of this.owners.get(Number(ownerId)) || []) lines.push(...this.records.get(id));
        return lines;
    }

    // The open sell lines of a group (see groupOf).
    linesIn(group) {
        return this.groupLines.get(group) || 0;
    }

    // Unique bot owners with priced, stocked lines of this counter, SELL or
    // BUY. A readonly iterator, so waking a counter costs O(affected owners).
    ownersForCounter(counter) {
        return this.counterOwners.get(counter)?.keys() || EMPTY;
    }

    // A worker's index follows its 'board' table (TableMirror.watch): every
    // row as it arrives, nothing rebuilt.
    follower() {
        return {
            reset: () => this.clear(),
            put: (_key, row) => this.put(recordOf(row)),
            remove: (key) => this.remove(key)
        };
    }
}

module.exports = { BoardIndex, SELL, BUY, compareLines, offerFields, rowOf, recordOf };
