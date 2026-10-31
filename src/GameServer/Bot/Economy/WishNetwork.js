const { isMainThread } = require('node:worker_threads');
const Tendency = require('../AI/TendencyRoll');
const Valuation = require('./EconomicValuation');
const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('./EconomyDiagnostics');
const { packetRowWishes } = require('./PurchaseFunding');
const Bytes = require('./CompactBytes');
const NEEDS = Object.freeze(['power', 'status', 'care', 'scores']);
const MAX_NODES = 40;
const MAX_ROOTS = 12;
// B craft -> C crystals -> Luxury C item -> D crystals -> NPC D input.
// The existing forty-node budget still bounds the complete graph.
const MAX_DEPTH = 6;
// One attempt of a chosen path keeps at most this many exact outcomes
// (EconomicValuation.OUTCOME_LIMIT); a larger composition is unresolved.
const MAX_BRANCHES = 8;
const nonnegative = value => Math.max(0, Number(value) || 0);
// Native stock questions, before owned children disappear from a plan. Exact
// answers also preserve the prior claims in every subsequent allocation pass.
// This is one build's bounded evidence, never a second allocation or bag index.
// It is held packed (the codec below, ~3-6 B a row); the rows exist only
// while a build records them and while one verdict reads them. The byte cap
// bounds the packed form, the one form that is held, saved and sent.
const QUANTITY_INPUT_LIMIT = 1024;
const QUANTITY_INPUT_BYTES = 8192;
const QUANTITY_SCALARS = new Set(['physical', 'present', 'freePresent', 'incoming', 'free', 'crystalFree']);
const QUANTITY_KINDS = Object.freeze([...QUANTITY_SCALARS, 'stock', 'stockPhysical']);
// Exact transport of the native read list: no rows are merged, inferred or
// discarded. Each id, root and root literal is written once, at its first
// use (an id as the signed delta from the previous new id), and
// as its first-use index after that. Values 0 and 1 live in the row header.
// The saved decision codec treats this owner's bytes opaquely.
function packQuantityInputs(proof) {
    if (proof?.version !== 1 || !Array.isArray(proof.rows) || proof.rows.length > QUANTITY_INPUT_LIMIT) return null;
    try {
        const write = Bytes.writer(), ids = new Map(), roots = new Map(), literals = new Map();
        let lastId = 0;
        const numberTag = value => {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('quantity value');
            return Object.is(value, -0) || !Number.isSafeInteger(value) ? 3 : value <= 1 ? value : 2;
        };
        const number = (value, tag) => {
            if (tag === 2) write.uint(value);
            else if (tag === 3) write.double(value);
        };
        const literal = text => {
            if (literals.has(text)) { write.uint(literals.get(text)); return; }
            write.uint(literals.size); literals.set(text, literals.size); write.text(text);
        };
        write.byte(3); write.uint(proof.rows.length);
        for (const row of proof.rows) {
            if (!Array.isArray(row)) return null;
            const kind = QUANTITY_KINDS.indexOf(row[0]), rooted = kind >= 6;
            if (kind < 0 || row.length !== (kind === 6 ? 5 : kind === 7 ? 4 : 3)) return null;
            const id = row[rooted ? 2 : 1], value = row[rooted ? 3 : 2];
            if (!Number.isSafeInteger(id) || id <= 0 || rooted && typeof row[1] !== 'string') return null;
            const first = numberTag(value), second = kind === 6 ? numberTag(row[4]) : 0, fresh = !ids.has(id);
            write.byte(kind + first * 8 + second * 32 + (fresh ? 128 : 0));
            if (fresh) {
                write.signed(id - lastId);
                ids.set(id, ids.size); lastId = id;
            } else write.uint(ids.get(id));
            if (rooted) {
                const root = row[1];
                if (roots.has(root)) write.uint(roots.get(root));
                else {
                    write.uint(roots.size); roots.set(root, roots.size);
                    // Tag 1: the root embeds this row's own id between two literals.
                    const decimal = String(id), at = root.indexOf(decimal);
                    if (at < 0) { write.byte(0); literal(root); }
                    else { write.byte(1); literal(root.slice(0, at)); literal(root.slice(at + decimal.length)); }
                }
            }
            number(value, first);
            if (kind === 6) number(row[4], second);
        }
        const bytes = write.finish();
        return bytes.length <= QUANTITY_INPUT_BYTES ? bytes : null;
    } catch (_) { return null; }
}
// The one decoder: calls visit(row) for each row in order. False on a
// malformed or over-cap stream, or when visit returns false; a reader
// error inside visit is not a codec refusal and propagates.
function eachQuantityRow(value, visit) {
    if (!(value instanceof Uint8Array) || value.byteLength > QUANTITY_INPUT_BYTES) return false;
    let visiting = false;
    try {
        const read = Bytes.reader(value);
        const number = tag => {
            if (tag <= 1) return tag;
            if (tag === 2) { const result = read.uint(); if (result <= 1) throw Error('quantity integer tag'); return result; }
            const result = read.double();
            if (!Number.isFinite(result) || result < 0 || Number.isSafeInteger(result) && !Object.is(result, -0)) throw Error('quantity value');
            return result;
        };
        const literals = [], seenLiterals = new Set();
        const literal = () => {
            const index = read.uint();
            if (index < literals.length) return literals[index];
            if (index > literals.length) throw Error('quantity literal');
            const text = read.text();
            if (seenLiterals.has(text)) throw Error('quantity literal');
            seenLiterals.add(text); literals.push(text);
            return text;
        };
        if (read.byte() !== 3) return false;
        const count = read.uint();
        if (count > QUANTITY_INPUT_LIMIT) return false;
        const ids = [], seenIds = new Set(), roots = [], seenRoots = new Set();
        let lastId = 0;
        for (let i = 0; i < count; i++) {
            const header = read.byte(), kind = header % 8, first = Math.floor(header / 8) % 4, second = Math.floor(header / 32) % 4;
            if (kind !== 6 && second) return false;
            let id;
            if (header >= 128) {
                id = lastId + read.signed();
                if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) return false;
                seenIds.add(id); ids.push(id); lastId = id;
            } else {
                const index = read.uint();
                if (index >= ids.length) return false;
                id = ids[index];
            }
            let row;
            if (kind >= 6) {
                const index = read.uint();
                if (index > roots.length) return false;
                if (index === roots.length) {
                    const tag = read.byte();
                    if (tag > 1) return false;
                    const text = tag ? literal() + String(id) + literal() : literal();
                    if (seenRoots.has(text) || Buffer.byteLength(text) > QUANTITY_INPUT_BYTES) return false;
                    seenRoots.add(text); roots.push(text);
                }
                row = kind === 6 ? [QUANTITY_KINDS[kind], roots[index], id, number(first), number(second)]
                    : [QUANTITY_KINDS[kind], roots[index], id, number(first)];
            } else row = [QUANTITY_KINDS[kind], id, number(first)];
            visiting = true;
            if (visit(row) === false) return false;
            visiting = false;
        }
        return read.done();
    } catch (error) {
        if (visiting) throw error;
        return false;
    }
}
// The whole list, frozen (tests, inspection). A verdict streams instead.
function unpackQuantityInputs(value) {
    const rows = [];
    if (!eachQuantityRow(value, row => { rows.push(Object.freeze(row)); })) return null;
    return Object.freeze({ version: 1, rows: Object.freeze(rows) });
}
function createQuantityInputs() {
    const rows = [], seen = new Map();
    // invalid: '' or the first reason the proof is void (diagnostics name it).
    let invalid = '', finished = false, packed = null;
    const record = row => {
        if (invalid || finished) return;
        const key = row[0] === 'stock' || row[0] === 'stockPhysical'
            ? `${row[0]}:${row[1]}:${row[2]}` : `${row[0]}:${row[1]}`;
        const previous = seen.get(key);
        if (previous) {
            for (let at = 0; at < row.length; at++) if (previous[at] !== row[at]) invalid ||= 'conflict';
            return;
        }
        if (rows.length >= QUANTITY_INPUT_LIMIT) { invalid = 'rows'; return; }
        seen.set(key, row); rows.push(row);
    };
    const scalar = kind => (id, value) => {
        if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || !Number.isFinite(nonnegative(value))) invalid ||= 'value';
        if (kind === 'incoming' && Number(value || 0) < 0) invalid ||= 'value';
        record([kind, Number(id), kind === 'present' || kind === 'freePresent' ? Number(nonnegative(value) > 0) : nonnegative(value)]);
        return value;
    };
    return {
        stock(id, rootKey, value) {
            if (typeof rootKey !== 'string' || !Number.isSafeInteger(Number(id)) || Number(id) <= 0
                || !Number.isFinite(nonnegative(value?.owned)) || !Number.isFinite(nonnegative(value?.incoming))) invalid ||= 'value';
            record(['stock', String(rootKey), Number(id), nonnegative(value?.owned), nonnegative(value?.incoming)]);
            return value;
        },
        stockPhysical(rootKey, id, value) {
            if (typeof rootKey !== 'string' || !Number.isSafeInteger(Number(id)) || Number(id) <= 0
                || !Number.isFinite(nonnegative(value))) invalid ||= 'value';
            record(['stockPhysical', rootKey, Number(id), nonnegative(value)]);
            return value;
        },
        physical: scalar('physical'), present: scalar('present'), freePresent: scalar('freePresent'),
        incoming: scalar('incoming'), free: scalar('free'), crystalFree: scalar('crystalFree'),
        unsupported() { invalid ||= 'unsupported'; },
        // The packed proof (eachQuantityRow reads it) or null.
        finish() {
            if (!finished) {
                finished = true;
                if (!invalid) packed = packQuantityInputs({ version: 1, rows });
                if (!invalid && !packed) invalid = 'bytes';
                // Diagnostics: why a completed build has no quantity proof.
                if (invalid && Diagnostics.active()) Diagnostics.count('context', 'quantity_invalid', invalid);
                seen.clear(); rows.length = 0;
            }
            return packed;
        }
    };
}
// Whether every row of the packed proof still answers the same; skip(row)
// true leaves a row out. Rows come from the decoder, so their shape and
// values are already valid; a missing reader is never quiet. A moved
// answer pushes 'quantity' to why; false without it is a stream the
// codec refuses (or a missing reader). stockFor gets the row it answers.
function quantityInputsHold(packed, readers, normalizeStock = null, skip = null, why = null) {
    const moved = () => { why?.push('quantity'); return false; };
    return eachQuantityRow(packed, row => {
        if (skip?.(row)) return true;
        if (row[0] === 'stock') {
            if (typeof readers?.stockFor !== 'function') return false;
            const stock = readers.stockFor(row[2], row[1], row);
            const owned = nonnegative(stock?.owned);
            const comparable = normalizeStock ? normalizeStock('stock', row[1], row[2], owned, row[3]) : owned;
            return comparable === row[3] && nonnegative(stock?.incoming) === row[4] || moved();
        }
        if (row[0] === 'stockPhysical') {
            if (typeof readers?.physical !== 'function') return false;
            const owned = nonnegative(readers.physical(row[2]));
            return (normalizeStock ? normalizeStock('stockPhysical', row[1], row[2], owned, row[3]) : owned) === row[3] || moved();
        }
        const read = row[0] === 'present' ? readers?.physical : row[0] === 'freePresent' ? readers?.free : readers?.[row[0]];
        if (typeof read !== 'function') return false;
        const raw = read(row[1]);
        if (row[0] === 'incoming' && (!Number.isFinite(Number(raw || 0)) || Number(raw || 0) < 0)) return moved();
        const value = nonnegative(raw);
        return (row[0] === 'present' || row[0] === 'freePresent' ? Number(value > 0) : value) === row[2] || moved();
    });
}
// Native commands for `batches`: a path without perCommand runs one batch each.
const commands = (batches, perCommand) => Math.ceil(batches / (Number(perCommand) >= 1 ? Number(perCommand) : 1));
// A trip is one row per town: a quoted seller or workshop, or a farm spot
// away from the bot (its hours and fees are paid once, not per unit).
const travels = path => !!path.town && (path.quoted || path.activity === 'hunting');

