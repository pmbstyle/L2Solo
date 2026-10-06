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
function budgetFor(packet, wallet, escrow, r) {
    let prior = 0;
    for (let i = 4; i + 2 < packet.length; i += 3) if (packet[i] > r) prior = packet[i + 1];
    return Math.max(0, nonnegative(wallet) + nonnegative(escrow) - nonnegative(packet[2]) - prior);
}
function spendable(state = {}, escrow = 0, options = {}) {
    const wallet = budget(state, escrow), packet = state.stats?.money;
    let queueBudget = 0;
    if (!Array.isArray(packet) || packet.length < 4) {
        moneyPacketMissing++;
        queueBudget = Math.max(0, wallet - operatingReserve(state));
    } else if (options.upperBound) queueBudget = Math.max(0, wallet - packet[2]);
    else if (options.free) queueBudget = packet[3] === 0 ? budgetFor(packet, wallet, 0, -Infinity) : 0;
    else {
        let r = Number(options.r ?? 0);
        if (options.itemId && options.r === undefined) {
            for (let i = 4; i + 2 < packet.length; i += 3) if (packet[i + 2] === Number(options.itemId)) { r = packet[i]; break; }
        }
        if (options.valueHours !== undefined) queueBudget = Math.min(packet[1] > 0 ? nonnegative(options.valueHours) / packet[1] : Infinity,
            budgetFor(packet, wallet, 0, packet[1]));
        else if (r >= packet[1]) queueBudget = budgetFor(packet, wallet, 0, r);
    }
    return Math.min(wallet, queueBudget + Math.min(wallet, nonnegative(options.survivalCost)));
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
module.exports = { budget, operatingReserve, shortfall, surplus, spendable, tripEscrow, budgetFor, packetFor, significant,
    summary: () => ({ moneyPacketMissing }), resetCounters: () => { moneyPacketMissing = 0; } };
