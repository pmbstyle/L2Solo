const Tendency = require('../AI/TendencyRoll');
const Valuation = require('./EconomicValuation');
const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('./EconomyDiagnostics');
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

function moneyQueue(wishes, wallet, survivalReserve = 0, floor = 0) {
    let available = Math.max(0, nonnegative(wallet) - nonnegative(survivalReserve));
    const queue = wishes.filter(wish => wish.valueHours > 0 && wish.price > 0)
        .map(wish => ({ ...wish, ratio: wish.valueHours / wish.price }))
        .sort((a, b) => b.ratio - a.ratio || a.key.localeCompare(b.key));
    let moneyPrice = nonnegative(floor), cutoffFound = false, gap = null;
    for (const wish of queue) {
        // The first gap holds the marginal price of money. Smaller desires
        // do not spend the money earmarked toward that first missing goal.
        wish.funded = !cutoffFound && wish.ratio >= floor && wish.price <= available;
        if (wish.funded) available -= wish.price;
        else if (!cutoffFound) {
            if (wish.ratio >= floor) { moneyPrice = Math.max(floor, wish.ratio); gap = wish; }
            cutoffFound = true;
        }
    }
    return { queue, moneyPrice, available, gap };
}

// Providers supply game effects and available paths, never policy priorities.
// One bounded DAG serves individual characters and group actors alike. The
// caller owns its event input key and the small saved focus/dormant packet.
// Per-actor results are a cache, not state: memory per bot is budgeted
// (design 16.26). They serve the several readers of one decision (a commit,
// a resolve, a hot tick); a bot's next decision rebuilds the cheap layer
// anyway (new adena, exp), while the expensive one is kept per build
// (ColdCombatProfile.buildGainsFor). So few are held, least recently used out.
const ACTOR_LIMIT = 64;
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
    // caller that holds the result itself, or a one-off proposal).
    build({ actorKey, inputKey, characterId, decisionSeq = 0, activityLeaf = 0, nodes, roots, wallet = 0, survivalReserve = 0,
        playedHours = 0, persona = {}, previous = {}, hourAdena = 0, riskWeight = 1, moneyPaths = [], remembered = true,
        caller = 'wish_network', trigger = 'request', stockFor = null }) {
        const diagnostic = Diagnostics.active();
        if (diagnostic) Diagnostics.count('network', 'request');
        if (typeof actorKey !== 'string' || !actorKey || typeof inputKey !== 'string'
            || !Array.isArray(nodes) || nodes.length > MAX_NODES || !Array.isArray(roots) || roots.length > MAX_ROOTS
            || new Set(roots).size !== roots.length) {
            throw new TypeError('invalid_wish_network_input');
        }
        const individual = Number(characterId) > 0;
        decisionSeq = Math.max(0, Math.trunc(Number(decisionSeq) || 0));
        activityLeaf = Number(activityLeaf) >>> 0;
        const cached = remembered ? this.cache.get(actorKey) : null;
        if (cached?.inputKey === inputKey && cached.decisionSeq === decisionSeq && cached.activityLeaf === activityLeaf) {
            if (diagnostic) Diagnostics.count('network', 'hit', 'same_inputs');
            return remember(this.cache, actorKey, cached).result;
        }
        const started = diagnostic ? performance.now() : 0;
        const detail = diagnostic && Diagnostics.enabled(characterId);
        const trace = detail ? { owner: Number(characterId), caller, trigger,
            inputHash: fnv1a32(inputKey), decisionSeq, activityLeaf } : null;
        if (diagnostic) Diagnostics.count('network', 'miss', !remembered ? 'uncached_actor' : cached ? 'input_dependency_changed' : 'not_retained');
        // ARCH-NOTE: group and clan decisions retain their existing event-key seed.
        const roll = kind => individual ? Tendency.roll(characterId, decisionSeq, kind)
            : Tendency.roll(actorKey, inputKey, kind);
        const byKey = new Map();
        for (const node of nodes) {
            if (typeof node?.key !== 'string' || !node.key || byKey.has(node.key)
                || (node.need && !NEEDS.includes(node.need)) || (node.paths?.length || 0) > 3) {
                throw new TypeError('invalid_wish_node');
            }
            byKey.set(node.key, node);
        }
        const plans = new Map(), visiting = new Set();
        // A finite trial may plan a future purchase before a seller appears.
        // Its source choice cannot overwrite ordinary executable-first item
        // plans. This scratch map has at most the same 40 graph-node keys;
        // only the selected root/child plans survive in the bounded result.
        const producerPlans = new Map();
        const adenaToHours = hourAdena > 0 ? 1 / hourAdena : Infinity;
        // One route per member and town for the basket. Scratch descriptions
        // die with this build; plans retain bounded entry indices only. Group
        // members visiting the same town do not share each other's paid trips.
        const trips = new Map(), tripRows = [];
        const tripKey = path => `${path.tripScope || ''}|${path.town}`;
        for (const node of nodes) for (const path of node.paths || []) {
            if (path.quoted && path.town && !trips.has(tripKey(path))) {
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
        const priceOf = path => {
            if (!Number.isFinite(adenaToHours)) return nonnegative(path.price)
                + nonnegative(path.ownInputOpportunityValue) + nonnegative(path.actualCashFees) > 0 ? Infinity
                : nonnegative(path.costHours) + nonnegative(path.riskHours) * nonnegative(riskWeight);
            const value = Valuation.opportunity({ moneyPrice: adenaToHours, riskWeight }, [{ probability: 1,
                cashNow: nonnegative(path.price), foregoneBenefitHours: nonnegative(path.costHours),
                ownInputOpportunityValue: nonnegative(path.ownInputOpportunityValue),
                actualCashFees: nonnegative(path.actualCashFees), riskHours: nonnegative(path.riskHours) }]);
            return value.known ? -value.valueHours : Infinity;
        };
        const solve = (key, depth = 0, requested = 1, allocation = null, planning = false) => {
            if (visiting.has(key)) throw new TypeError('cyclic_wish_network');
            const node = byKey.get(key);
            if (!node) throw new TypeError('missing_wish_requirement');
            if (depth > MAX_DEPTH) throw new RangeError('wish_network_depth');
            const memo = planning ? producerPlans : plans;
            if (!allocation && memo.has(key)) {
                if (diagnostic) Diagnostics.count('network', 'node_hit', 'same_build');
                const cachedPlan = memo.get(key);
                if (depth + (cachedPlan?.height || 0) > MAX_DEPTH) throw new RangeError('wish_network_depth');
                return cachedPlan;
            }
            visiting.add(key);
            const itemId = key.startsWith('item:') ? Number(key.slice(5)) : 0;
            let amount = requested, ownValue = 0, incomingHeld = 0;
            if (allocation && itemId) {
                const stock = stockFor(itemId, allocation.rootKey) || {};
                const prior = allocation.used.get(itemId) || 0;
                const owned = Math.min(requested, Math.max(0, nonnegative(stock.owned) - prior));
                incomingHeld = Math.min(requested - owned, Math.max(0, nonnegative(stock.incoming) - Math.max(0, prior - nonnegative(stock.owned))));
                amount -= owned + incomingHeld;
                ownValue = owned * nonnegative(node.price);
                allocation.used.set(itemId, prior + owned + incomingHeld);
                if (!amount) {
                    visiting.delete(key);
                    return { kind: 'owned', requestedAmount: requested, missingAmount: 0, awaitingIncoming: incomingHeld > 0,
                        executable: incomingHeld === 0, requirements: [], tripEntries: [], height: 0,
                        basePrice: 0, price: 0, baseEffort: ownValue > 0 ? ownValue * adenaToHours : 0,
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
                const units = allocation && path.kind === 'craft' ? Math.ceil(amount / Number(path.productCount || 1)) : allocation ? amount : 1;
                if (!Number.isSafeInteger(units) || units <= 0) continue;
                const local = allocation ? { rootKey: allocation.rootKey, used: new Map(allocation.used) } : null;
                let price = nonnegative(path.price) * units, effort = (allocation ? priceOf({ ...path, ownInputOpportunityValue: 0 }) : priceOf(path)) * units,
                    available = true, height = 0, awaitingIncoming = incomingHeld > 0;
                if (allocation && ownValue > 0) effort += ownValue * adenaToHours;
                let executable = path.executable !== false;
                const trip = path.quoted && trips.get(tripKey(path));
                const tripEntries = trip ? [trip.index] : [];
                let quoted = !!path.quoted;
                if (valuation) {
                    price = nonnegative(valuation.cashNow);
                    effort = Math.max(0, Number(path.ownBenefitHours || 0) - valuation.valueHours);
                }
                const requirements = [];
                const inputs = allocation ? path.grossRequirements || path.requirements || [] : path.requirements || [];
                for (const requirement of inputs) {
                    const amount = nonnegative(requirement.amount ?? 1) * (allocation ? requirement.once ? 1 : units : 1);
                    if (!Number.isSafeInteger(amount) || amount <= 0) { available = false; break; }
                    const child = solve(requirement.key, depth + 1, amount, local, planning);
                    if (!child || !amount) { available = false; break; }
                    if (!child.executable || Number(child.availableUnits ?? Infinity) < amount) executable = false;
                    price += child.basePrice * (allocation ? 1 : amount);
                    effort += child.baseEffort * (allocation ? 1 : amount);
                    awaitingIncoming ||= !!child.awaitingIncoming;
                    for (const index of child.tripEntries) if (!tripEntries.includes(index)) tripEntries.push(index);
                    quoted ||= child.quoted;
                    height = Math.max(height, 1 + child.height);
                    if (!allocation || child.missingAmount > 0 || child.awaitingIncoming) requirements.push({ key: requirement.key,
                        amount: allocation ? child.missingAmount || amount : amount, ...(allocation || planning ? { plan: child } : {}) });
                }
                const basePrice = price, baseEffort = effort;
                price += tripValue(tripEntries, 'fees'); effort += tripEffort(tripEntries);
                if (allocation) for (const [id, count] of local.used) alternativeUse.set(id, Math.max(alternativeUse.get(id) || 0, count));
                if (available) choices.push({ ...path, executable, quoted, tripEntries, successProbability,
                    ...(allocation ? { requestedAmount: requested, missingAmount: amount, batches: units, awaitingIncoming } : {}),
                    basePrice, baseEffort, price, effort, requirements, height });
                else if (diagnostic) Diagnostics.count('network', 'path_refused', 'missing_requirement');
            }
            choices.sort((a, b) => planning
                ? a.effort - b.effort || Number(b.executable) - Number(a.executable) || a.price - b.price
                : Number(b.executable) - Number(a.executable) || a.effort - b.effort || a.price - b.price);
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
            else memo.set(key, best);
            return best;
        };
        const finiteProduction = key => {
            const node = byKey.get(key);
            return node?.object?.kind === 'resale' && node.paths?.some(path => path.kind === 'craft'
                && path.trial === true && path.repeatable === false);
        };
        const wishes = roots.map(key => {
            const node = byKey.get(key);
            if (!node || !NEEDS.includes(node.need)) throw new TypeError('invalid_wish_root');
            const plan = solve(key, 0, 1, null, finiteProduction(key));
            plans.set(key, plan);
            const remaining = 1 - Math.min(1, nonnegative(node.progress));
            return { key, need: node.need, object: node.object, plan,
                valueHours: nonnegative(node.valueHours) * remaining * Number(plan?.successProbability ?? 1),
                price: plan ? nonnegative(plan.quoted ? plan.price : node.price ?? plan.price) : Infinity, effort: plan?.effort ?? Infinity };
        }).filter(wish => wish.valueHours > 0 && wish.plan
            && (!finiteProduction(wish.key) || wish.valueHours > wish.effort));
        if (stockFor) {
            // Existing money priority allocates free stock once. Alternatives of
            // one root evaluate the same baseline and retain the maximum claim.
            const used = new Map();
            const priority = [...wishes].sort((a, b) => b.valueHours / Math.max(1, b.price) - a.valueHours / Math.max(1, a.price) || a.key.localeCompare(b.key));
            for (const wish of priority) {
                const allocation = { rootKey: wish.key, used: new Map(used) };
                const plan = solve(wish.key, 0, 1, allocation, finiteProduction(wish.key));
                wish.plan = plan; wish.price = plan?.price ?? Infinity; wish.effort = plan?.effort ?? Infinity;
                const node = byKey.get(wish.key);
                wish.valueHours = plan ? nonnegative(node.valueHours) * (1 - Math.min(1, nonnegative(node.progress))) * Number(plan.successProbability ?? 1) : 0;
                // Shared stock can change the full path's cost. A finite
                // earning trial never funds a route whose effort consumes its
                // entire expected benefit; rejected trials claim no stock.
                if (finiteProduction(wish.key) && !(wish.valueHours > wish.effort)) wish.valueHours = 0;
                if (wish.valueHours > 0) for (const [id, count] of allocation.used) used.set(id, count);
                plans.set(wish.key, plan);
            }
        }
        const loyalty = Math.min(1, nonnegative(persona.traits?.commitment ?? 0.5));
        const score = wish => wish.valueHours / Math.max(1 / 3600, wish.effort);
        const held = wishes.find(wish => wish.key === previous.focus?.[0]);
        const challenger = wishes.reduce((best, wish) => !best || score(wish) > score(best) ? wish : best, null);
        const focused = held && (!challenger || score(challenger) <= score(held) * (1 + loyalty)) ? held
            : choose(wishes, score, roll('focus'));
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
        if (diagnostic) for (const wish of queue) {
            const reason = wish.funded ? 'funded' : wish === gap ? 'first_funding_gap'
                : wish.ratio < (hourAdena > 0 ? 1 / hourAdena : 0) ? 'below_money_floor' : 'priority_held';
            Diagnostics.count('network', 'wish_funding', reason);
        }
        if (detail) for (const wish of queue) Diagnostics.push({ ...trace,
            phase: 'wish_funding', reason: wish.funded ? 'funded' : wish === gap ? 'first_funding_gap'
                : wish.ratio < (hourAdena > 0 ? 1 / hourAdena : 0) ? 'below_money_floor' : 'priority_held',
            wishKey: wish.key, item: wish.object?.itemId, requested: wish.object?.amount,
            quote: wish.price, valueHours: wish.valueHours, moneyPrice,
            budget: wish.funded ? wish.price : undefined, planned: wish.funded ? wish.object?.amount : undefined,
            reserve: survivalReserve, available, source: wish.plan?.sourceType || wish.plan?.kind,
            recipeId: wish.plan?.recipeId });
        const demands = new Map(), leaves = new Map();
        const flow = (key, value, amount = 1, rootKey = key, prepared = null) => {
            const plan = prepared || plans.get(key);
            if (!plan || !value) return;
            const node = byKey.get(key);
            if (!(amount > 0) || stockFor && plan.missingAmount === 0) return;
            demands.set(key, (demands.get(key) || 0) + value / amount);
            const ready = plan.kind !== 'craft' || !plan.awaitingIncoming && !plan.requirements.length;
            const acquired = Math.min(amount, Number(plan.availableUnits ?? Infinity));
            if (plan.activity && plan.executable && ready && acquired > 0) {
                const leafKey = `${rootKey}:${key}:${plan.activity}`;
                const leaf = leaves.get(leafKey) || { ...plan, key: leafKey, nodeKey: key, rootKey, activity: plan.activity,
                    object: node.object, amount: acquired,
                    price: stockFor ? plan.price * acquired / amount : plan.basePrice * acquired + tripValue(plan.tripEntries, 'fees'),
                    effort: stockFor ? plan.effort * acquired / amount : plan.baseEffort * acquired + tripEffort(plan.tripEntries), valueHours: 0 };
                leaf.valueHours += value * acquired / amount;
                leaves.set(leafKey, leaf);
            }
            const total = plan.requirements.reduce((sum, row) => sum + row.amount, 0);
            for (const requirement of plan.requirements) flow(requirement.key,
                value * requirement.amount / total, stockFor ? requirement.amount : amount * requirement.amount, rootKey, requirement.plan);
        };
        for (const wish of weighted) flow(wish.key, wish.valueHours, 1, wish.key, stockFor ? wish.plan : null);
        // Funding is a path to the first gap, not a second budget or desire.
        const unfunded = gap;
        if (unfunded) for (const path of moneyPaths.slice(0, 3)) {
            const income = nonnegative(path.incomePerHour);
            if (!(income > 0) || path.available === false || path.repeatable === false
                || path.kind === 'production' && (!(path.cycleHours > 0) || path.repeatable !== true)) continue;
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
        const heldActivity = individual && activityLeaf ? candidates.find(leaf => fnv1a32(leaf.key) === activityLeaf) : null;
        const activity = heldActivity || choose(candidates, leaf => leaf.valueHours / Math.max(1 / 3600, leaf.effort),
            roll('activity'));
        const result = { inputKey, queue, moneyPrice, available, gap, hourAdena,
            quantityPrepared: !!stockFor,
            focus, dormant, activity, demands, plans, decisionSeq,
            activityLeaf: individual && activity ? fnv1a32(activity.key) : 0 };
        if (diagnostic) {
            Diagnostics.count('network', 'build');
            Diagnostics.count('network', cached ? sameResult(cached.result, result) ? 'unchanged' : 'changed' : 'comparison_unavailable');
            Diagnostics.duration('network', performance.now() - started);
        }
        if (detail) Diagnostics.push({ ...trace, decisionSeq: result.decisionSeq, activityLeaf: result.activityLeaf,
            phase: 'wish_activity', reason: heldActivity ? 'held_activity' : activity ? 'selected_activity' : 'no_executable_activity',
            wishKey: activity?.rootKey, source: activity?.sourceType || activity?.kind || activity?.activity,
            item: activity?.itemId, planned: activity?.amount, quote: activity?.price,
            npcId: activity?.npcId, town: activity?.town, recipeId: activity?.recipeId,
            valueHours: activity?.valueHours, available, reserve: survivalReserve });
        if (remembered) {
            if (diagnostic && !this.cache.has(actorKey) && this.cache.size >= ACTOR_LIMIT)
                Diagnostics.count('network', 'eviction', 'capacity');
            remember(this.cache, actorKey, { inputKey, decisionSeq: inputDecisionSeq,
                activityLeaf: inputActivityLeaf, result });
        }
        return result;
    }
}

module.exports = { WishNetwork, moneyQueue, remember, NEEDS, MAX_NODES, MAX_ROOTS, MAX_DEPTH, ACTOR_LIMIT };