// The one quantity reader (MVP-3). Accepted incoming is a native obligation:
// it removes the amount to order, not the amount still to deliver.
function remainingQuantity({ required = 0, freePhysical = 0, acceptedIncoming = 0 } = {}) {
    const free = nonnegative(required) - nonnegative(freePhysical);
    return { toOrder: Math.max(0, free - nonnegative(acceptedIncoming)), toExecute: Math.max(0, free) };
}
// A one-way diagnostic loss event for the retained craft's own batch.
// 'unchanged' covers only these necessary inputs, never allocation readiness.
// The caller supplies the same native stock reader as the held allocation.
function craftMaterialLoss(proof, stockFor) {
    if (!proof || typeof stockFor !== 'function' || typeof proof.rootKey !== 'string'
        || !Array.isArray(proof.output) || proof.output.length !== 3
        || !Array.isArray(proof.inputs) || !proof.inputs.length || proof.inputs.length > MAX_NODES) return 'unknown';
    const [itemId, owned, incoming] = proof.output;
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isFinite(owned) || owned < 0
        || !Number.isFinite(incoming) || incoming < 0) return 'unknown';
    const output = stockFor(itemId, proof.rootKey) || {};
    if (nonnegative(output.owned) !== owned || nonnegative(output.incoming) !== incoming) return 'unknown';
    for (const row of proof.inputs) {
        if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] <= 0
            || !Number.isSafeInteger(row[1]) || row[1] <= 0) return 'unknown';
        const stock = stockFor(row[0], proof.rootKey) || {};
        const remaining = remainingQuantity({ required: row[1], freePhysical: stock.owned, acceptedIncoming: stock.incoming });
        if (remaining.toExecute) return 'loss';
    }
    return 'unchanged';
}
// Independent identical batches merged by success count: a multiset of k
// outcomes out of B kinds, C(B + k - 1, k). Two kinds give k + 1.
function mergedBranches(kinds, batches) {
    if (kinds <= 1 || batches <= 0) return 1;
    let total = 1;
    for (let at = 1; at <= batches && total <= MAX_BRANCHES; at++) total = total * (kinds - 1 + at) / at;
    return Math.round(total);
}
// MVP-1: money is held only behind a path with a step now (or awaiting a
// native accepted incoming); an unresolved outcome holds none either.
const fundable = wish => wish.supported !== false && wish.resolved !== false;
// Cash the money queue holds for a wish: a stock root's survival tranche
// is already held by the survival reserve (kitCost), never a second time.
const cashCharge = wish => Math.max(0, nonnegative(wish.price) - nonnegative(wish.reserved));

function choose(rows, weight, roll) {
    if (!rows.length) return null;
    const weights = rows.map(row => nonnegative(weight(row)));
    const total = weights.reduce((a, b) => a + b, 0);
    // Every available alternative retains the shared tendency floor.
    const floor = Tendency.MIN / rows.length;
    let left = roll;
    for (let i = 0; i < rows.length; i++) {
        left -= floor + (1 - Tendency.MIN) * (total > 0 ? weights[i] / total : 1 / rows.length);
        if (left < 0) return rows[i];
    }
    return rows[rows.length - 1];
}

