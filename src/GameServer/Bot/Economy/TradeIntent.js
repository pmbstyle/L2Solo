'use strict';

// Version 1 of the board command's typed root certificate. This is a view
// of the wish graph, never a second wallet or a persistent acquisition plan.
const roots = [null, 'power', 'stock', 'book', 'enchant', 'sa', 'henna', 'status', 'resale'];
const integer = n => Number.isSafeInteger(n) && n >= 0;
// A selected executable NPC quote already has a native purchase owner.
// Public BUY ads describe alternative player supply, not a duplicate NPC job.
const nativeNpc = plan => plan?.sourceType === 'npc' && plan.quoted === true && plan.executable === true;
function rootTuple(key) {
    const parts = String(key).split(':'), kind = roots.indexOf(parts[0]);
    if (kind < 1) throw Error('trade_intent_unknown_root');
    const arity = [1, 4, 5].includes(kind) ? 3 : 2;
    if (parts.length !== arity) throw Error('trade_intent_invalid_root');
    const a = kind === 2 ? ['shots', 'potions'].indexOf(parts[1]) + 1 : Number(parts[1]);
    const b = arity === 3 ? Number(parts[2]) : 0;
    if (!integer(a) || a <= 0 || !integer(b) || arity === 3 && b <= 0) throw Error('trade_intent_invalid_root');
    return [kind, a, b];
}
function rootKey(kind, a, b) {
    if (!roots[kind] || !integer(a) || a <= 0 || !integer(b)) throw Error('trade_intent_invalid_root');
    const key = kind === 2 ? `stock:${[null, 'shots', 'potions'][a]}`
        : `${roots[kind]}:${a}${[1, 4, 5].includes(kind) ? `:${b}` : ''}`;
    const tuple = rootTuple(key);
    if (tuple[0] !== kind || tuple[1] !== a || tuple[2] !== b) throw Error('trade_intent_invalid_root');
    return key;
}
function decode(row) {
    if (!Array.isArray(row) || row.length !== 9) throw Error('trade_intent_invalid_certificate');
    const [itemId, amount, price, kind, a, b, recipeId, valueHours, valueRate] = row;
    if (![itemId, amount, price].every(n => integer(n) && n > 0) || !integer(recipeId)
        || !Number.isSafeInteger(amount * price) || ![valueHours, valueRate].every(n => Number.isFinite(n) && n >= 0)) {
        throw Error('trade_intent_invalid_certificate');
    }
    return { itemId, amount, price, key: rootKey(kind, a, b), recipeId, valueHours, valueRate };
}
function encode(row) {
    const tuple = [Number(row.itemId ?? row.selfId), Number(row.amount ?? row.count), Number(row.price),
        ...rootTuple(row.key), Number(row.recipeId || 0), Number(row.valueHours), Number(row.valueRate)];
    decode(tuple);
    return tuple;
}

