'use strict';

// Facts, reusable calculations and a new character decision are different
// things. Only these compact boundaries belong to the saved decision; graphs
// stay in EconomyContext's existing bounded working cache.
const { fnv1a32 } = require('../Fnv1a');
const { createHash } = require('node:crypto');
const PurchaseFunding = require('./PurchaseFunding');
const Karma = require('../../Karma');
const Warehouse = require('./PersonalWarehouseIndex');
const ClanSupply = require('../../Clan/ClanSupplyPolicy');
const Providers = require('./WishProviders');
const Floor = require('../Population/SurvivalFloor');
const InventoryLimits = require('../../Inventory/InventoryLimits');
const Diagnostics = require('./EconomyDiagnostics');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const DataCache = invoke('GameServer/DataCache');
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const positive = n => Math.max(0, Number(n) || 0);
const hash = value => fnv1a32(JSON.stringify(value));
const SAMPLE_BYTES = 20;
function sampleRows(value) {
    if (typeof value === 'string') {
        if (!value.startsWith('s1:') || value.length > 3 + Math.ceil(Hunt.MAX_SPOTS * SAMPLE_BYTES / 3) * 4) return null;
        const encoded = value.slice(3), bytes = Buffer.from(encoded, 'base64');
        if (!bytes.length || bytes.length % SAMPLE_BYTES || bytes.toString('base64') !== encoded) return null;
        value = [];
        for (let at = 0; at < bytes.length; at += SAMPLE_BYTES) {
            value.push([bytes.readUInt32LE(at), bytes.readDoubleLE(at + 4), bytes.readDoubleLE(at + 12)]);
        }
    }
    if (!Array.isArray(value) || value.length > Hunt.MAX_SPOTS) return null;
    for (const row of value) {
        if (!Array.isArray(row) || row.length !== 3 || !Number.isInteger(row[0]) || row[0] < 0 || row[0] > 0xffffffff
            || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) return null;
    }
    return value;
}
function packSample(rows) {
    if (!Array.isArray(rows) || !sampleRows(rows)) return null;
    if (!rows.length) return [];
    const bytes = Buffer.allocUnsafe(rows.length * SAMPLE_BYTES);
    rows.forEach((row, at) => {
        const offset = at * SAMPLE_BYTES;
        bytes.writeUInt32LE(row[0], offset); bytes.writeDoubleLE(row[1], offset + 4); bytes.writeDoubleLE(row[2], offset + 12);
    });
    return `s1:${bytes.toString('base64')}`;
}
function observationBaselineValid(baseline, rows) {
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return false;
    if (rows === undefined) rows = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
    return rows !== null && (!Object.hasOwn(baseline, 'share') || Number.isFinite(baseline.share)
        && baseline.share >= 0 && baseline.share <= 1);
}
// The decision sections in the order of their wishDirty bit (1 << at): one
// table for the raise (DecisionEvents) and the names its readers count.
const SECTIONS = Object.freeze(['build', 'combat', 'supply', 'benefits', 'sources', 'occupation', 'money', 'relations']);
function sectionBit(name) {
    if (name === 'funding') name = 'money';
    const at = SECTIONS.indexOf(name);
    if (at < 0) throw new Error(`decision section: unknown ${name}`);
    return 1 << at;
}
function sectionMask(names) {
    return names.reduce((bits, name) => bits | sectionBit(name), 0);
}
// The computed pieces of a decision and the sections each reads: at the
// decision point a piece is reused while none of its sections is raised
// (EconomyContext.forState's mask), rebuilt when one is.
// foundation: hunt income, risk, death and kit hours, stock targets, the
// survival reserve (kit, profile, consumables, the observation; not money).
// Of the relations fact it reads only the party role (its spot value table
// and hunt income); relations is in its list for it, so a party join
// rebuilds it (a deviation from the spec's four sections).
// sources: the source walk (worn gear and level; party, clan, role;
// exclusions, risk, hunt rows; the plan, persona, craft station, trades;
// the hour adena and the money mark). weighing: focus, step and money queue.
// route: the bot's hunting spot search (BotRoute.choose), kept in the worker's
// record: kit and level (build), party and clan (relations), the ground and
// the exclusion and "was full" marks (occupation, sources). The matchup it
// filters with reads the kit, so build covers it; buffs and night are read-time.
const FOUNDATION = sectionMask(['build', 'combat', 'supply', 'occupation', 'relations']);
const COMPUTED = Object.freeze({
    foundation: FOUNDATION,
    sources: sectionMask(['build', 'relations', 'occupation', 'sources', 'money']),
    weighing: sectionMask(SECTIONS),
    route: sectionMask(['build', 'relations', 'occupation', 'sources']),
    // The source walk's per-spot ground verdict (GearAcquisitionPlanner.sourceGround):
    // level and kit matchup; its other reads are checked beside it.
    sourceGround: sectionMask(['build']),
    // The crafter's workshop (its best recipe and income per hour, the
    // occupation planner's answer), kept with the held build: the planner
    // reads the money packet (stats.money: hour adena, trip value, craft
    // labour), which the foundation writes every build, and the kept
    // recipe's market (its watch rows raise money).
    workshop: FOUNDATION | sectionMask(['money'])
});
// The one table of what a moved fact touches, for near and far bots alike
// (factEvents over factsOf). build: the kit (class, level, gear, hennas,
// skills, craft); bag: the bag full or its weight level, which changes the
// loot worth taking.
const FACT_SECTIONS = Object.freeze({
    build: Object.freeze(['build', 'benefits', 'sources']),
    recipes: Object.freeze(['build', 'benefits', 'sources']),
    dead: Object.freeze(['combat']),
    relations: Object.freeze(['relations']),
    funding: Object.freeze(['money']),
    occupation: Object.freeze(['occupation']),
    riskDeaths: Object.freeze(['combat', 'occupation']),
    supply: Object.freeze(['supply']),
    bag: Object.freeze(['supply', 'sources']),
    stores: Object.freeze(['supply', 'sources'])
});
// The names of the sections raised in wishDirty bits, in table order.
function sectionNames(bits) {
    const names = [];
    for (let at = 0; at < SECTIONS.length; at++) if (bits & 1 << at) names.push(SECTIONS[at]);
    return names;
}
// The kit fact of a view: class, level, worn gear, hennas, skills, the hot
// capture (view.kitHashes: ColdCombatProfile.kitHash of combatView's parts,
// hashed once per view), the craft
// (level, station, workshop), the soul crystal quest and the karma flip that
// closes the towns. Effects and night are no economy input, so a buff or the
// day/night flip moves no fact; the clan is a relations fact; the recipe book
// is its own fact. Its parts do not read the clock.
function kitFact(view) {
    return hash([view.kitHashes, view.craftLevel, view.craftStationId, view.workshop,
        view.soulCrystalQuest, view.closesTowns]);
}
// The kit part of the far reader (stateView), without the bag scan.
function kitView(state) {
    const stats = state.stats || {};
    return { kitHashes: CombatProfile.kitHash(CombatProfile.combatView(state)), craftLevel: state.craftLevel ?? stats.dwarvenCraftLevel,
        craftStationId: stats.craftStationId ?? null, workshop: stats.workshop,
        soulCrystalQuest: !!stats.soulCrystalQuest, closesTowns: Karma.closesTowns(stats.karma) };
}
function kit(state) {
    return kitFact(kitView(state));
}
function fundingMark(state, escrow = 0) {
    const packet = state.stats?.money;
    if (!Array.isArray(packet)) return 0;
    const wallet = PurchaseFunding.budget(state, escrow) - positive(packet[2]);
    const funded = [];
    for (let at = 5; at < packet.length; at += 3) funded.push(wallet >= positive(packet[at]));
    // Items or adena on their way from the board are a board-side money fact.
    return hash([wallet >= 0, ...funded, PurchaseFunding.moneyReached(state, escrow), state.incomingPending === true]);
}
function reachesUpper(wallet, bounds) {
    const high = bounds?.[1];
    return high !== null && high !== undefined && wallet >= high;
}
// Hard (allowSoft false): the held option became unaffordable or its
// funding/obligation mark moved. Soft: a newly payable next wish or a drift
// beyond the bot's error (the soft point's, softEvents).
function moneyChanged(state, baseline, escrow, allowSoft) {
    if (!baseline) return false;
    const physicalWallet = positive(state.adena), budgetTracked = Array.isArray(baseline.budgetBounds);
    const decisionBudget = budgetTracked ? PurchaseFunding.budget(state, escrow) : physicalWallet;
    // Old saved decisions recorded both kinds of edge in physical cash. Keep
    // that conservative comparison until an actual build supplies both bounds.
    if (physicalWallet < Number(baseline.cashBounds?.[0] ?? -1)
        || budgetTracked && decisionBudget < Number(baseline.budgetBounds[0])
        || baseline.funding !== fundingMark(state, budgetTracked ? escrow : 0)) return true;
    return allowSoft && (reachesUpper(physicalWallet, baseline.cashBounds)
        || budgetTracked && reachesUpper(decisionBudget, baseline.budgetBounds)
        || Number(baseline.moneyError) >= 0
            && Math.abs(decisionBudget - baseline.wallet) > baseline.moneyError);
}
function meaningfulMoney(state, baseline = state.stats?.wishSections, escrow = 0) {
    return moneyChanged(state, baseline, escrow, true);
}
function baselineIdentity(baseline) {
    const canonical = (value, depth = 0) => {
        if (depth > 8) throw new TypeError('decision_baseline_depth');
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (Array.isArray(value)) return ['array', value.map(row => canonical(row, depth + 1))];
        if (value && typeof value === 'object') return ['object', Object.keys(value).sort()
            .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key], depth + 1)])];
        throw new TypeError('decision_baseline_value');
    };
    try {
        if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
        const rows = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
        if (!observationBaselineValid(baseline, rows)) return null;
        if (Object.hasOwn(baseline, 'sample')) {
            baseline = { ...baseline, sample: rows };
        }
        return createHash('sha256').update(JSON.stringify(canonical(baseline))).digest('hex');
    } catch (_) { return null; }
}
function carrySectionBaseline(previous, current, updated) {
    if (!previous || !Number.isFinite(previous.at) || current.at < previous.at) return current;
    const carry = (mask, fields) => {
        if (updated & mask) return;
        for (const name of fields) {
            if (Object.hasOwn(previous, name)) current[name] = previous[name];
            else delete current[name];
        }
    };
    carry(sectionBit('money'), ['wallet', 'cashBounds', 'budgetBounds', 'funding', 'moneyError']);
    carry(sectionBit('occupation') | sectionBit('build'), ['sample', 'share', 'incomeError', 'frustration', 'bond']);
    carry(sectionBit('money') | sectionBit('sources') | sectionBit('supply'), ['bagValue']);
    return current;
}
function incomeError(state, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    return Learning.knowledgeEnabled() ? Learning.stageError(Learning.INCOME_ERROR_FLOOR + .25 * (1 - Number(persona?.understanding ?? .3)),
        Learning.INCOME_ERROR_FLOOR, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
}
// A sample row: the spot, exp and net income per ms of its cycle.
function sampleOf(rows) {
    return rows.map(row => [hash(row.spotId), row.exp / row.cycleMs,
        (positive(row.adena) + positive(row.loot) - positive(row.costs)) / row.cycleMs]);
}
function sample(state, timestamp = Date.now(), mode) {
    return sampleOf(Hunt.sampledRows(state, timestamp, mode));
}
// noise: each current row's own noise (BotHuntEfficiency.record); a drift
// inside the larger of the bot's error and that noise is no change. Rows
// match by spot hash: a round moves its spot's row to the front of the list
// (BotHuntEfficiency.record), which is no change of any value. noise is
// indexed like current.
function learnedChange(current, previous, error, share, previousShare, noise = []) {
    if (current.length !== previous.length) return true;
    const before = new Map(previous.map(row => [row[0], row]));
    return current.some((row, at) => !before.has(row[0]) || row.slice(1).some((value, index) => {
        const old = Number(before.get(row[0])[index + 1]) * previousShare;
        return !Number.isFinite(old) || Math.abs(value * share - old) > Math.abs(old) * Math.max(error, noise[at] || 0);
    }));
}
// The learned frustration the decision weighed its risk with (riskWeight's
// 1 + frustration), rounded: the baseline holds a few bytes.
const frustrationOf = state => Math.round(positive(state.stats?.frustration) * 1000) / 1000;
// bondNow: the caller's reader of the current relation bond
// (WishProviders.relationBond), called only once the rest held; null when the
// caller read no memory. The bond, like frustration, drifts beyond the error.
function bondChanged(baseline, bondNow, error) {
    const base = baseline.bond;
    if (!Array.isArray(base) || typeof bondNow !== 'function') return false;
    const bond = bondNow();
    return Array.isArray(bond) && bond.some((value, at) => Math.abs(value - Number(base[at])) > Math.abs(Number(base[at])) * error);
}
function observationChanged(state, baseline, timestamp, mode, bondNow = null) {
    if (!baseline) return true;
    const rows = Hunt.sampledRows(state, timestamp, mode), current = sampleOf(rows);
    const previous = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
    const share = Hunt.onSpotShare(state), previousShare = baseline.share ?? 1;
    const error = positive(baseline.incomeError);
    // Frustration drifts every round; it is an event only beyond the bot's
    // error on its risk weight (a baseline saved before it has none).
    const frustration = Number(baseline.frustration);
    return !observationBaselineValid(baseline, previous) || !Number.isFinite(share)
        || Math.abs(share - previousShare) > previousShare * error
        || Number.isFinite(frustration) && Math.abs(frustrationOf(state) - frustration) > (1 + frustration) * error
        || learnedChange(current, previous, error, share, previousShare, rows.map(row => positive(row.noise)))
        || bondChanged(baseline, bondNow, error);
}
function bounds(wallet) {
    const result = [-1, null];
    return { result, watch: price => {
        price = Number(price);
        if (!Number.isFinite(price) || price < 0) return;
        if (price <= wallet) result[0] = Math.max(result[0], price);
        else result[1] = result[1] === null ? price : Math.min(result[1], price);
    } };
}
// facts: the build's semanticFacts(state) when its caller already has them.
// bond: the build's relation bond (WishProviders.relationBond), null without one.
// threat: the gear-threat mask the build weighed (context.gearThreatMask),
// compared hard by the held verdict. marketWatch: the build's watch rows
// [itemId, storeType, reference price, error] (at most MARKET_WATCH), read by
// the soft point (softEvents); recorded by every build, never carried.
function snapshot(state, context, cashBounds, moneyError = -1, mode, money = null, facts = null, bond = null, marketWatch = null) {
    const persona = context.persona;
    const actual = { ...state, stats: { ...state.stats, money: context.statsPacket.money } };
    const budgetTracked = Array.isArray(money?.budgetBounds), escrow = budgetTracked ? money.buyOrderEscrow : 0;
    // budgetBounds tags the budget-aware schema. Its wallet/error use total
    // purchase funds; cashBounds still records physical fees. Old wallets are cash.
    const wallet = budgetTracked ? PurchaseFunding.budget(state, escrow) : positive(state.adena);
    const share = Hunt.onSpotShare(state);
    return { at: Number(context.timestamp), wallet, cashBounds, funding: fundingMark(actual, escrow), moneyError,
        ...(budgetTracked ? { budgetBounds: money.budgetBounds } : {}),
        bagValue: positive(context.choiceBagValue),
        ...(facts || semanticFacts(state)), threat: context.gearThreatMask,
        frustration: frustrationOf(state), ...(bond ? { bond } : {}),
        incomeError: incomeError(state, persona), sample: packSample(sample(state, context.timestamp, mode)),
        ...(share === 1 ? {} : { share }), ...(marketWatch?.length ? { marketWatch } : {}) };
}
// The soft point (far bots, the end of every step): the sections whose soft
// inputs crossed the bot's own error since its decision, empty when quiet;
// no clock: a drift inside the error is never an event, however long.
// baseline: the decision's (stats.wishSections). input: { board (the board
// mirror, null: not ready, the market part waits), buyOrderEscrow, memory (a
// reader of the bot's memory rows, called only when the bond is compared),
// timestamp (the step's) }.
function softEvents(state, baseline, input) {
    if (!baseline) return NONE;
    let sections = NONE;
    // Diagnostics only: soft:step:far counts the soft points, soft:raise:<source>
    // the raises by source (the observation share per far step is read live).
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('soft', 'step', 'far');
    const add = source => {
        const names = SOFT_SECTIONS[source];
        sections = sections === NONE ? [...names] : [...new Set([...sections, ...names])];
        if (diagnostic) Diagnostics.count('soft', 'raise', source);
    };
    if (meaningfulMoney(state, baseline, input.buyOrderEscrow)) add('money');
    const bondNow = () => Providers.relationBond(state, { memory: input.memory?.() ?? null });
    if (observationChanged(state, baseline, input.timestamp, undefined, bondNow)) add('observation');
    if (input.board && marketCrossed(input.board, baseline.marketWatch, Number(state.characterId))) add('market');
    return sections;
}
const NONE = Object.freeze([]);
const SOFT_SECTIONS = Object.freeze({ money: Object.freeze(['money']),
    observation: Object.freeze(['occupation', 'benefits', 'sources']), market: Object.freeze(['sources', 'money']) });
// The watch rows against the board mirror, one head read per row: a sell line
// (SELL) below the reference by more than the error, or a buy line (BUY)
// above it by more than the error. Rows of another shape
// (a baseline saved by an older build) are skipped.
const MARKET_WATCH = 20;
function marketCrossed(board, watch, ownerId) {
    if (!Array.isArray(watch)) return false;
    const exclude = { excludeOwner: ownerId };
    for (let at = 0; at < watch.length && at < MARKET_WATCH; at++) {
        const row = watch[at];
        if (!Array.isArray(row)) continue;
        const [itemId, storeType, price, error] = row;
        if (!(itemId > 0) || !(price > 0) || !(error >= 0)) continue;
        const line = board.first(itemId, storeType, exclude);
        if (!line) continue;
        if (storeType === SELL ? line.price < price * (1 - error) : storeType === BUY && line.price > price * (1 + error)) return true;
    }
    return false;
}
// Who the friend and the enemy are (WishProviders.relationTargets over the
// bot's memory), not how much: their trust and hostility are the soft bond.
function relationTargetIds(state, memory = null) {
    const { friend, enemy } = Providers.relationTargets(state, { memory });
    return [friend?.targetId ?? null, enemy?.targetId ?? null];
}
// The one fact function, for near and far bots alike: what about the bot's
// world changed is the fact that differs from the copy kept with the
// decision (factEvents). The raw values are read from a state (stateView):
// the saved one of a far bot, the posted row of a near one. view: the kit
// fields (kitView), recipes (the sorted
// known recipe ids, null: none read), party (null: none; its partyId and
// role are the fact, its leaderId is not), clanId,
// relationTargets ([friend, enemy] ids; null: read here from memory), activity,
// spotId, stats.travel (occupationPlanned's shape) and stats.relations (the
// fallback rows without memory), dead, riskDeaths, supply ([id, present] per
// stock item), stores (four identities), bagFull, weight (level 0-4).
// memory: the bot's interaction memory rows, null when the caller read none.
function factsOf(view, memory = null) {
    return { build: kitFact(view), recipes: view.recipes ? hash(view.recipes) : null,
        relations: hash([view.party?.partyId, view.party?.role, view.clanId, ...(view.relationTargets || relationTargetIds(view, memory))]),
        occupation: hash([view.spotId, view.activity === 'resting' ? 'hunting' : view.activity]),
        dead: view.dead, riskDeaths: view.riskDeaths, supply: hash(view.supply), stores: hash(view.stores),
        bag: hash([view.bagFull, view.weight]) };
}
// The stock items whose presence is the supply fact: the trip's Scroll of
// Escape (736), the planned shot, the planned healing potion.
function stockIds(shotPlan, potion) {
    return [736, shotPlan.selfId, potion.selfId];
}
// The bot's party id as a string (`bgp_<ts36>_<leaderId>`, `bgp_hot_<uuid>`),
// '' when it has none (the relations fact's party, the held build's kept
// projection: EconomyContext).
function partyIdOf(state) {
    return String(state.party?.partyId || state.partyId || '');
}
// The far reader: the raw values of a saved state. recipes: the known recipe
// ids the build reads (WishProviders.recipeIds), null when the caller holds
// no recipe book. One bag scan gives the bag full and the load.
function stateView(state, recipes = null) {
    const stats = state.stats || {};
    const view = kitView(state);
    const partyId = partyIdOf(state);
    const bag = Floor.stateInventory(state, DataCache.items);
    view.recipes = recipes;
    view.party = partyId ? state.party : null;
    view.clanId = Number(state.clanId ?? stats.clanId ?? 0);
    view.relationTargets = null;
    view.activity = state.activity;
    view.spotId = state.spotId;
    view.stats = { travel: stats.travel, relations: stats.relations };
    view.dead = Number(state.activity === 'dead' || Number(state.vitals?.hp) <= 0);
    view.riskDeaths = positive(stats.spotRisk?.windowDeaths);
    const shots = ShotStock.planForState(state);
    const potion = HealingPotionStock.purchasePotionFor(state);
    view.supply = stockIds(shots, potion).map(id => [id, positive(state.inventory?.[id]?.amount) > 0]);
    view.stores = storesOf(state);
    // The bag full: its slot limit (the full-bag sale itself is SurvivalFloor's).
    view.bagFull = Number(bag.slots >= InventoryLimits.forState(state));
    // The kit profile store reads the kit by the hashes this view already holds.
    view.weight = Floor.weightPenalty(bag.load,
        CombatProfile.profileFor(state, Date.now(), { kitHashes: view.kitHashes }).maxLoad);
    return view;
}
// The tables main keeps about the bot: the clan's material demand, the
// personal warehouse, the clan supply and whether the clan has a warehouse.
// owner: { characterId, clanId, stats } (a state is one); into: the array
// written (the near reader's, updated in place).
function storesOf(owner, into = new Array(4)) {
    into[0] = owner.stats?.clanMaterialDemand ?? null; into[1] = Warehouse.contentIdentity(owner);
    into[2] = ClanSupply.contentIdentity(owner); into[3] = ClanSupply.hasWarehouse(owner);
    const crystals = owner.stats?.equipmentPlan?.clanGoal?.clanId && require('./ClanCrystalSupply').identity(owner);
    if (crystals) into[4] = crystals;
    else into.length = 4;
    return into;
}
// memory: the bot's interaction memory (the caller's deps.memory), null when
// the caller read none. recipes: as stateView's.
function semanticFacts(state, memory = null, recipes = null) {
    return factsOf(stateView(state, recipes), memory);
}
// A retained calculation accepts its own decision output, not a foreign
// leaf or focus that happens to share the same sequence. Scalars also let
// the cache compare its original unpublished input without another object.
function decisionRefusal(state, decisionSeq, activityLeaf, focus) {
    const stats = state.stats || {};
    if (Number(stats.decisionSeq || 0) !== decisionSeq) return 'decision_seq';
    if (Number(stats.activityLeaf || 0) !== activityLeaf) return 'activity_leaf';
    if ((stats.wishFocus?.[0] ?? null) !== focus) return 'wish_focus';
    return '';
}
function isEmptyWishPlan(plan) {
    return plan?.status === 'deferred' && plan.strategy === 'none'
        && plan.next == null && plan.reason === 'wish_focus'
        && Object.keys(plan).every(key => ['status', 'strategy', 'next', 'reason'].includes(key));
}
function events(before, after, escrow = 0, leaf = null) {
    // Main may replay a validated worker packet that already describes this
    // same round. Compare its actual baselines, not sequence alone; a packet
    // preceding a new death/level/resource event still raises that event.
    const represented = Number(after.stats?.decisionSeq || 0) > Number(before.stats?.decisionSeq || 0)
        ? after.stats?.wishSections : null;
    const previous = represented || before.stats?.wishSections || {};
    let original;
    // A fact the baseline kept as null (no recipe book read) is kept: only a
    // fact the baseline lacks reads the state before.
    const previousFact = key => Object.hasOwn(previous, key) ? previous[key] : (original ||= semanticFacts(before))[key];
    // No memory and no recipe book here: the relations and the recipes the
    // decision kept stand until the next verdict, which reads both.
    const current = { ...semanticFacts(after), relations: previousFact('relations'), recipes: previousFact('recipes') };
    // leaf: the step's held leaf (the worker's round check): the move it
    // ordered is no event (occupationPlanned). None (main, a step without a
    // plan): every move is an event.
    return factEvents(previousFact, current, moneyChanged(after, represented || before.stats?.wishSections, escrow, false)
        || !previous.funding && fundingMark(before) !== fundingMark(after), null, occupationPlanned(after, leaf));
}
// The one reading of an occupation against the held leaf (Recompute: own
// outputs are not inputs): the trip the leaf ordered under way (to its
// hunting spot arriving to hunt, or to its town), or the arrival where it
// led (its hunting spot, hunting or resting there; else its own activity).
// The route's detour around the leaf's full hunting spot stands in for it
// (BotRoute.trip decides which trip is one): the trip names the leaf's spot
// (travel.leafSpotId), the arrival keeps the pair leaf spot + ground reached
// (stats.standIn, BackgroundResolver.resolveTravel), the leaf's own arrival
// while the bot stands on that ground.
// Death, recall, a party pull, a flight or a yield are none of these and
// stay events. Read by the held build's verdict and by the far step's round
// check (factEvents' planned); its field-trip clause is
// EconomyContext.fieldActivity's.
function occupationPlanned(state, leaf) {
    if (!leaf?.activity) return false;
    const hunt = leaf.activity === 'hunting';
    if (state.activity === 'traveling') {
        const travel = state.stats?.travel;
        if (!travel) return false;
        return hunt && leaf.spotId != null ? (ownSpot(travel.spotId, leaf) || ownSpot(travel.leafSpotId, leaf))
            && travel.arrivalActivity === 'hunting' && travel.townName == null
            : leaf.town != null && travel.townName != null && String(travel.townName) === String(leaf.town);
    }
    // A hunting leaf without a spot names no arrival: any spot is an event.
    if (hunt) return leaf.spotId != null && (state.activity === 'hunting' || state.activity === 'resting')
        && (ownSpot(state.spotId, leaf) || standsIn(state, leaf));
    return state.activity === leaf.activity;
}
function ownSpot(spotId, leaf) {
    return spotId != null && String(spotId) === String(leaf.spotId);
}
// The bot stands on the ground its detour for the leaf's spot reached.
function standsIn(state, leaf) {
    const pair = state.stats?.standIn;
    return pair?.ground != null && String(pair.ground) === String(state.spotId) && ownSpot(pair.leaf, leaf);
}
// One semantic comparison for state publication and the diagnostic event gate.
// A reader supplies the baseline facts; money keeps its own soft verdict.
// facts (diagnostics, optional): an array that receives the name of every
// raised fact, in this order. planned: the occupation the held decision
// ordered (occupationPlanned, the verdict's), its own output, no event.
function factEvents(previousFact, current, funding = false, facts = null, planned = false) {
    const sections = new Set();
    const raise = fact => { facts?.push(fact); for (const name of FACT_SECTIONS[fact]) sections.add(name); };
    if (!previousFact('dead') && current.dead) raise('dead');
    if (previousFact('build') !== current.build) raise('build');
    if (previousFact('recipes') !== current.recipes) raise('recipes');
    if (previousFact('relations') !== current.relations) raise('relations');
    if (funding) { facts?.push('funding'); sections.add('funding'); }
    // Resting reads as hunting at its spot: a rest where the bot hunted is
    // none, a rest at another spot is an occupation event.
    if (!planned && previousFact('occupation') !== current.occupation) raise('occupation');
    if (current.riskDeaths > previousFact('riskDeaths')) raise('riskDeaths');
    // Physical exhaustion is never hidden by economic uncertainty.
    if (previousFact('supply') !== current.supply) raise('supply');
    if (previousFact('bag') !== current.bag) raise('bag');
    if (previousFact('stores') !== current.stores) raise('stores');
    return [...sections];
}
// The kit fact each economy build records in its baseline moved between two
// states of one bot: a party member's kit event. A party member's step raises
// no hard event (they run in hunting rounds only); its own post-round build
// names the kit change in its baseline instead. A step with no build (a held
// decision) keeps the baseline, so it reads as no move.
function kitMoved(before, after) {
    return (before?.stats?.wishSections?.build ?? null) !== (after?.stats?.wishSections?.build ?? null);
}
module.exports = { SECTIONS, COMPUTED, FACT_SECTIONS, sectionBit, sectionMask, sectionNames, kit, kitMoved, moneyChanged, observationChanged, incomeError,
    MARKET_WATCH, softEvents, carrySectionBaseline, baselineIdentity, sample, sampleRows, packSample, observationBaselineValid, bounds, snapshot, semanticFacts, factsOf, relationTargetIds, events, factEvents, occupationPlanned, hash, isEmptyWishPlan, decisionRefusal, partyIdOf };