function moneyQueue(wishes, wallet, survivalReserve = 0, floor = 0) {
    let available = Math.max(0, nonnegative(wallet) - nonnegative(survivalReserve));
    const queue = wishes.filter(wish => wish.valueHours > 0 && wish.price > 0)
        .map(wish => {
            const valueHours = wish.progressionPriority > 0 ? Math.max(wish.valueHours, wish.price * floor) : wish.valueHours;
            return { ...wish, valueHours, ratio: valueHours / wish.price };
        })
        .sort((a, b) => nonnegative(b.progressionPriority) - nonnegative(a.progressionPriority)
            || b.ratio - a.ratio || a.key.localeCompare(b.key));
    let moneyPrice = nonnegative(floor), cutoffFound = false, gap = null, awaitingKit = null;
    for (const wish of queue) {
        // An unsupported wish keeps its place and interest, never the money.
        if (!fundable(wish)) {
            wish.funded = false;
            if (wish.progressionPriority > 0 && !awaitingKit) awaitingKit = wish;
            continue;
        }
        // The first gap holds the marginal price of money. Smaller desires
        // do not spend the money earmarked toward that first missing goal.
        wish.funded = !cutoffFound && (wish.progressionPriority > 0 || wish.ratio >= floor) && cashCharge(wish) <= available;
        if (wish.funded) available -= cashCharge(wish);
        else if (!cutoffFound) {
            if (wish.progressionPriority > 0 || wish.ratio >= floor) { moneyPrice = Math.max(floor, wish.ratio); gap = wish; }
            cutoffFound = true;
        }
    }
    return { queue, moneyPrice, available, gap: gap || awaitingKit };
}