// Use the prepared bounded graph, including non-selected craft alternatives.
// Different roots allocate scarce stock in the existing money queue's order;
// alternatives of one root all read that root's same allocation baseline.
function project(state, network, projection, worth, limit = 3) {
    if (network.quantityPrepared) return preparedProject(network, worth, limit);
    const byKey = new Map((projection.nodes || []).map(node => [node.key, node]));
    const allocated = new Map(), watched = new Set(), result = [];
    const incoming = state.acceptedIncoming || {};
    const freeAmount = require('./WealthCraftDecision').freeAmount;
    for (const wish of network.queue || []) {
        const baseline = new Map(allocated), used = new Map(), rows = new Map();
        const claim = (id, gross, local) => {
            const stock = state.inventory?.[id] || {};
            const owned = wish.key.startsWith('stock:') && Number(wish.object?.itemId) === id
                ? Number(stock.amount || 0) : freeAmount(state, stock);
            const available = owned + Number(incoming[id] || 0);
            const prior = baseline.get(id) || 0, pathUsed = local.get(id) || 0;
            const count = Math.min(gross, Math.max(0, available - prior - pathUsed));
            local.set(id, pathUsed + count);
            used.set(id, Math.max(used.get(id) || 0, pathUsed + count));
            return Math.max(0, gross - count);
        };
        const add = (id, amount, value, recipeId) => {
            if (!(amount > 0) || !(value > 0)) return;
            const previous = rows.get(id);
            rows.set(id, { itemId: id, amount: amount + (previous?.amount || 0), worth: worth(id), kind: wish.object?.kind,
                key: wish.key, recipeId, valueHours: value + (previous?.valueHours || 0), valueRate: wish.ratio });
        };
        // Unknown purchasing roots must defer a whole command, never receive
        // a lossy hash or somebody else's funding identity.
        if (!wish.object?.itemId && !wish.object?.materials) continue;
        try { rootTuple(wish.key); } catch (_) { return null; }
        const visit = (key, amount, value, local, recipeId = 0, depth = 0) => {
            if (depth > 4) return;
            const node = byKey.get(key);
            if (!node) return;
            const id = key.startsWith('item:') ? Number(key.slice(5)) : 0;
            const remaining = id ? claim(id, amount, local) : amount;
            if (!remaining) return;
            if (id && !nativeNpc(network.plans?.get(key))) add(id, remaining, value, recipeId);
            // Buy/drop sources need the same item. Traverse its single
            // transformation, whose own/paid executors share these inputs.
            const available = (node.paths || []).filter(path => path.available !== false);
            const path = available.find(path => path.kind === 'craft')
                || available.find(path => (path.grossRequirements || path.requirements)?.length);
            if (path) {
                const pathLocal = local;
                const requirements = path.grossRequirements || path.requirements || [];
                const batches = path.kind === 'craft' ? Math.ceil(remaining / Number(path.productCount || 1)) : remaining;
                const total = requirements.reduce((sum, row) => sum + row.amount, 0);
                for (const requirement of requirements) visit(requirement.key, requirement.amount * batches,
                    value * requirement.amount / Math.max(1, total), pathLocal, path.recipeId || recipeId, depth + 1);
            }
        };
        visit(wish.key, 1, wish.valueHours, new Map());
        for (const [id, row] of rows) if (!watched.has(id)) { watched.add(id); result.push(row); }
        for (const [id, count] of used) allocated.set(id, (baseline.get(id) || 0) + count);
    }
    return result.slice(0, limit);
}
// A quantitative network already owns allocation and batch rounding. Readers
// only project that result; they never subtract physical stock a second time.
function preparedProject(network, worth, limit) {
    const watched = new Set(), result = [];
    for (const wish of network.queue || []) {
        if (!wish.object?.itemId && !wish.object?.materials) continue;
        try { rootTuple(wish.key); } catch (_) { return null; }
        const rows = new Map();
        const visit = (key, plan, value, recipeId = 0, depth = 0) => {
            if (!plan || depth > 4 || !(plan.missingAmount > 0)) return;
            const id = key.startsWith('item:') ? Number(key.slice(5)) : 0;
            if (id && value > 0 && !nativeNpc(plan)) {
                const previous = rows.get(id);
                rows.set(id, { itemId: id, amount: plan.missingAmount + (previous?.amount || 0), worth: worth(id),
                    kind: wish.object?.kind, key: wish.key, recipeId, valueHours: value + (previous?.valueHours || 0), valueRate: wish.ratio });
            }
            const path = plan.intentionPath || plan, requirements = path.requirements || [];
            const total = requirements.reduce((sum, row) => sum + row.amount, 0);
            for (const row of requirements) visit(row.key, row.plan, value * row.amount / Math.max(1, total), path.recipeId || recipeId, depth + 1);
        };
        visit(wish.key, wish.plan, wish.valueHours);
        for (const [id, row] of rows) if (!watched.has(id)) { watched.add(id); result.push(row); }
    }
    return result.slice(0, limit);
}
module.exports = { rootTuple, rootKey, encode, decode, project };
