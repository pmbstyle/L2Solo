const Tendency = require('../AI/TendencyRoll');
const NEEDS = Object.freeze(['power', 'status', 'care', 'scores']);
const MAX_NODES = 40;
const MAX_ROOTS = 12;
const MAX_DEPTH = 4;
const nonnegative = value => Math.max(0, Number(value) || 0);

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

function moneyQueue(wishes, wallet, survivalReserve = 0) {
    let available = Math.max(0, nonnegative(wallet) - nonnegative(survivalReserve));
    const queue = wishes.filter(wish => wish.valueHours > 0 && wish.price > 0)
        .map(wish => ({ ...wish, ratio: wish.valueHours / wish.price }))
        .sort((a, b) => b.ratio - a.ratio || a.key.localeCompare(b.key));
    let moneyPrice = 0, cutoffFound = false;
    for (const wish of queue) {
        // The first gap holds the marginal price of money. Smaller desires
        // do not spend the money earmarked toward that first missing goal.
        wish.funded = !cutoffFound && wish.price <= available;
        if (wish.funded) available -= wish.price;
        else if (!cutoffFound) { moneyPrice = wish.ratio; cutoffFound = true; }
    }
    return { queue, moneyPrice, available };
}

// Providers supply game effects and available paths, never policy priorities.
// One bounded DAG serves individual characters and group actors alike. The
// caller owns its event input key and the small saved focus/dormant packet.
// Per-actor results are a cache, not state: memory per bot is budgeted like
// CPU, so the held networks are bounded and the least recently used go first.
const ACTOR_LIMIT = 512;
function remember(map, key, value, limit = ACTOR_LIMIT) {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value);
    return value;
}
class WishNetwork {
    constructor() { this.cache = new Map(); }
    forget(actorKey) { this.cache.delete(actorKey); }
    clear() { this.cache.clear(); }