// Providers supply game effects and available paths, never policy priorities.
// One bounded DAG serves individual characters and group actors alike. The
// caller owns its event input key and the small saved focus/dormant packet.
// Per-actor results are a cache, not state: memory per bot is budgeted
// (design 16.26). They serve the several readers of one decision (a commit,
// a resolve, a hot tick); a bot's next decision rebuilds the cheap layer
// anyway (new adena, exp), while the expensive one is kept per kit
// (ColdCombatProfile.profileFor). So few are held, least recently used out.
// Only the main thread holds them (its group solve and repeated readers hit).
// The cold worker keeps the result in the held plan (EconomyContext cache,
// 2048 plans), so a second per-actor copy there never hit and only cost
// copies and evictions.
const ACTOR_LIMIT = 64;
const RETAIN_ACTORS = isMainThread;
function remember(map, key, value, limit = ACTOR_LIMIT) {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value);
    return value;
}
// Compare existing bounded results only; no retained diagnostic digest or bot
// history. The input key is deliberately excluded: publication is not a
// changed decision. This traversal is called only with diagnostics active.
function equalValue(left, right, depth = 0) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    // Native wish data is bounded by four requirement levels. Opaque custom
    // object metadata must never make diagnostics recurse without a limit.
    if (depth > 16) return false;
    if (left instanceof Map || right instanceof Map) {
        if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) return false;
        for (const [key, value] of left) if (!right.has(key) || !equalValue(value, right.get(key), depth + 1)) return false;
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!(Array.isArray(left) && Array.isArray(right)) || left.length !== right.length) return false;
        for (let at = 0; at < left.length; at++) if (!equalValue(left[at], right[at], depth + 1)) return false;
        return true;
    }
    for (const key in left) if (Object.hasOwn(left, key)
        && (!Object.hasOwn(right, key) || !equalValue(left[key], right[key], depth + 1))) return false;
    for (const key in right) if (Object.hasOwn(right, key) && !Object.hasOwn(left, key)) return false;
    return true;
}
function sameResult(before, after) {
    return before.moneyPrice === after.moneyPrice && before.available === after.available
        && before.hourAdena === after.hourAdena && before.decisionSeq === after.decisionSeq
        && before.activityLeaf === after.activityLeaf && equalValue(before.queue, after.queue)
        && equalValue(before.focus, after.focus) && equalValue(before.dormant, after.dormant)
        && equalValue(before.activity, after.activity) && equalValue(before.demands, after.demands)
        && equalValue(before.plans, after.plans);
}
// One solver per node set. build() and the provider's candidate admission
// use the same path facts, quantity reader and root valuation (MVP-6); its
// scratch maps die with the caller's build.
function createSolver({ nodes, hourAdena = 0, riskWeight = 1, stockFor = null, wallet = 0, survivalReserve = 0,
    diagnostic = false, detail = false, trace = null, captureReadyCraft = false }) {
    const byKey = new Map();
    for (const node of nodes) {
        if (typeof node?.key !== 'string' || !node.key || byKey.has(node.key)
            || (node.need && !NEEDS.includes(node.need)) || (node.paths?.length || 0) > 4) {
            throw new TypeError('invalid_wish_node');
        }
        byKey.set(node.key, node);
    }
    const plans = new Map(), ordinaryPlans = new Map(), visiting = new Set();
    const proofPlans = captureReadyCraft ? [] : null;
    // A finite trial may plan a future purchase before a seller appears.
    // Its source choice cannot overwrite ordinary executable-first item
    // plans. These scratch maps are bounded by the graph and depth limit;
    // only the selected root/child plans survive in the bounded result.
    // Each mode keeps at most MAX_DEPTH + 1 plans per node: a shared input
    // can afford a longer source chain when it is nearer the root.
    const producerPlans = new Map();
    const completionPlans = new Map(), producerCompletionPlans = new Map();
    const adenaToHours = hourAdena > 0 ? 1 / hourAdena : Infinity;
    // One route per member and town for the basket. Scratch descriptions
    // die with this build; plans retain bounded entry indices only. Group
    // members visiting the same town do not share each other's paid trips.
    const trips = new Map(), tripRows = [];
    const tripKey = path => `${path.tripScope || ''}|${path.town}`;
    for (const node of nodes) for (const path of node.paths || []) {
        if (travels(path) && !trips.has(tripKey(path))) {
            const row = { index: tripRows.length, fees: nonnegative(path.tripFees), hours: nonnegative(path.tripHours) };
            trips.set(tripKey(path), row); tripRows.push(row);
        }
    }
    const tripValue = (entries, field) => {
        let total = 0;
        for (const index of entries) total += tripRows[index][field];
        return total;
    };
    const tripEffort = entries => {
        const fees = tripValue(entries, 'fees');
        return tripValue(entries, 'hours') + (fees > 0 ? fees * adenaToHours : 0);
    };
    // ownInput: the path's own-input value, or 0 where held units are priced
    // by the allocation instead (no copy of the path per call).
    const priceOf = (path, ownInput = path.ownInputOpportunityValue) => {
        if (!Number.isFinite(adenaToHours)) return nonnegative(path.price)
            + nonnegative(ownInput) + nonnegative(path.actualCashFees) > 0 ? Infinity
            : nonnegative(path.costHours) + nonnegative(path.riskHours) * nonnegative(riskWeight);
        const value = Valuation.opportunity({ moneyPrice: adenaToHours, riskWeight }, [{ probability: 1,
            cashNow: nonnegative(path.price), foregoneBenefitHours: nonnegative(path.costHours),
            ownInputOpportunityValue: nonnegative(ownInput),
            actualCashFees: nonnegative(path.actualCashFees), riskHours: nonnegative(path.riskHours) }]);
        return value.known ? -value.valueHours : Infinity;
    };
    // MVP-2: an attempt is valued until success only when every consumed
    // input has a supported repeatable path; held stock alone is not one.
    const repeatables = new Map();
    const repeatable = key => {
        if (repeatables.has(key)) return repeatables.get(key);
        repeatables.set(key, false);
        const node = byKey.get(key);
        const result = !!node?.paths?.some(path => path.available !== false && path.kind !== 'owned'
            && path.repeatable !== false && path.executable !== false && Number(path.availableUnits ?? Infinity) !== 0
            && (path.grossRequirements || path.requirements || []).every(row => row.once || repeatable(row.key)));
        repeatables.set(key, result);
        return result;
    };
    const solve = (key, depth = 0, requested = 1, allocation = null, planning = false, completionFirst = false, stockFacts = null) => {
        if (visiting.has(key)) throw new TypeError('cyclic_wish_network');
        const node = byKey.get(key);
        if (!node) throw new TypeError('missing_wish_requirement');
        // A source beyond the budget cannot invalidate a shorter alternative
        // (for example buying D gear instead of crafting its raw materials).
        if (depth > MAX_DEPTH) return null;
        const memo = completionFirst ? planning ? producerCompletionPlans : completionPlans : planning ? producerPlans : ordinaryPlans;
        const memoKey = `${depth}:${key}`;
        if (!allocation && memo.has(memoKey)) {
            if (diagnostic) Diagnostics.count('network', 'node_hit', 'same_build');
            return memo.get(memoKey);
        }
        visiting.add(key);
        const itemId = key.startsWith('item:') ? Number(key.slice(5)) : 0;
        let amount = requested, ownValue = 0, incomingHeld = 0, outputStock = null;
        if (allocation && itemId) {
            const stock = stockFor(itemId, allocation.rootKey) || {};
            const prior = allocation.used.get(itemId) || 0;
            const remaining = remainingQuantity({ required: requested,
                freePhysical: Math.max(0, nonnegative(stock.owned) - prior),
                acceptedIncoming: Math.max(0, nonnegative(stock.incoming) - Math.max(0, prior - nonnegative(stock.owned))) });
            // Optional diagnostic facts come from this exact native subtraction,
            // before an owned child disappears from the selected requirements.
            if (stockFacts) stockFacts.push([itemId, requested, prior, remaining.toOrder, remaining.toExecute]);
            if (captureReadyCraft && depth === 1) outputStock = [itemId, nonnegative(stock.owned), nonnegative(stock.incoming)];
            const owned = requested - remaining.toExecute;
            incomingHeld = remaining.toExecute - remaining.toOrder;
            amount = remaining.toOrder;
            // Held units are worth their exit value (Q1 A); nodes built
            // without that reader (groups, clan) keep their own price.
            ownValue = owned * nonnegative(Number.isFinite(node.exitValue) ? node.exitValue : node.price);
            allocation.used.set(itemId, prior + owned + incomingHeld);
            if (!amount) {
                visiting.delete(key);
                return { kind: 'owned', requestedAmount: requested, missingAmount: 0, awaitingIncoming: incomingHeld > 0,
                    executable: incomingHeld === 0, supported: true, resolved: true, successProbability: 1, branches: 1,
                    requirements: [], tripEntries: [], height: 0,
                    basePrice: 0, price: 0, baseHours: 0, hours: 0, baseEffort: ownValue > 0 ? ownValue * adenaToHours : 0,
                    effort: ownValue > 0 ? ownValue * adenaToHours : 0 };
            }
        }
        const choices = [], alternativeUse = new Map(allocation?.used || []);
        const paths = node.paths?.length ? node.paths : [{ kind: 'owned', activity: null,
            price: node.price, costHours: node.costHours, riskHours: node.riskHours }];
        if (diagnostic) Diagnostics.count('network', 'path_request', 'known_input', paths.length);
        for (const path of paths) {
            if (path.available === false) {
                if (diagnostic) Diagnostics.count('network', 'path_refused', 'source_unavailable');
                continue;
            }
            const successProbability = Number(path.successProbability ?? 1);
            if (!Number.isFinite(successProbability) || successProbability < 0 || successProbability > 1) {
                if (diagnostic) Diagnostics.count('network', 'path_refused', 'invalid_probability');
                continue;
            }
            const valuation = path.outcomes ? Valuation.opportunity({ moneyPrice: adenaToHours, riskWeight }, path.outcomes) : null;
            if (valuation && !valuation.known) {
                if (diagnostic) Diagnostics.count('network', 'path_refused', 'unknown_outcome');
                continue;
            }
            const units = allocation && ['craft', 'crystallize'].includes(path.kind)
                ? Math.ceil(amount / Number(path.productCount || 1)) : allocation ? amount : 1;
            if (!Number.isSafeInteger(units) || units <= 0) continue;
            // ARCH-NOTE: PERF path-only facts, once per path (both evaluations read them).
            const unitEffort = allocation ? priceOf(path, 0) : priceOf(path);
            const inputs = allocation ? path.grossRequirements || path.requirements || [] : path.requirements || path.grossRequirements || [];
            const leaf = Array.isArray(inputs) && inputs.length === 0;
            // Forecast the complete output first. A native batch limit only
            // bounds the next command, never the materials or price of the goal.
            const evaluate = (units, command = false) => {
                // ARCH-NOTE: PERF a path without inputs solves no child: it claims no stock, so the
                // claims need no copy and no merge back.
                const local = allocation && !leaf ? { rootKey: allocation.rootKey, used: new Map(allocation.used) } : null;
                let price = nonnegative(path.price) * units, effort = unitEffort * units,
                    available = true, height = 0, awaitingIncoming = !command && incomingHeld > 0;
                if (allocation && !command && ownValue > 0) effort += ownValue * adenaToHours;
                let executable = path.executable !== false;
                // Own step now: a seller, NPC, recipe, workshop capacity, farm.
                let supported = executable && Number(path.availableUnits ?? Infinity) !== 0, resolved = true;
                let probability = 1, branches = 1, onceCash = 0, onceEffort = 0, onceHours = 0;
                // MVP-4: elapsed hours until the output is ready, in sequence:
                // own labour, inputs, trips. Waiting for accepted incoming has
                // no native delivery time. ARCH-NOTE: counted as zero.
                // A farm's cost is its net hour (D7); its elapsed time is readyHours.
                let hours = nonnegative(path.readyHours ?? path.costHours) * units;
                const trip = travels(path) && trips.get(tripKey(path));
                const tripEntries = trip ? [trip.index] : [];
                let quoted = !!path.quoted;
                if (valuation) {
                    price = nonnegative(valuation.cashNow);
                    effort = Math.max(0, Number(path.ownBenefitHours || 0) - valuation.valueHours);
                    hours = nonnegative(valuation.cycleHours);
                }
                const requirements = [];
                const inputFacts = captureReadyCraft && allocation && depth === 1 && path.kind === 'craft' && !command ? [] : null;
                // Exact once-per-path inputs (a recipe scroll) are paid once,
                // never per attempt; consumed inputs of one attempt are the rest.
                const untilSuccess = !planning && path.kind === 'craft' && successProbability > 0 && successProbability < 1
                    && (path.grossRequirements || path.requirements || []).every(row => row.once || repeatable(row.key));
                for (const requirement of inputs) {
                    const amount = nonnegative(requirement.amount ?? 1) * (allocation ? requirement.once ? 1 : units : 1);
                    if (!Number.isSafeInteger(amount) || amount <= 0) { available = false; break; }
                    const child = solve(requirement.key, depth + 1, amount, local, planning, completionFirst, inputFacts);
                    if (!child || !amount) { available = false; break; }
                    if (!child.executable || Number(child.availableUnits ?? Infinity) < amount) executable = false;
                    supported &&= child.supported !== false;
                    resolved &&= child.resolved !== false;
                    // A per-unit child (no stock allocation) repeats its batch.
                    // One stockless child plan is one batch of its path (E192):
                    // its cost repeats per batch, its chance per native command.
                    const childBatches = allocation ? 1 : Math.ceil(amount / Number(child.productCount || 1));
                    const childDraws = allocation ? 1 : commands(childBatches, child.perCommand);
                    probability *= Number(child.successProbability ?? 1) ** childDraws;
                    branches *= mergedBranches(Number(child.branches || 1), childDraws);
                    const childPrice = child.basePrice * childBatches, childEffort = child.baseEffort * childBatches;
                    const childHours = nonnegative(child.baseHours) * childBatches;
                    if (requirement.once) { onceCash += childPrice; onceEffort += childEffort; onceHours += childHours; }
                    else { price += childPrice; effort += childEffort; hours += childHours; }
                    awaitingIncoming ||= !!child.awaitingIncoming;
                    for (const index of child.tripEntries) if (!tripEntries.includes(index)) tripEntries.push(index);
                    quoted ||= child.quoted;
                    height = Math.max(height, 1 + child.height);
                    if (!allocation || child.missingAmount > 0 || child.awaitingIncoming) requirements.push({ key: requirement.key,
                        amount: allocation ? child.missingAmount || amount : amount, plan: child });
                }
                if (untilSuccess) {
                    // ARCH-NOTE: expected attempts 1/p repeat the cash, consumed
                    // inputs and labour of one attempt; the trip is made once.
                    price /= successProbability; effort /= successProbability; hours /= successProbability;
                } else if (successProbability < 1) {
                    // One native attempt: the parent step runs only when every
                    // child succeeded, so that branch splits into own outcomes.
                    // E190: one draw per native command (D3), not per batch.
                    probability *= successProbability ** commands(units, path.perCommand);
                    branches += mergedBranches(2, commands(units, path.perCommand)) - 1;
                }
                price += onceCash; effort += onceEffort; hours += onceHours;
                // E303: counted only where the branch cap itself cuts (not when a child already left the
                // path unresolved, not in the native command pass); no check counter, the denominator is
                // provider:admission:evaluation. The depth cap is counted by provider:admission_pending:evaluation_limit
                // for provider roots; the group path (EconomyContext) depth is not counted.
                const ownCut = resolved && branches > MAX_BRANCHES;
                resolved &&= branches <= MAX_BRANCHES;
                if (ownCut && !command && diagnostic) Diagnostics.count('cap', 'branches', 'cut');
                const basePrice = price, baseEffort = effort, baseHours = hours;
                price += tripValue(tripEntries, 'fees'); effort += tripEffort(tripEntries); hours += tripValue(tripEntries, 'hours');
                if (available && local && !command) for (const [id, count] of local.used) alternativeUse.set(id, Math.max(alternativeUse.get(id) || 0, count));
                if (available) {
                    const result = { ...path, executable, supported, resolved, branches, quoted, tripEntries,
                        successProbability: probability, attemptProbability: successProbability, untilSuccess,
                        ...(allocation ? { requestedAmount: requested, missingAmount: amount, batches: units, awaitingIncoming } : {}),
                        basePrice, baseEffort, baseHours, price, effort, hours, requirements, height };
                    if (inputFacts?.length && inputFacts.length === inputs.length && outputStock
                        && executable && !awaitingIncoming && !requirements.length
                        && inputFacts.every(([, , , toOrder, toExecute]) => toOrder === 0 && toExecute === 0)
                        && new Set(inputFacts.map(row => row[0])).size === inputFacts.length) {
                        Object.defineProperty(result, 'readyCraftProof', { configurable: true, value: { output: outputStock,
                            inputs: inputFacts.map(([id, required]) => [id, required]) } });
                        proofPlans.push(result);
                    }
                    return result;
                } else if (diagnostic) Diagnostics.count('network', 'path_refused', 'missing_requirement');
                return null;
            };
            const choice = evaluate(units);
            if (!choice) continue;
            if (allocation && path.kind === 'crystallize') {
                const inputs = path.grossRequirements || path.requirements || [];
                const physicalBatches = Math.min(...inputs.map(input => {
                    const id = input.key.startsWith('item:') ? Number(input.key.slice(5)) : 0;
                    const physical = id ? Math.max(0, nonnegative(stockFor(id, allocation.rootKey)?.owned)
                        - (allocation.used.get(id) || 0)) : 0;
                    return input.once ? physical >= Number(input.amount || 1) ? Infinity : 0
                        : Math.floor(physical / Number(input.amount || 1));
                }));
                // Consume held spares now; otherwise prepare one bounded batch.
                // Incoming stock contributes to the forecast, never this test.
                const commandUnits = Math.min(units, Number(path.batchLimit || Infinity), physicalBatches || Infinity);
                if (Number.isSafeInteger(commandUnits) && commandUnits > 0 && commandUnits < units) {
                    choice.execution = evaluate(commandUnits, true);
                    if (choice.execution) choice.execution.availableUnits = Math.min(Number(path.availableUnits ?? Infinity),
                        commandUnits * Number(path.productCount || 1));
                }
            }
            choices.push(choice);
        }
        // MVP-1: executable, then supported (saving, preparation, incoming),
        // then effort. Finite production plans its cheapest future source:
        // an unsupported purchase keeps the trial's queue place and WTB row
        // without cash, never a costlier step now.
        const completionHours = choice => choice.hours + (adenaToHours > 0
            ? Math.max(0, choice.price - Math.max(0, wallet - survivalReserve)) * adenaToHours : choice.price > wallet ? Infinity : 0);
        const order = choice => choice.acquisitionOrder === 1 && choice.kind === 'buy'
            && choice.price > Math.max(0, wallet - survivalReserve) ? 3 : nonnegative(choice.acquisitionOrder);
        const acquisitionOrder = (a, b) => a.supported && a.resolved && b.supported && b.resolved
            ? order(a) - order(b) : 0;
        choices.sort((a, b) => acquisitionOrder(a, b) || (completionFirst
            ? Number(b.supported) - Number(a.supported) || completionHours(a) - completionHours(b) || a.effort - b.effort
            : planning
            ? a.effort - b.effort || Number(b.supported) - Number(a.supported) || Number(b.executable) - Number(a.executable) || a.price - b.price
            : Number(b.executable) - Number(a.executable) || Number(b.supported) - Number(a.supported) || a.effort - b.effort || a.price - b.price));
        const best = choices[0] || null;
        if (allocation && best) {
            const transformation = choices.find(choice => choice.kind === 'craft');
            if (transformation && transformation !== best) best.intentionPath = transformation;
        }
        if (diagnostic) Diagnostics.count('network', 'path_evaluated', 'known_available', choices.length);
        if (detail) for (const choice of choices) Diagnostics.push({ ...trace,
            phase: 'wish_alternative', reason: choice === best ? 'selected_path' : 'evaluated_path',
            wishKey: key, source: choice.sourceType || choice.kind || choice.activity || 'requirement',
            town: choice.town, npcId: choice.npcId, item: choice.itemId,
            recipeId: choice.recipeId, quote: choice.price, tripHours: choice.tripHours,
            tripFees: choice.tripFees, requested: choice.amount });
        if (detail && best?.kind === 'craft') for (const requirement of best.requirements) Diagnostics.push({ ...trace,
            phase: 'craft_requirement', reason: 'selected_recipe_input', source: 'craft_input',
            wishKey: requirement.key, recipeId: best.recipeId, requested: requirement.amount,
            item: requirement.key.startsWith('item:') ? Number(requirement.key.slice(5)) : undefined });
        visiting.delete(key);
        if (allocation) allocation.used = alternativeUse;
        else { memo.set(memoKey, best); if (!planning) plans.set(key, best); }
        return best;
    };
    const finiteProduction = key => {
        const node = byKey.get(key);
        return node?.object?.kind === 'resale' && node.paths?.some(path => ['craft', 'spoil_sale'].includes(path.kind)
            && path.trial === true && path.repeatable === false);
    };
    // A direct production root is itself the craft path. Its finite output
    // quantity must enter allocation, just like an item requirement does;
    // otherwise even an eleven-batch goal requests one batch of inputs.
    const rootAmount = node => node?.object?.kind === 'resale'
        && node.paths?.some(path => path.kind === 'craft' && path.trial === true && path.repeatable === false)
        && Number.isSafeInteger(node.object.amount) && node.object.amount > 0 ? node.object.amount : 1;
    // MVP-4: one horizon H per root; a benefit per hour starts when the
    // path is ready (funding delay at net income, then the path's hours).
    // An unknown delay keeps the interest unresolved: no money, no gap.
    const spendable = Math.max(0, nonnegative(wallet) - nonnegative(survivalReserve));
    const value = (wish, node, plan) => {
        const base = nonnegative(node.valueHours) * (1 - Math.min(1, nonnegative(node.progress)));
        wish.resolved = plan?.resolved !== false;
        wish.readyHours = 0;
        if (plan && nonnegative(node.benefitPerHour) > 0) {
            const delay = Valuation.fundingDelay({ requiredCash: wish.price, spendableCash: spendable, incomePerHour: hourAdena });
            const ready = Valuation.readyBenefit({ valueHours: base, benefitPerHour: node.benefitPerHour,
                horizonHours: node.horizonHours, notBeforeHours: node.notBeforeHours,
                delayHours: delay === null ? null : delay + nonnegative(plan.hours) });
            if (ready === null) wish.resolved = false;
            else { wish.readyHours = delay + nonnegative(plan.hours); wish.valueHours = ready * Number(plan.successProbability ?? 1); return; }
        }
        wish.valueHours = plan ? base * Number(plan.successProbability ?? 1) : 0;
    };
    // The author's priority value: full benefit, before its ready delay.
    const fullValue = (wish, node) => wish.plan ? nonnegative(node.valueHours) * (1 - Math.min(1, nonnegative(node.progress)))
        * Number(wish.plan.successProbability ?? 1) : 0;
    const rootWish = key => {
        const node = byKey.get(key);
        if (!node || !NEEDS.includes(node.need)) throw new TypeError('invalid_wish_root');
        const plan = solve(key, 0, 1, null, finiteProduction(key), node.progressionPriority > 0);
        plans.set(key, plan);
        const wish = { key, need: node.need, object: node.object, plan, supported: plan?.supported !== false, reserved: nonnegative(node.reserved),
            progressionPriority: nonnegative(node.progressionPriority), progressionFunding: !!node.progressionFunding,
            price: plan ? nonnegative(plan.quoted ? plan.price : node.price ?? plan.price) : Infinity, effort: plan?.effort ?? Infinity };
        value(wish, node, plan);
        wish.fullValueHours = fullValue(wish, node);
        if (wish.progressionPriority && plan) wish.effort = Math.max(wish.effort,
            plan.hours + Math.max(0, plan.price - spendable) * adenaToHours);
        return wish;
    };
    // Shared stock: re-solve one root against the stock already claimed. The
    // returned claims enter the caller's map only when it keeps the root.
    const allocate = (wish, used) => {
        const allocation = { rootKey: wish.key, used: new Map(used) };
        const plan = solve(wish.key, 0, rootAmount(byKey.get(wish.key)), allocation,
            finiteProduction(wish.key), byKey.get(wish.key).progressionPriority > 0);
        wish.progressionPriority = nonnegative(byKey.get(wish.key).progressionPriority);
        wish.progressionFunding = !!byKey.get(wish.key).progressionFunding;
        wish.plan = plan; wish.price = plan?.price ?? Infinity; wish.effort = plan?.effort ?? Infinity;
        wish.supported = plan?.supported !== false;
        value(wish, byKey.get(wish.key), plan);
        wish.fullValueHours = fullValue(wish, byKey.get(wish.key));
        if (wish.progressionPriority && plan) wish.effort = Math.max(wish.effort,
            plan.hours + Math.max(0, plan.price - spendable) * adenaToHours);
        // Shared stock can change the full path's cost. A finite
        // earning trial never funds a route whose effort consumes its
        // entire expected benefit; rejected trials claim no stock.
        if (finiteProduction(wish.key) && !(wish.valueHours > wish.effort)) wish.valueHours = 0;
        plans.set(wish.key, plan);
        return allocation.used;
    };
    const takeReadyCraftProof = !captureReadyCraft ? null : (rootKey, nodeKey) => {
        const requirements = plans.get(rootKey)?.requirements;
        const proof = requirements?.length === 1 && requirements[0].key === nodeKey
            ? requirements[0].plan?.readyCraftProof || null : null;
        // No diagnostic properties survive in the returned network or card.
        for (const plan of proofPlans || []) delete plan.readyCraftProof;
        if (proofPlans) proofPlans.length = 0;
        return proof;
    };
    return { byKey, plans, finiteProduction, tripValue, tripEffort, rootWish, allocate, takeReadyCraftProof };
}
// MVP-6: roots in the caller's rank order while the union of their reachable
// nodes stays within the bound. A root that does not fit is pending (not
// deleted, not zero cost); the smaller roots after it still proceed.
// label 'solo' (a bot's own review, counted in WishProviders as provider:admission_pending) or 'group' (EconomyContext).
function admitRoots(roots, byKey, { rootLimit = MAX_ROOTS, nodeLimit = MAX_NODES, label = 'solo' } = {}) {
    const kept = new Set(), admitted = [], pending = [];
    for (const key of roots) {
        if (admitted.length >= rootLimit) { pending.push({ key, reason: 'root_limit' }); continue; }
        const reach = new Set();
        const visit = at => {
            if (kept.has(at) || reach.has(at) || !byKey.has(at)) return true;
            reach.add(at);
            if (kept.size + reach.size > nodeLimit) return false;
            for (const path of byKey.get(at).paths || []) {
                for (const row of path.requirements || []) if (!visit(row.key)) return false;
                for (const row of path.grossRequirements || []) if (!visit(row.key)) return false;
            }
            return true;
        };
        if (!visit(key)) { pending.push({ key, reason: 'node_limit' }); continue; }
        for (const at of reach) kept.add(at);
        admitted.push(key);
    }
    if (Diagnostics.active()) {
        // E303: how often the caps cut. The solo dropped counts already exist as provider:admission_pending
        // root_limit/node_limit, so solo counts only checks and cuts; the group path has no other counter.
        let rootDropped = 0, nodeDropped = 0;
        for (const row of pending) row.reason === 'root_limit' ? rootDropped++ : nodeDropped++;
        const group = label === 'group';
        Diagnostics.count('cap', group ? 'roots_group' : 'roots_solo', 'check');
        if (rootDropped) {
            Diagnostics.count('cap', group ? 'roots_group' : 'roots_solo', 'cut');
            if (group) Diagnostics.count('cap', 'roots_group', 'dropped', rootDropped);
        }
        if (nodeDropped) {
            Diagnostics.count('cap', group ? 'nodes_group' : 'nodes_solo', 'cut');
            if (group) Diagnostics.count('cap', 'nodes_group', 'dropped', nodeDropped);
        }
    }
    return { roots: admitted, kept, pending };
}
class WishNetwork {
    constructor() { this.cache = new Map(); }
    forget(actorKey, reason = 'owner_release') {
        if (this.cache.delete(actorKey) && Diagnostics.active()) Diagnostics.count('network', 'eviction', reason);
    }
    clear() {
        if (Diagnostics.active() && this.cache.size) Diagnostics.count('network', 'eviction', 'reset', this.cache.size);
        this.cache.clear();
    }

