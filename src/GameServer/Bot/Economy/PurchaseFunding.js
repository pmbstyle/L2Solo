const Diagnostics = require('./EconomyDiagnostics');
const Trace = require('../DecisionTrace');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
const Packet = require('./StatsPacket');
const BoardRules = require('../../AfkTrade/BoardRules');
// One wallet rule for hot/cold purchases. Value rates are hours per adena;
// every funded row ahead of a spend in queue order keeps its cost; a spend that is no funded
// row gets only the money above every funded row (budgetFor).
const nonnegative = value => Math.max(0, Number(value) || 0);
let moneyPacketMissing = 0;
function budget(state = {}, escrow = 0) {
    return nonnegative(state.adena ?? state.inventory?.[57]?.amount) + nonnegative(escrow);
}
// EconomyContext and WishNetwork load this module at their top: each is
// required once, at its first call, and held.
let EconomyContext, WishNetwork;
function operatingReserve(state = {}) {
    // lazy: cycle EconomyContext requires PurchaseFunding at load.
    return (EconomyContext ||= require('./EconomyContext')).refillReserve(state);
}
function shortfall(state = {}, price = 0, reserve = 0, escrow = 0) {
    return Math.max(0, nonnegative(price) + nonnegative(reserve) - budget(state, escrow));
}
function surplus(state = {}, price = 0, reserve = 0) {
    return Math.max(0, budget(state) - nonnegative(price) - nonnegative(reserve));
}
// The funded row a rank r names: its ratio as given (a rank read from the packet) or as the
// packet rounds it (significant), else -1.
function fundedRow(packet, r) {
    if (!(Number(r) > 0) || !Number.isFinite(Number(r))) return -1;
    const exact = Number(r), rank = significant(exact);
    for (let row = 0, rows = Packet.fundedRows(packet); row < rows; row++) {
        const ratio = Packet.fundedRatio(packet, row);
        if (ratio === exact || ratio === rank) return row;
    }
    return -1;
}
// The rank r when it is one of the packet's funded rows (its ratio as the packet keeps it), else null.
function fundedRank(packet, r) {
    const row = fundedRow(packet, r);
    return row < 0 ? null : Packet.fundedRatio(packet, row);
}
// The money a spend at rank r may take: the wallet above the reserve and the money the
// queue holds for the funded rows ahead of it. The rows stand in queue order, tier first,
// then value per Adena, so a row of a higher tier may hold a lower ratio: a funded root's
// own row reads the money above the rows before it, any other rank (an unfunded root, a
// later tier, a side purchase: -Infinity) the money above every funded row, as the network
// funds a root only from what the roots ahead of it leave. Infinity (a companion's errand)
// stands ahead of the whole queue.
function budgetFor(packet, wallet, escrow, r, capture = null) {
    const rows = r === Infinity ? 0 : Packet.fundedRows(packet), own = r === Infinity ? -1 : fundedRow(packet, r);
    const ahead = own < 0 ? rows : own;
    const prior = ahead > 0 ? Packet.fundedCumulative(packet, ahead - 1) : 0;
    if (capture) capture.priorityReserve = nonnegative(prior);
    return Math.max(0, nonnegative(wallet) + nonnegative(escrow) - nonnegative(Packet.refillReserve(packet)) - prior);
}
// A paid funded contribution no longer needs cash protection. Keep the same
// bounded packet and priority rule; crafting inputs can name their admitted
// root ratio even when the funded root item is the eventual product.
function packetAfterPurchase(packet, spent, funding = {}) {
    if (!Packet.hasMoney(packet) || !(spent > 0)
        || !Number.isFinite(spent) || funding.free === true) return packet;
    const rows = Packet.fundedRows(packet);
    let rate = null, itemRow = -1;
    if (funding.r !== undefined && funding.r !== Infinity) {
        if (!(Number(funding.r) > 0) || !Number.isFinite(Number(funding.r))) return packet;
        rate = significant(Number(funding.r));
    } else if (funding.valueHours === undefined && Number(funding.itemId) > 0) {
        for (let row = 0; row < rows; row++) {
            if (Number(Packet.fundedItem(packet, row)) === Number(funding.itemId)) { itemRow = row; break; }
        }
        if (itemRow < 0) return packet;
    } else return packet;
    const next = packet.slice();
    let previous = 0, cumulative = 0, remaining = spent, changed = false;
    for (let row = 0; row < rows; row++) {
        const original = nonnegative(Packet.fundedCumulative(packet, row));
        let contribution = Math.max(0, original - previous);
        previous = original;
        if (row === itemRow || rate !== null && Number(Packet.fundedRatio(packet, row)) === rate) {
            const paid = Math.min(remaining, contribution);
            contribution -= paid; remaining -= paid; changed ||= paid > 0;
        }
        cumulative += contribution;
        Packet.setFundedCumulative(next, row, cumulative);
    }
    return changed ? next : packet;
}
// The Adena a finite value is worth at the money price (hours per Adena).
function worth(packet, valueHours) {
    const price = Packet.moneyPrice(packet);
    return price > 0 ? nonnegative(valueHours) / price : Infinity;
}
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
// Lazy (a load cycle), once: spendable runs per offer and a require per call stats the path.
let raidSupplyPolicy = null;
const raidSupply = () => (raidSupplyPolicy ||= require('../Population/RaidSupplyPolicy'));
// The rate of an item's own row in the money packet; undefined without one.
function itemRate(packet, itemId) {
    for (let row = 0, rows = Packet.fundedRows(packet); row < rows; row++) {
        if (Packet.fundedItem(packet, row) === Number(itemId)) return Packet.fundedRatio(packet, row);
    }
    return undefined;
}
function spendable(state = {}, escrow = 0, options = {}, captureOutput = null) {
    const raid = raidSupply().purchaseBudget(state, options);
    if (raid !== null) return raid;
    // A purchase that carries a clanPart (native terms) is its clan errand's own.
    const own = options.ownClanErrand || (options.free === true && options.clanPart !== undefined && options.itemId
        ? { selfId: options.itemId } : null);
    const wallet = Math.max(0, budget(state, escrow) - clanCredit(state, own)), packet = state.stats?.money;
    const selected = Trace.detailed(state.characterId);
    // Native callers observe this same calculation; they never calculate a second wallet.
    // A traced bot's record reads it with diagnostics off too (the decision trace samples bots on its own switch).
    const capture = Diagnostics.active() || selected ? captureOutput || (selected ? {} : null) : null;
    let queueBudget = 0, reason = 'ratio_below_money_price';
    if (!Packet.hasMoney(packet)) {
        if (Diagnostics.active()) moneyPacketMissing++;
        reason = 'money_packet_missing';
        queueBudget = Math.max(0, wallet - operatingReserve(state));
    } else if (options.upperBound) { reason = 'upper_bound'; queueBudget = Math.max(0, wallet - Packet.refillReserve(packet)); }
    else if (options.free === true) {
        // Already credited treasury money belongs to this physical wallet.
        // Exclude it from personal free cash before adding its actual remainder.
        const clanPart = Math.min(wallet, nonnegative(options.clanPart));
        const gap = Packet.firstUnfundedPrice(packet);
        reason = gap === 0 ? 'free_money' : 'funding_gap';
        queueBudget = clanPart + (gap === 0 ? budgetFor(packet, wallet - clanPart, 0, -Infinity, capture) : 0);
    }
    else {
        let r = Number(options.r ?? 0);
        if (options.itemId && options.r === undefined) r = itemRate(packet, options.itemId) ?? r;
        // Worth buying is value per Adena at the price really paid: a quote
        // above the planner's estimate lowers it by the same factor (E187).
        // The queue's own order still decides which money is held for others.
        const quoted = options.quoteScale > 0 ? r * options.quoteScale : r;
        if (quoted >= Packet.moneyPrice(packet)) { reason = 'funded_ratio'; queueBudget = budgetFor(packet, wallet, 0, r, capture); }
    }
    // Native utility terms take precedence over a free/clan allowance too. A purchase
    // whose rank is a funded row of the packet (the build funded it there) reads the
    // money above the rows ranked before it; any other (none, Infinity, unfunded)
    // the money above every funded row.
    if (Packet.hasMoney(packet) && !options.upperBound && options.valueHours !== undefined) {
        reason = 'finite_value';
        queueBudget = Math.min(worth(packet, options.valueHours),
            budgetFor(packet, wallet, 0, fundedRank(packet, options.r) ?? -Infinity, capture));
    }
    // A side purchase (T177) carries its own value per Adena and takes only the
    // money no queue row holds.
    if (Packet.hasMoney(packet) && !options.upperBound && options.side !== undefined) {
        reason = 'side';
        queueBudget = options.side >= Packet.moneyPrice(packet) ? budgetFor(packet, wallet, 0, -Infinity, capture) : 0;
    }
    // The survival tranche: what the reserve holds for the kit (survivalShare,
    // EconomyContext.kitCost at its list price) counts beside the queue's money;
    // the counter's quote above it (a town's tax) comes from that money, or,
    // when it falls short, from the wallet: the kit itself is never refused.
    const survivalCost = nonnegative(options.survivalCost);
    const survivalShare = Math.min(survivalCost, nonnegative(options.survivalShare ?? options.survivalCost));
    const available = Math.min(wallet, Math.max(queueBudget + Math.min(wallet, survivalShare), survivalCost));
    if (Diagnostics.active()) Diagnostics.count('funding', available > 0 ? 'allowed' : 'refused', reason);
    if (selected) Trace.detail({ owner: Number(state.characterId), phase: 'funding', caller: options.caller || 'spendable', reason,
        item: Number(options.itemId), wallet: nonnegative(state.adena ?? state.inventory?.[57]?.amount),
        escrow: nonnegative(escrow), available, budget: available, reserve: Number(Packet.refillReserve(packet)),
        priorityReserve: capture.priorityReserve, moneyPrice: Number(Packet.moneyPrice(packet)), valueHours: Number(options.valueHours),
        decisionSeq: Number(state.stats?.decisionSeq), activityLeaf: Number(state.stats?.activityLeaf),
        revision: Number(state.simulation?.revision), wishKey: state.stats?.wishFocus?.[0] });
    return available;
}
// What a purchase may pay now: the planner's rule (spendable over the bag and the money
// the bot's own buy orders hold, escrow) paid from the bag. One rule for the planner and
// every buyer: hot and cold, main and the native writer. stepBids: the money of the bids
// the step's buyer takes back before it pays (the card's `bids`, at most STEP_BIDS).
function payable(state = {}, escrow = 0, options = {}, captureOutput = null, stepBids = 0) {
    return Math.min(budget(state) + nonnegative(stepBids), spendable(state, escrow, options, captureOutput));
}
// The money the bot's own backed bids hold per item (item -> count x price of its BUY lines
// that hold escrow; a conditional bid holds none), from its board lines (BoardIndex.ownerLines,
// either thread). O(its lines).
function ownBids(lines) {
    const held = new Map();
    for (const line of lines || []) {
        if (Number(line.storeType) !== BoardRules.BUY || Number(line.custodyPolicy) === 1) continue;
        const id = Number(line.selfId);
        held.set(id, (held.get(id) || 0) + nonnegative(line.count) * nonnegative(line.price));
    }
    return held;
}
// What those of `items` hold.
function bidMoney(own, items) {
    let money = 0;
    for (const id of items || []) money += own.get(Number(id)) || 0;
    return money;
}
// A shop step names at most this many of its root's bids (the card keeps them).
const STEP_BIDS = 8;
// The money a shop step's buyer takes back to pay it (BotAfkMarketService.freeStepBids):
// what the bot's own bids (own: ownBids) on the step's named bids hold, the first STEP_BIDS
// of them. One reading for the build that admits the step (WishNetwork), the held step's
// check (EconomyContext) and every buyer (payable's stepBids), hot and cold.
function stepBids(own, bids) {
    return own?.size && bids?.length ? bidMoney(own, bids.slice(0, STEP_BIDS)) : 0;
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
function stockAllowance(state, wish, itemId, survival, scale = 1, extra = null) {
    return spendable(state, 0, { ...stockTerms(wish, itemId, survival), quoteScale: scale, ...extra });
}
// A kit item's survival tranche at a counter's quote: { cost } its missing
// units at the quote, { share } what the reserve holds for them (one economy's kitCost).
function survivalTranche(economy, itemId, quote = null) {
    return { cost: economy.kitCost(itemId, quote), share: economy.kitCost(itemId) };
}
// A stock purchase's terms, the same for the planner and the native writer:
// the kit's survival tranche and its stock wish's rank (else its packet row).
// survival: survivalTranche's, or a number (cost and share alike).
function stockTerms(wish, itemId, survival) {
    const cost = typeof survival === 'object' && survival ? survival.cost : survival;
    const share = typeof survival === 'object' && survival ? survival.share : survival;
    return { itemId, survivalCost: cost, ...(share !== cost ? { survivalShare: share } : {}), ...(wish ? { r: significant(wish.ratio) } : {}) };
}
function forOpportunity(state, opportunity, escrow = 0) {
    if (!opportunity?.known || !Number.isFinite(opportunity.valueHours) || opportunity.valueHours <= 0
        || !Number.isFinite(opportunity.cashNow) || opportunity.cashNow < 0) return 0;
    return spendable(state, escrow, { r: opportunity.cashNow > 0
        ? opportunity.valueHours / opportunity.cashNow : Infinity });
}
function nativeTerms(options = {}, itemId = 0) {
    const terms = { itemId: Math.max(0, Number(itemId) || 0) };
    if (typeof options.raidPreparationId === 'string') terms.raidPreparationId = options.raidPreparationId;
    if (Number.isFinite(Number(options.r)) || options.r === Infinity) terms.r = Number(options.r);
    if (options.valueHours !== undefined && Number.isFinite(Number(options.valueHours))) terms.valueHours = Math.max(0, Number(options.valueHours));
    if (options.survivalCost !== undefined && Number.isFinite(Number(options.survivalCost))) terms.survivalCost = Math.max(0, Number(options.survivalCost));
    if (options.survivalShare !== undefined && Number.isFinite(Number(options.survivalShare))) terms.survivalShare = Math.max(0, Number(options.survivalShare));
    if (options.side !== undefined && Number.isFinite(Number(options.side))) terms.side = Math.max(0, Number(options.side));
    if (options.free === true) terms.free = true;
    if (options.clanPart !== undefined && Number.isFinite(Number(options.clanPart)) && Number(options.clanPart) >= 0) terms.clanPart = Number(options.clanPart);
    return terms;
}
// ARCH-NOTE: Player companion errands use the player's choice; autonomous bots
// spend only on their funded item. A companion stands ahead of its own money
// queue: it spends the wallet above the reserve (r Infinity is upperBound in the
// terms the native writer checks at the counter). Its item's row, if any, is paid.
function companionTerms(itemId) {
    return nativeTerms({ r: Infinity }, itemId);
}
// A root's place in the money queue (r) as a goal and the compact card carry
// it: only a funded root has one.
function rootRatio(wish) {
    return wish?.funded && Number(wish.ratio) > 0 ? significant(Number(wish.ratio)) : 0;
}
// A card leaf's ratio: the card's own r, else its funded root's.
function leafRatio(leaf, wish) {
    return leaf?.r > 0 ? leaf.r : rootRatio(wish);
}
// A card leaf stamped with its place in the money queue.
function stampRatio(leaf, wish) {
    const r = leafRatio(leaf, wish);
    if (r > 0) leaf.r = r;
    return leaf;
}
// The funding terms of a buy goal, one rule for every reader: its root's
// place in the money queue when the goal carries one, else the money
// packet's row for its item.
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
// The money packet keeps this many funded rows; with more funded wishes the
// last row merges the tail and carries itemId 0 (FX-E3, StatsPacket).
const PACKET_ROWS = Packet.MONEY_ROWS;
// Funded queue wishes that own an itemId row of packetFor, in queue order.
function packetRowWishes(funded) {
    return funded.length <= PACKET_ROWS ? funded : funded.slice(0, PACKET_ROWS - 1);
}
function packetFor(network, hour, reserve) {
    // lazy: cycle WishNetwork requires PurchaseFunding at load.
    const { fundable, cashCharge } = WishNetwork ||= require('./WishNetwork');
    const packet = Packet.money({ hourAdena: Math.round(hour), moneyPrice: significant(network.moneyPrice), refillReserve: Math.round(reserve),
        firstUnfundedPrice: Math.round(network.gap ? cashCharge(network.gap) : 0) });
    let cumulative = 0, count = 0;
    for (const wish of network.queue) {
        // An unsupported wish keeps its queue place without money (MVP-1).
        if (!fundable(wish)) continue;
        if (!wish.funded) break;
        cumulative += cashCharge(wish); count++;
        Packet.addFunded(packet, significant(wish.ratio), Math.round(cumulative),
            count <= PACKET_ROWS ? Number(wish.object?.itemId || 0) : 0);
    }
    return packet;
}
module.exports = { itemRate, budget, operatingReserve, shortfall, surplus, spendable, payable, ownBids, STEP_BIDS, stepBids, clanCredit, stockAllowance, survivalTranche, quoteScale, forOpportunity, nativeTerms, companionTerms, budgetFor, packetAfterPurchase, packetFor, packetRowWishes, PACKET_ROWS, significant, rootRatio, leafRatio, stampRatio, goalTerms, stockTerms,
    summary: () => Diagnostics.active() ? ({ moneyPacketMissing }) : ({ enabled: false }), resetCounters: () => { moneyPacketMissing = 0; } };