    build({ actorKey, inputKey, nodes, roots, wallet = 0, survivalReserve = 0,
        playedHours = 0, persona = {}, previous = {}, hourAdena = 0, riskWeight = 1, moneyPaths = [] }) {
        if (typeof actorKey !== 'string' || !actorKey || typeof inputKey !== 'string'
            || !Array.isArray(nodes) || nodes.length > MAX_NODES || !Array.isArray(roots) || roots.length > MAX_ROOTS
            || new Set(roots).size !== roots.length) {
            throw new TypeError('invalid_wish_network_input');
        }
        const cached = this.cache.get(actorKey);
        if (cached?.inputKey === inputKey) return remember(this.cache, actorKey, cached).result;
        const byKey = new Map();
        for (const node of nodes) {
            if (typeof node?.key !== 'string' || !node.key || byKey.has(node.key)
                || (node.need && !NEEDS.includes(node.need)) || (node.paths?.length || 0) > 3) {
                throw new TypeError('invalid_wish_node');
            }
            byKey.set(node.key, node);
        }
        const plans = new Map(), visiting = new Set();
        const adenaToHours = hourAdena > 0 ? 1 / hourAdena : Infinity;
        const priceOf = path => nonnegative(path.costHours) + nonnegative(path.riskHours) * nonnegative(riskWeight)
            + (nonnegative(path.price) > 0 ? nonnegative(path.price) * adenaToHours : 0);
        const solve = (key, depth = 0) => {
            if (visiting.has(key)) throw new TypeError('cyclic_wish_network');
            const node = byKey.get(key);
            if (!node) throw new TypeError('missing_wish_requirement');
            if (depth > MAX_DEPTH) throw new RangeError('wish_network_depth');
            if (plans.has(key)) {
                const cachedPlan = plans.get(key);
                if (depth + (cachedPlan?.height || 0) > MAX_DEPTH) throw new RangeError('wish_network_depth');
                return cachedPlan;
            }
            visiting.add(key);
            const choices = [];
            const paths = node.paths?.length ? node.paths : [{ kind: 'owned', activity: null,
                price: node.price, costHours: node.costHours, riskHours: node.riskHours }];
            for (const path of paths) {
                if (path.available === false) continue;
                let price = nonnegative(path.price), effort = priceOf(path), available = true, height = 0;
                const requirements = [];
                for (const requirement of path.requirements || []) {
                    const child = solve(requirement.key, depth + 1);
                    const amount = nonnegative(requirement.amount ?? 1);
                    if (!child || !amount) { available = false; break; }
                    price += child.price * amount; effort += child.effort * amount;
                    height = Math.max(height, 1 + child.height);
                    requirements.push({ key: requirement.key, amount });
                }
                if (available) choices.push({ ...path, price, effort, requirements, height });
            }
            choices.sort((a, b) => a.effort - b.effort || a.price - b.price);
            const best = choices[0] || null;
            visiting.delete(key); plans.set(key, best);
            return best;
        };
        const wishes = roots.map(key => {
            const node = byKey.get(key);
            if (!node || !NEEDS.includes(node.need)) throw new TypeError('invalid_wish_root');
            const plan = solve(key);
            const remaining = 1 - Math.min(1, nonnegative(node.progress));
            return { key, need: node.need, object: node.object, plan,
                valueHours: nonnegative(node.valueHours) * remaining,
                price: plan ? nonnegative(node.price ?? plan.price) : Infinity, effort: plan?.effort ?? Infinity };
        }).filter(wish => wish.valueHours > 0 && wish.plan);
        const loyalty = Math.min(1, nonnegative(persona.traits?.commitment ?? 0.5));
        const score = wish => wish.valueHours / Math.max(1 / 3600, wish.effort);
        const held = wishes.find(wish => wish.key === previous.focus?.[0]);
        const challenger = wishes.reduce((best, wish) => !best || score(wish) > score(best) ? wish : best, null);
        const focused = held && (!challenger || score(challenger) <= score(held) * (1 + loyalty)) ? held
            : choose(wishes, score, Tendency.roll(actorKey, inputKey, 'focus'));
        const focus = focused ? [focused.key, held === focused ? previous.focus[1] : playedHours,
            nonnegative(focused.price)] : null;
        const dormant = (previous.dormant || []).filter(row => Array.isArray(row) && row.length === 6
            && row[0] !== focus?.[0] && !wishes.some(wish => wish.key === row[0])).slice(0, 4);
        if (previous.focus && previous.focus[0] !== focus?.[0] && !dormant.some(row => row[0] === previous.focus[0])) {
            dormant.unshift([previous.focus[0], 'superseded', 0, nonnegative(previous.focus[2]), playedHours, loyalty]);
            dormant.length = Math.min(dormant.length, 4);
        }
        const weighted = wishes.map(wish => ({ ...wish,
            valueHours: wish.valueHours * (wish === focused ? 1 : 1 - loyalty) }));
        const { queue, moneyPrice, available } = moneyQueue(weighted, wallet, survivalReserve);
        const demands = new Map(), leaves = new Map();
        const flow = (key, value, amount = 1, rootKey = key) => {
            const plan = plans.get(key);
            if (!plan || !value) return;
            const node = byKey.get(key);
            demands.set(key, (demands.get(key) || 0) + value / amount);
            if (plan.activity) {
                const leafKey = `${rootKey}:${key}:${plan.activity}`;
                const leaf = leaves.get(leafKey) || { ...plan, key: leafKey, nodeKey: key, rootKey, activity: plan.activity,
                    object: node.object, amount, price: plan.price * amount, effort: plan.effort * amount, valueHours: 0 };
                leaf.valueHours += value;
                leaves.set(leafKey, leaf);
            }
            const total = plan.requirements.reduce((sum, row) => sum + row.amount, 0);
            for (const requirement of plan.requirements) flow(requirement.key,
                value * requirement.amount / total, amount * requirement.amount, rootKey);
        };
        for (const wish of weighted) flow(wish.key, wish.valueHours);
        // Funding is a path to the first gap, not a second budget or desire.
        const unfunded = queue.find(wish => !wish.funded);
        if (unfunded) for (const path of moneyPaths.slice(0, 3)) {
            const income = nonnegative(path.incomePerHour);
            if (!(income > 0) || path.available === false) continue;
            const shortfall = Math.max(0, unfunded.price - available);
            const effort = shortfall / income + nonnegative(path.costHours)
                + nonnegative(path.riskHours) * nonnegative(riskWeight);
            const key = `money:${unfunded.key}:${path.activity}:${path.object || ''}`;
            leaves.set(key, { ...path, key, nodeKey: unfunded.key, funding: true,
                rootKey: unfunded.key, price: 0, effort, valueHours: unfunded.valueHours, shortfall });
        }
        const funded = new Set(queue.filter(wish => wish.funded).map(wish => wish.key));
        const candidates = [...leaves.values()].filter(leaf => leaf.funding || !queue.some(wish => wish.key === leaf.rootKey)
            || funded.has(leaf.rootKey) || leaf.price === 0 && leaf.rootKey === unfunded?.key);
        // A cheap intermediate material cannot claim the whole upgrade's
        // benefit as an instantaneous income. Use the complete chosen path.
        const valuePerHour = focused ? focused.valueHours / Math.max(1 / 3600, focused.effort) : 0;
        const activity = choose(candidates, leaf => leaf.valueHours / Math.max(1 / 3600, leaf.effort),
            Tendency.roll(actorKey, inputKey, 'activity'));
        const result = { inputKey, queue, moneyPrice, available, valuePerHour,
            hourAdena: moneyPrice > 0 ? valuePerHour / moneyPrice : null,
            focus, dormant, activity, demands, plans };
        remember(this.cache, actorKey, { inputKey, result });
        return result;
    }
}

module.exports = { WishNetwork, moneyQueue, remember, NEEDS, MAX_NODES, MAX_ROOTS, MAX_DEPTH, ACTOR_LIMIT };