    // `remembered: false` builds without touching the per-actor cache (a
    // caller that holds the result itself, or a one-off proposal). The worker
    // never retains (RETAIN_ACTORS).
    build({ actorKey, inputKey, characterId, decisionSeq = 0, activityLeaf = 0, nodes, roots, wallet = 0, survivalReserve = 0,
        playedHours = 0, persona = {}, previous = {}, hourAdena = 0, riskWeight = 1, moneyPaths = [], remembered = true,
        caller = 'wish_network', trigger = 'request', stockFor = null, completionKey = null, reconsider = true,
        reconsiderReasons = null, onReadyCraftProof = null }) {
        const diagnostic = Diagnostics.active();
        const captureReadyCraft = typeof onReadyCraftProof === 'function';
        if (diagnostic) Diagnostics.count('network', 'request');
        if (typeof actorKey !== 'string' || !actorKey || typeof inputKey !== 'string'
            || !Array.isArray(nodes) || nodes.length > MAX_NODES || !Array.isArray(roots) || roots.length > MAX_ROOTS
            || new Set(roots).size !== roots.length) {
            throw new TypeError('invalid_wish_network_input');
        }
        const individual = Number(characterId) > 0;
        decisionSeq = Math.max(0, Math.trunc(Number(decisionSeq) || 0));
        activityLeaf = Number(activityLeaf) >>> 0;
        const retain = remembered && RETAIN_ACTORS;
        const cached = retain ? this.cache.get(actorKey) : null;
        if (cached?.inputKey === inputKey && cached.decisionSeq === decisionSeq && cached.activityLeaf === activityLeaf
            && cached.completionKey === completionKey && cached.reconsider === reconsider) {
            if (captureReadyCraft) onReadyCraftProof(null);
            if (diagnostic) Diagnostics.count('network', 'hit', 'same_inputs');
            return remember(this.cache, actorKey, cached).result;
        }
        const started = diagnostic ? performance.now() : 0;
        const detail = diagnostic && Diagnostics.enabled(characterId);
        const trace = detail ? { owner: Number(characterId), caller, trigger,
            inputHash: fnv1a32(inputKey), decisionSeq, activityLeaf } : null;
        if (diagnostic) Diagnostics.count('network', 'miss', !remembered ? 'uncached_actor' : !retain ? 'held_plan_only' : cached ? 'input_dependency_changed' : 'not_retained');
        // Group and clan decisions roll on their input name: a group's
        // is its members' facts keys, so a party's choice is rolled again only
        // when a member's facts, market reads, decision sequence, leaf or focus move.
        const roll = kind => individual ? Tendency.roll(characterId, decisionSeq, kind)
            : Tendency.roll(actorKey, inputKey, kind);
        const solver = createSolver({ nodes, hourAdena, riskWeight, stockFor, wallet, survivalReserve, diagnostic, detail, trace, captureReadyCraft });
        const { byKey, plans, finiteProduction, tripValue, tripEffort } = solver;
        const kept = wish => wish.valueHours > 0 && wish.plan
            && (!finiteProduction(wish.key) || wish.valueHours > wish.effort);
        let wishes = roots.map(solver.rootWish);
        if (stockFor) {
            // Existing money priority allocates free stock once. Alternatives of
            // one root evaluate the same baseline and retain the maximum claim.
            // MVP-4: the ready delay follows the cash the allocated path needs,
            // so a root is judged after allocation, as admission judges it; an
            // unquoted market price before it is no reason to drop the root.
            // Paths carry gross inputs, so the stockless pass prices held
            // inputs as purchases. Priority reads each root alone against all
            // free stock; that solve is the allocation while nothing is claimed.
            const alone = new Map(wishes.map(wish => [wish, solver.allocate(wish, new Map())]));
            wishes = wishes.filter(wish => wish.plan && wish.fullValueHours > 0);
            const used = new Map();
            const priority = [...wishes].sort((a, b) => b.progressionPriority - a.progressionPriority
                || Number(b.key === completionKey) - Number(a.key === completionKey)
                || b.fullValueHours / Math.max(1, b.price) - a.fullValueHours / Math.max(1, a.price) || a.key.localeCompare(b.key));
            for (const wish of priority) {
                // Less free stock off the alone solve's claims only makes its
                // alternatives dearer, so that solve stands unless a claim is taken.
                const own = alone.get(wish);
                let taken = false;
                for (const id of own.keys()) if (used.has(id)) { taken = true; break; }
                const claimed = taken ? solver.allocate(wish, used) : own;
                if (wish.valueHours > 0) for (const [id, count] of claimed) used.set(id, count);
            }
        }
        wishes = wishes.filter(kept);
        const gearPriority = Math.max(0, ...wishes.filter(wish => wish.object?.slot).map(wish => wish.progressionPriority));
        if (gearPriority) {
            const budget = Math.max(0, wallet - survivalReserve);
            const readyGear = wishes.some(wish => wish.object?.slot && wish.progressionPriority === gearPriority
                && fundable(wish) && Math.max(cashCharge(wish), nonnegative(byKey.get(wish.key).price)) <= budget);
            // A finite profitable craft can pay for the kit. Once a kit piece
            // is affordable, spend on it before starting another earning trial.
            for (const wish of wishes) if (wish.progressionFunding && !readyGear) wish.progressionPriority = gearPriority;
            wishes = wishes.filter(wish => wish.progressionPriority >= gearPriority);
        }
        const activePriority = Math.max(0, ...wishes.map(wish => wish.progressionPriority));
        if (activePriority) wishes = wishes.filter(wish => wish.progressionPriority === activePriority);
        const focusWishes = wishes.filter(wish => wish.progressionPriority === activePriority);
        const loyalty = Math.min(1, nonnegative(persona.traits?.commitment ?? 0.5));
        const score = wish => wish.valueHours / Math.max(1 / 3600, wish.effort);
        // Only an event (reconsider: the caller's raised sections or due soft changes)
        // weighs a held choice against the others; an ordinary rebuild keeps it.
        // A held choice survives a reconsideration while no row beats it by the bot's loyalty.
        // Leaf values already carry the off-focus (1 - loyalty) weight; the margin is the same trait.
        const loyal = (choice, rows) => !reconsider || rows.every(row => score(row) <= score(choice) * (1 + loyalty));
        const held = focusWishes.find(wish => wish.key === previous.focus?.[0]);
        const focused = focusWishes.find(wish => wish.key === completionKey)
            || (held && loyal(held, focusWishes) ? held
                : choose(focusWishes, score, roll('focus')));
        const focus = focused ? [focused.key, held === focused ? previous.focus[1] : playedHours,
            nonnegative(focused.price)] : null;
        const inputDecisionSeq = decisionSeq, inputActivityLeaf = activityLeaf;
        if (individual && focus?.[0] !== previous.focus?.[0]) { decisionSeq++; activityLeaf = 0; }
        const dormant = (previous.dormant || []).filter(row => Array.isArray(row) && row.length === 6
            && row[0] !== focus?.[0] && !wishes.some(wish => wish.key === row[0])).slice(0, 4);
        if (previous.focus && previous.focus[0] !== focus?.[0] && !dormant.some(row => row[0] === previous.focus[0])) {
            dormant.unshift([previous.focus[0], 'superseded', 0, nonnegative(previous.focus[2]), playedHours, loyalty]);
            dormant.length = Math.min(dormant.length, 4);
        }
        const weighted = wishes.map(wish => ({ ...wish,
            valueHours: wish.valueHours * (wish === focused ? 1 : 1 - loyalty) }));
        const { queue, moneyPrice, available, gap } = moneyQueue(weighted, wallet, survivalReserve, hourAdena > 0 ? 1 / hourAdena : 0);
        const fundingReason = wish => wish.funded ? 'funded' : wish === gap ? 'first_funding_gap'
            : wish.supported === false ? 'unsupported_path' : wish.resolved === false ? 'unresolved_path'
                : wish.ratio < (hourAdena > 0 ? 1 / hourAdena : 0) ? 'below_money_floor' : 'priority_held';
        if (diagnostic) for (const wish of queue) {
            Diagnostics.count('network', 'wish_funding', fundingReason(wish));
        }
        if (detail) for (const wish of queue) Diagnostics.push({ ...trace,
            phase: 'wish_funding', reason: fundingReason(wish),
            wishKey: wish.key, item: wish.object?.itemId, requested: wish.object?.amount,
            quote: wish.price, valueHours: wish.valueHours, moneyPrice,
            budget: wish.funded ? wish.price : undefined, planned: wish.funded ? wish.object?.amount : undefined,
            reserve: survivalReserve, available, source: wish.plan?.sourceType || wish.plan?.kind,
            recipeId: wish.plan?.recipeId });
        const demands = new Map(), leaves = new Map();
        const flow = (key, value, amount = 1, rootKey = key, prepared = null) => {
            const complete = prepared || plans.get(key);
            if (!complete || !value) return;
            const node = byKey.get(key);
            if (!(amount > 0) || stockFor && complete.missingAmount === 0) return;
            demands.set(key, (demands.get(key) || 0) + value / amount);
            const plan = complete.execution || complete;
            const share = complete.execution ? Math.min(1, Number(plan.availableUnits) / amount) : 1;
            const ready = !['craft', 'luxury_exchange', 'crystallize', 'mammon_unseal'].includes(plan.kind)
                || !plan.awaitingIncoming && !plan.requirements.length;
            const acquired = Math.min(amount, Number(plan.availableUnits ?? Infinity));
            if (plan.activity && plan.executable && ready && acquired > 0) {
                const leafKey = `${rootKey}:${key}:${plan.activity}`;
                const leaf = leaves.get(leafKey) || { ...plan, key: leafKey, nodeKey: key, rootKey, activity: plan.activity,
                    ...(plan.kind === 'crystallize' ? { improvement: { ...plan.improvement, amount: plan.batches || 1 } } : {}),
                    object: node.object, amount: acquired,
                    price: stockFor ? plan.price * (complete.execution ? 1 : acquired / amount)
                        : plan.basePrice * acquired + tripValue(plan.tripEntries, 'fees'),
                    effort: stockFor ? plan.effort * (complete.execution ? 1 : acquired / amount)
                        : plan.baseEffort * acquired + tripEffort(plan.tripEntries), valueHours: 0 };
                if (byKey.get(rootKey)?.progressionPriority) leaf.effort = wishes.find(wish => wish.key === rootKey)?.effort ?? leaf.effort;
                leaf.valueHours += value * acquired / amount;
                leaves.set(leafKey, leaf);
            }
            const keyRequirements = plan.keyInputs?.length
                ? plan.requirements.filter(row => plan.keyInputs.includes(row.key)) : [];
            const activeRequirements = keyRequirements.length ? keyRequirements : plan.requirements;
            const total = activeRequirements.reduce((sum, row) => sum + row.amount, 0);
            for (const requirement of activeRequirements) flow(requirement.key,
                value * share * requirement.amount / total, stockFor ? requirement.amount : amount * requirement.amount, rootKey, requirement.plan);
        };
        for (const wish of weighted) flow(wish.key, wish.valueHours, 1, wish.key, stockFor ? wish.plan : null);
        // Funding is a path to the first gap, not a second budget or desire.
        const unfunded = gap;
        if (unfunded) for (const path of moneyPaths.slice(0, 3)) {
            const shortfall = Math.max(0, unfunded.price - available);
            // A missing seller is not a cash deficit. With its price already
            // covered, earning more cannot advance this acquisition.
            if (!shortfall && byKey.get(unfunded.key)?.personalAcquisition) continue;
            const key = `money:${unfunded.key}:${path.activity}:${path.object || ''}`;
            // A bag can pay part of this gap once. It does not establish an
            // hourly income or promise the entire purchase after more time.
            if (path.repeatable === false) {
                if (path.available === false || path.kind !== 'liquidate'
                    || ![path.capacityCash, path.cashFees, path.actionHours].every(Number.isFinite)
                    || path.capacityCash <= 0 || path.cashFees < 0 || path.actionHours < 0) continue;
                const contribution = Math.min(shortfall, Math.max(0, path.capacityCash - path.cashFees));
                if (!(contribution > 0)) continue;
                leaves.set(key, { ...path, key, nodeKey: unfunded.key, funding: true,
                    rootKey: unfunded.key, price: 0, shortfall, contribution,
                    effort: path.actionHours + nonnegative(path.riskHours) * nonnegative(riskWeight),
                    valueHours: Math.min(unfunded.valueHours, moneyPrice * contribution) });
                continue;
            }
            const income = nonnegative(path.incomePerHour);
            if (!(income > 0) || path.available === false || path.repeatable === false
                || path.kind === 'production' && (!(path.cycleHours > 0) || path.repeatable !== true)) continue;
            const effort = Math.max(unfunded.progressionPriority && !fundable(unfunded) ? 1 / 60 : 0, shortfall / income) + nonnegative(path.costHours)
                + nonnegative(path.riskHours) * nonnegative(riskWeight);
            leaves.set(key, { ...path, key, nodeKey: unfunded.key, funding: true,
                rootKey: unfunded.key, price: 0, effort, valueHours: unfunded.valueHours, shortfall });
        }
        // Only funded wishes with their own money-packet row can be paid by
        // every itemId spend site; the merged tail stays protected but waits.
        const funded = new Set(packetRowWishes(queue.filter(wish => wish.funded)).map(wish => wish.key));
        // A step that spends no money stays available toward an unsupported
        // wish (farming its material); only money waits for a step now.
        const unfundable = new Set(queue.filter(wish => !fundable(wish)).map(wish => wish.key));
        const candidates = [...leaves.values()].filter(leaf => wishes.find(wish => wish.key === leaf.rootKey)?.progressionPriority === activePriority)
            .filter(leaf => leaf.funding || !queue.some(wish => wish.key === leaf.rootKey)
            || funded.has(leaf.rootKey) || leaf.price === 0 && (leaf.rootKey === unfunded?.key || unfundable.has(leaf.rootKey)));
        // A cheap intermediate material cannot claim the whole upgrade's
        // benefit as an instantaneous income. Use the complete chosen path.
        const heldLeaf = individual && activityLeaf ? candidates.find(leaf => fnv1a32(leaf.key) === activityLeaf) : null;
        const heldActivity = heldLeaf && loyal(heldLeaf, candidates) ? heldLeaf : null;
        if (individual && activityLeaf && !heldActivity && decisionSeq === inputDecisionSeq) {
            // A completed, impossible or outscored step is a real reconsideration;
            // rebuilding the same valid step is not another tendency roll.
            decisionSeq++; activityLeaf = 0;
        }
        const completion = candidates.find(leaf => leaf.rootKey === completionKey && leaf.kind === 'luxury_exchange');
        const activity = completion || heldActivity || choose(candidates, score, roll('activity'));
        const result = { inputKey, queue, moneyPrice, available, gap, hourAdena,
            quantityPrepared: !!stockFor,
            focus, dormant, activity, demands, plans, decisionSeq,
            activityLeaf: individual && activity ? fnv1a32(activity.key) : 0 };
        const selectedProof = captureReadyCraft ? solver.takeReadyCraftProof(activity?.rootKey, activity?.nodeKey) : null;
        let readyCraftProof = null;
        if (selectedProof && activity?.kind === 'craft' && activity.activity === 'crafting' && !activity.funding) {
            const root = byKey.get(activity.rootKey), paths = root?.paths, inputs = paths?.[0]?.grossRequirements || paths?.[0]?.requirements;
            // Only the root's direct output: an upstream stock change can alter
            // a nested craft's batch count before that upstream goal completes.
            if (paths?.length === 1 && inputs?.length === 1 && inputs[0].key === activity.nodeKey)
                readyCraftProof = { rootKey: activity.rootKey, nodeKey: activity.nodeKey, ...selectedProof };
        }
        if (captureReadyCraft) onReadyCraftProof(readyCraftProof);
        if (diagnostic) {
            Diagnostics.count('network', 'build');
            const outcome = completion ? 'completion' : heldActivity ? 'held'
                : heldLeaf ? 'outscored' : !inputActivityLeaf ? activity ? 'fresh' : 'none'
                : focus?.[0] !== previous.focus?.[0] ? 'focus_moved' : 'gone';
            Diagnostics.count('network', 'activity', outcome);
            // Which event (the caller's reasons, 'quiet' for none) kept or moved a held choice.
            if (reconsiderReasons && (outcome === 'held' || outcome === 'outscored' || outcome === 'focus_moved'))
                for (const reason of reconsiderReasons) Diagnostics.count('network', 'reconsider', `${reason}:${outcome}`);
            Diagnostics.count('network', cached ? sameResult(cached.result, result) ? 'unchanged' : 'changed' : 'comparison_unavailable');
            Diagnostics.duration('network', performance.now() - started);
        }
        if (detail) Diagnostics.push({ ...trace, decisionSeq: result.decisionSeq, activityLeaf: result.activityLeaf,
            phase: 'wish_activity', reason: heldActivity ? 'held_activity' : activity ? 'selected_activity' : 'no_executable_activity',
            wishKey: activity?.rootKey, source: activity?.sourceType || activity?.kind || activity?.activity,
            item: activity?.itemId, planned: activity?.amount, quote: activity?.price,
            npcId: activity?.npcId, town: activity?.town, recipeId: activity?.recipeId,
            valueHours: activity?.valueHours, available, reserve: survivalReserve });
        if (retain) {
            if (diagnostic && !this.cache.has(actorKey) && this.cache.size >= ACTOR_LIMIT)
                Diagnostics.count('network', 'eviction', 'capacity');
            remember(this.cache, actorKey, { inputKey, completionKey, reconsider, decisionSeq: inputDecisionSeq,
                activityLeaf: inputActivityLeaf, result });
        }
        return result;
    }
}

module.exports = { WishNetwork, createSolver, createQuantityInputs, quantityInputsHold, eachQuantityRow, packQuantityInputs, unpackQuantityInputs, admitRoots, moneyQueue, remainingQuantity, craftMaterialLoss, fundable, cashCharge, remember, NEEDS, MAX_NODES, MAX_ROOTS, MAX_DEPTH, ACTOR_LIMIT, QUANTITY_INPUT_LIMIT, QUANTITY_INPUT_BYTES };
