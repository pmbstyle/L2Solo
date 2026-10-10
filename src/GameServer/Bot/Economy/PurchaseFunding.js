const Diagnostics = require('./EconomyDiagnostics');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
// One wallet rule for hot/cold purchases. Value rates are hours per adena;
// higher-valued funded wishes keep their cumulative costs before a spend.
const nonnegative = value => Math.max(0, Number(value) || 0);
let moneyPacketMissing = 0;
function budget(state = {}, escrow = 0) {
    return nonnegative(state.adena ?? state.inventory?.[57]?.amount) + nonnegative(escrow);
}
function operatingReserve(state = {}) { return require('./EconomyContext').survivalReserve(state); }
function shortfall(state = {}, price = 0, reserve = 0, escrow = 0) {
    return Math.max(0, nonnegative(price) + nonnegative(reserve) - budget(state, escrow));
}
function surplus(state = {}, price = 0, reserve = 0) {
    return Math.max(0, budget(state) - nonnegative(price) - nonnegative(reserve));
}
function moneyReached(state) {
    const packet = state?.stats?.money;
    if (!Array.isArray(packet) || packet.length < 4 || !(Number(packet[3]) > 0)) return false;
    let fundedPrice = 0;
    for (let i = 5; i < packet.length; i += 3) fundedPrice = Math.max(fundedPrice, Number(packet[i]) || 0);
    return budget(state) - nonnegative(packet[2]) >= fundedPrice + Number(packet[3]);
}
function budgetFor(packet, wallet, escrow, r, capture = null) {
    let prior = 0;
    for (let i = 4; i + 2 < packet.length; i += 3) if (packet[i] > r) prior = packet[i + 1];
    if (capture) capture.priorityReserve = nonnegative(prior);
    return Math.max(0, nonnegative(wallet) + nonnegative(escrow) - nonnegative(packet[2]) - prior);
}
// A paid funded contribution no longer needs cash protection. Keep the same
// bounded packet and priority rule; crafting inputs can name their admitted
// root ratio even when the funded root item is the eventual product.
function packetAfterPurchase(packet, spent, funding = {}) {
    if (!Array.isArray(packet) || packet.length < 4 || !(spent > 0)
        || !Number.isFinite(spent) || funding.free === true) return packet;
    let rate = null, itemIndex = -1;
    if (funding.r !== undefined) {
        if (!(Number(funding.r) > 0) || !Number.isFinite(Number(funding.r))) return packet;
        rate = significant(Number(funding.r));
    } else if (funding.valueHours === undefined && Number(funding.itemId) > 0) {
        for (let index = 4; index + 2 < packet.length; index += 3) {
            if (Number(packet[index + 2]) === Number(funding.itemId)) { itemIndex = index; break; }
        }
        if (itemIndex < 0) return packet;
    } else return packet;
    const next = packet.slice();
    let previous = 0, cumulative = 0, remaining = spent, changed = false;
    for (let index = 4; index + 2 < packet.length; index += 3) {
        const original = nonnegative(packet[index + 1]);
        let contribution = Math.max(0, original - previous);
        previous = original;
        if (index === itemIndex || rate !== null && Number(packet[index]) === rate) {
            const paid = Math.min(remaining, contribution);
            contribution -= paid; remaining -= paid; changed ||= paid > 0;
        }
        cumulative += contribution;
        next[index + 1] = cumulative;
    }
    return changed ? next : packet;
}
// The Adena a finite value is worth at the money price (hours per Adena).
function worth(packet, valueHours) { return packet[1] > 0 ? nonnegative(valueHours) / packet[1] : Infinity; }
// The treasury money a member carries for its pending clan errands
// (ClanPurchaseCredit): the clan's, not the member's, while it waits or
// travels (E193). `own` ({ clanId?, selfId }) is the clan errand whose own
// purchase is being funded; its credit is that purchase's clanPart.
function clanCredit(state, own = null) {
    const stats = state?.stats;
    if (stats?.marketErrand?.purpose !== 'clan'
        && !(Array.isArray(stats?.marketErrands) && stats.marketErrands.some(errand => errand?.purpose === 'clan'))) return 0;
    let held = 0;
    for (const errand of CombinedErrands.pending(state)) {
        if (errand.purpose !== 'clan' || own && (own.clanId === undefined || Number(errand.tag?.clanId) === Number(own.clanId))
            && Number(errand.selfId) === Number(own.selfId)) continue;
        held += nonnegative(errand.tag?.clanPart);
    }
    return held;
}
function spendable(state = {}, escrow = 0, options = {}, captureOutput = null) {
    // A purchase that carries a clanPart (native terms) is its clan errand's own.
    const own = options.ownClanErrand || (options.free === true && options.clanPart !== undefined && options.itemId
        ? { selfId: options.itemId } : null);
    const wallet = Math.max(0, budget(state, escrow) - clanCredit(state, own)), packet = state.stats?.money;
    const selected = Diagnostics.active() && Diagnostics.enabled(state.characterId);
    // Native callers observe this same calculation; they never calculate a second wallet.
    const capture = Diagnostics.active() ? captureOutput || (selected ? {} : null) : null;
    let queueBudget = 0, reason = 'ratio_below_money_price';
    if (!Array.isArray(packet) || packet.length < 4) {
        if (Diagnostics.active()) moneyPacketMissing++;
        reason = 'money_packet_missing';
        queueBudget = Math.max(0, wallet - operatingReserve(state));
    } else if (options.upperBound) { reason = 'upper_bound'; queueBudget = Math.max(0, wallet - packet[2]); }
    else if (options.free === true) {
        // Already credited treasury money belongs to this physical wallet.
        // Exclude it from personal free cash before adding its actual remainder.
        const clanPart = Math.min(wallet, nonnegative(options.clanPart));
        reason = packet[3] === 0 ? 'free_money' : 'funding_gap';
        queueBudget = clanPart + (packet[3] === 0 ? budgetFor(packet, wallet - clanPart, 0, -Infinity, capture) : 0);
    }
    else {
        let r = Number(options.r ?? 0);
        if (options.itemId && options.r === undefined) {
            for (let i = 4; i + 2 < packet.length; i += 3) if (packet[i + 2] === Number(options.itemId)) { r = packet[i]; break; }
        }
        // Worth buying is value per Adena at the price really paid: a quote
        // above the planner's estimate lowers it by the same factor (E187).
        // The queue's own order still decides which money is held for others.
        const quoted = options.quoteScale > 0 ? r * options.quoteScale : r;
        if (quoted >= packet[1]) { reason = 'funded_ratio'; queueBudget = budgetFor(packet, wallet, 0, r, capture); }
    }
    // Native utility terms take precedence over a free/clan allowance too.
    if (Array.isArray(packet) && packet.length >= 4 && !options.upperBound && options.valueHours !== undefined) {
        reason = 'finite_value';
        queueBudget = Math.min(worth(packet, options.valueHours), budgetFor(packet, wallet, 0, packet[1], capture));
    }
    const available = Math.min(wallet, queueBudget + Math.min(wallet, nonnegative(options.survivalCost)));
    if (Diagnostics.active()) Diagnostics.count('funding', available > 0 ? 'allowed' : 'refused', reason);
    if (selected) Diagnostics.push({ owner: Number(state.characterId), phase: 'funding', caller: options.caller || 'spendable', reason,
        item: Number(options.itemId), wallet: nonnegative(state.adena ?? state.inventory?.[57]?.amount),
        escrow: nonnegative(escrow), available, budget: available, reserve: Number(packet?.[2]),
        priorityReserve: capture.priorityReserve, moneyPrice: Number(packet?.[1]), valueHours: Number(options.valueHours),
        decisionSeq: Number(state.stats?.decisionSeq), activityLeaf: Number(state.stats?.activityLeaf),
        revision: Number(state.simulation?.revision), wishKey: state.stats?.wishFocus?.[0] });
    return available;
}
// Finite action utility supplies a funding ratio, never an extra purse.
// Native writers still reread the current money packet and physical wallet.
// A shot, potion or scroll restock: survival first (the kit's cost), the rest
// by its stock wish's rank at the quoted price. The wish was priced at the
// planner's estimate; when the NPC asks more, each unit is worth less per
// Adena and the optional part may drop below the money price (E187).
function quoteScale(estimate, quote) {
    return Number(estimate) > 0 && Number(quote) > 0 ? Number(estimate) / Number(quote) : 1;
}
function stockAllowance(state, wish, itemId, survivalCost, scale = 1) {
    return spendable(state, 0, { ...stockTerms(wish, itemId, survivalCost), quoteScale: scale });
}
// A stock purchase's terms, the same for the planner and the native writer:
// the kit's survival tranche and its stock wish's rank (else its packet row).
function stockTerms(wish, itemId, survivalCost) {
    return { itemId, survivalCost, ...(wish ? { r: significant(wish.ratio) } : {}) };
}
function forOpportunity(state, opportunity, escrow = 0) {
    if (!opportunity?.known || !Number.isFinite(opportunity.valueHours) || opportunity.valueHours <= 0
        || !Number.isFinite(opportunity.cashNow) || opportunity.cashNow < 0) return 0;
    return spendable(state, escrow, { r: opportunity.cashNow > 0
        ? opportunity.valueHours / opportunity.cashNow : Infinity });
}
function nativeTerms(options = {}, itemId = 0) {
    const terms = { itemId: Math.max(0, Number(itemId) || 0) };
    if (Number.isFinite(Number(options.r)) || options.r === Infinity) terms.r = Number(options.r);
    if (options.valueHours !== undefined && Number.isFinite(Number(options.valueHours))) terms.valueHours = Math.max(0, Number(options.valueHours));
    if (options.survivalCost !== undefined && Number.isFinite(Number(options.survivalCost))) terms.survivalCost = Math.max(0, Number(options.survivalCost));
    if (options.free === true) terms.free = true;
    if (options.clanPart !== undefined && Number.isFinite(Number(options.clanPart)) && Number(options.clanPart) >= 0) terms.clanPart = Number(options.clanPart);
    return terms;
}
// A root's place in the money queue (r) as a goal and the compact card carry
// it: only a funded root has one.
function rootRatio(wish) {
    return wish?.funded && Number(wish.ratio) > 0 ? significant(Number(wish.ratio)) : 0;
}
// The funding terms of a buy goal, one rule for every reader: its root's
// place in the money queue when the goal carries one, else the money
// packet's row for its item.
// A card leaf's ratio: the card's own r, else its funded root's.
function leafRatio(leaf, wish) {
    return leaf?.r > 0 ? leaf.r : rootRatio(wish);
}
function goalTerms(goal, itemId = goal?.target?.itemId) {
    return goal?.plan?.valueRate === undefined ? { itemId } : { r: goal.plan.valueRate };
}
// ARCH-NOTE: round value rates upward to three digits so a stored money floor
// never falls below 1/hour; applying the same monotone rounding keeps funded ratios admissible.
function significant(value) {
    value = nonnegative(value);
    if (!value) return 0;
    const scale = 10 ** (2 - Math.floor(Math.log10(value)));
    return Number((Math.ceil(value * scale) / scale).toPrecision(3));
}
// The money packet keeps this many (ratio, cumulative, itemId) rows; with more
// funded wishes the last row merges the tail and carries itemId 0 (FX-E3).
const PACKET_ROWS = 8;
// Funded queue wishes that own an itemId row of packetFor, in queue order.
function packetRowWishes(funded) {
    return funded.length <= PACKET_ROWS ? funded : funded.slice(0, PACKET_ROWS - 1);
}
function packetFor(network, hour, reserve) {
    const { fundable, cashCharge } = require('./WishNetwork');
    const packet = [Math.round(hour), significant(network.moneyPrice), Math.round(reserve), Math.round(network.gap ? cashCharge(network.gap) : 0)];
    let cumulative = 0, count = 0;
    for (const wish of network.queue) {
        // An unsupported wish keeps its queue place without money (MVP-1).
        if (!fundable(wish)) continue;
        if (!wish.funded) break;
        cumulative += cashCharge(wish); count++;
        const ratio = significant(wish.ratio);
        if (count <= PACKET_ROWS) packet.push(ratio, Math.round(cumulative), Number(wish.object?.itemId || 0));
        else { const last = 4 + 3 * (PACKET_ROWS - 1); packet[last] = ratio; packet[last + 1] = Math.round(cumulative); packet[last + 2] = 0; }
    }
    return packet;
}
function tripEscrow(plan, escrow = 0) { return plan?.market?.sourceType === 'npc' ? escrow : 0; }
module.exports = { budget, operatingReserve, shortfall, surplus, spendable, clanCredit, stockAllowance, quoteScale, forOpportunity, nativeTerms, tripEscrow, budgetFor, packetAfterPurchase, moneyReached, packetFor, packetRowWishes, PACKET_ROWS, significant, rootRatio, leafRatio, goalTerms, stockTerms,
    summary: () => Diagnostics.active() ? ({ moneyPacketMissing }) : ({ enabled: false }), resetCounters: () => { moneyPacketMissing = 0; } };
