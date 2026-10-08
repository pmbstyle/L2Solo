const Diagnostics = require('./EconomyDiagnostics');
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
function spendable(state = {}, escrow = 0, options = {}) {
    const wallet = budget(state, escrow), packet = state.stats?.money;
    const capture = Diagnostics.active() && Diagnostics.enabled(state.characterId) ? {} : null;
    let queueBudget = 0, reason = 'ratio_below_money_price';
    if (!Array.isArray(packet) || packet.length < 4) {
        if (Diagnostics.active()) moneyPacketMissing++;
        reason = 'money_packet_missing';
        queueBudget = Math.max(0, wallet - operatingReserve(state));
    } else if (options.upperBound) { reason = 'upper_bound'; queueBudget = Math.max(0, wallet - packet[2]); }
    else if (options.free) { reason = packet[3] === 0 ? 'free_money' : 'funding_gap'; queueBudget = packet[3] === 0 ? budgetFor(packet, wallet, 0, -Infinity, capture) : 0; }
    else {
        let r = Number(options.r ?? 0);
        if (options.itemId && options.r === undefined) {
            for (let i = 4; i + 2 < packet.length; i += 3) if (packet[i + 2] === Number(options.itemId)) { r = packet[i]; break; }
        }
        if (options.valueHours !== undefined) { reason = 'finite_value'; queueBudget = Math.min(packet[1] > 0 ? nonnegative(options.valueHours) / packet[1] : Infinity,
            budgetFor(packet, wallet, 0, packet[1], capture)); }
        else if (r >= packet[1]) { reason = 'funded_ratio'; queueBudget = budgetFor(packet, wallet, 0, r, capture); }
    }
    const available = Math.min(wallet, queueBudget + Math.min(wallet, nonnegative(options.survivalCost)));
    if (Diagnostics.active()) Diagnostics.count('funding', available > 0 ? 'allowed' : 'refused', reason);
    if (capture) Diagnostics.push({ owner: Number(state.characterId), phase: 'funding', caller: options.caller || 'spendable', reason,
        item: Number(options.itemId), wallet: nonnegative(state.adena ?? state.inventory?.[57]?.amount),
        escrow: nonnegative(escrow), available, budget: available, reserve: Number(packet?.[2]),
        priorityReserve: capture.priorityReserve, moneyPrice: Number(packet?.[1]), valueHours: Number(options.valueHours),
        decisionSeq: Number(state.stats?.decisionSeq), activityLeaf: Number(state.stats?.activityLeaf),
        revision: Number(state.simulation?.revision), wishKey: state.stats?.wishFocus?.[0] });
    return available;
}
// Finite action utility supplies a funding ratio, never an extra purse.
// Native writers still reread the current money packet and physical wallet.
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
// ARCH-NOTE: round value rates upward to three digits so a stored money floor
// never falls below 1/hour; applying the same monotone rounding keeps funded ratios admissible.
function significant(value) {
    value = nonnegative(value);
    if (!value) return 0;
    const scale = 10 ** (2 - Math.floor(Math.log10(value)));
    return Number((Math.ceil(value * scale) / scale).toPrecision(3));
}
function packetFor(network, hour, reserve) {
    const packet = [Math.round(hour), significant(network.moneyPrice), Math.round(reserve), Math.round(network.gap?.price || 0)];
    let cumulative = 0, count = 0;
    for (const wish of network.queue) {
        if (!wish.funded) break;
        cumulative += wish.price; count++;
        const ratio = significant(wish.ratio);
        if (count <= 8) packet.push(ratio, Math.round(cumulative), Number(wish.object?.itemId || 0));
        else { packet[25] = ratio; packet[26] = Math.round(cumulative); packet[27] = 0; }
    }
    return packet;
}
function tripEscrow(plan, escrow = 0) { return plan?.market?.sourceType === 'npc' ? escrow : 0; }
module.exports = { budget, operatingReserve, shortfall, surplus, spendable, forOpportunity, nativeTerms, tripEscrow, budgetFor, moneyReached, packetFor, significant,
    summary: () => Diagnostics.active() ? ({ moneyPacketMissing }) : ({ enabled: false }), resetCounters: () => { moneyPacketMissing = 0; } };
