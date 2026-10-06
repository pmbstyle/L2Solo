'use strict';

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const { WishNetwork, remember } = require('./WishNetwork');
const { isMainThread } = require('node:worker_threads');
const engine = new WishNetwork();
let runtime = {};
const extensions = new Map();
function configure(providers = {}) { runtime = providers; reset(); }
function registerProvider(key, provider) {
    if (typeof provider !== 'function') throw new TypeError('invalid_economy_provider');
    extensions.set(key, provider); reset();
}
// actorKey -> { key, context }: bounded (WishNetwork.remember), so group
// contexts of parties that ended and bots out of work leave by themselves.
const cache = new Map();
const positive = value => Math.max(0, Number(value) || 0);

function stateForActor(actor, session = actor?.session) {
    const stored = session?.coldLifeState || {};
    const inventory = {};
    const physicalInventory = actor.backpack?.fetchItems?.() || [];
    for (const item of physicalInventory) {
        const id = Number(item.fetchSelfId?.());
        if (!id) continue;
        const amount = positive(item.fetchAmount?.());
        const equipped = !!item.fetchEquipped?.();
        const previous = inventory[id];
        inventory[id] = { selfId: id, amount: amount + positive(previous?.amount),
            equipped: equipped || previous?.equipped, equippedCount: Number(equipped) + positive(previous?.equippedCount),
            slot: equipped ? Number(item.fetchSlot?.()) : previous?.slot || 0,
            enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0, stackable: item.fetchStackable?.(),
            instances: [...(previous?.instances || []), { id: item.fetchId?.(), selfId: id, amount, equipped,
                slot: Number(item.fetchSlot?.() || 0), enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0 }] };
    }
    const hotKit = invoke('GameServer/Bot/Population/ColdCombatProfile').capture(actor);
    return { ...stored, characterId: actor.fetchId?.(), level: actor.fetchLevel?.(), inventory, physicalInventory,
        adena: actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0,
        sp: actor.fetchSp?.() ?? stored.sp,
        spotId: session?.currentSpot?.id || stored.spotId,
        stats: { ...stored.stats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
        party: session?.hotBackgroundPartyId ? { partyId: session.hotBackgroundPartyId, role: stored.party?.role } : null,
        activity: session?.plan || 'hunting' };
}
function inputKey(state, deps = {}) {
    const stats = state.stats || {};
    const items = Object.values(state.inventory || {}).map(row => [row.selfId, row.amount, row.equippedCount || row.equipped,
        row.slot, row.enchant, (row.instances || []).map(item=>[item.id,item.enchant,item.slot,item.equipped,item.amount].join('/')).join(';')].join(':')).sort().join(',');
    // A native bag change, own sample or relation revision is an input event.
    // No timing poll, no world-wide counter: the board and the market are
    // inputs only through the items the bot read (see `market` in forState).
    return [state.level, stats.classId, items, positive(state.adena),
        Math.floor(positive(stats.frustration) * 10), stats.karma, stats.clanId, state.party?.partyId,
        state.spotId, stats.huntEfficiency?.[0]?.at, deps.memory?.revision || stats.memoryRevision || 0,
        deps.productionStatus?.inputKey || '', deps.inputKey || '', deps.mode || '', stats.pk, stats.soulCrystalQuest, (stats.hennas || []).join(','),
        Math.floor(positive(stats.exp ?? state.exp) / Math.max(1, positive(state.level) ** 2 * 100)),
        deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(),
        stats.production?.crafts || 0, positive(state.sp),
        (stats.coldCombat?.skills || state.skills || []).map(row => `${row.selfId}:${row.level}`).join(',')].join('|');
}
// The market as an input of one bot: the board lines and the counter of each
// item its review read, as tokens at the time of reading. The context stays
// valid while every token holds; a deal or a line of another item, anywhere
// in the world, rebuilds nobody (design 16.5). Not inputs, by the same rule:
// the all-counter average a counter without its own move falls back to
// (MarketCounters.moveOf) and PriceBelief's hourly demand cache.
function marketToken(board, id) {
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    return `${board?.itemRevision ? board.itemRevision(id) : '-'}|${Counters.revisionOf(Counters.counterOf(id))}`;
}
function marketHolds(board, reads) {
    for (const [id, token] of reads) if (marketToken(board, id) !== token) return false;
    return true;
}
function marketKey(reads) {
    let hash = 0x811c9dc5;
    for (const [id, token] of reads) {
        const text = `${id}=${token};`;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return hash.toString(16);
}
// Board reads of the review go through here while it is built, so each
// item it looked at is remembered with its token. Later readers of
// context.board (a market look, a sale) do not widen what the review
// depends on.
function watchedBoard(board, watch) {
    if (!board) return board;
    return Object.assign(Object.create(board), {
        first: (selfId, ...rest) => { watch(selfId); return board.first(selfId, ...rest); },
        list: (selfId, ...rest) => { watch(selfId); return board.list(selfId, ...rest); }
    });
}
function forState(state = {}, deps = {}) {
    deps = { ...runtime, ...deps };
    if (typeof deps.board === 'function') deps.board = deps.board();
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    const timestamp = Number(deps.timestamp || Date.now());
    if (typeof deps.productionStatus === 'function') deps.productionStatus = deps.productionStatus(state.characterId);
    if (deps.productionStatus == null && isMainThread && state.stats?.production) deps.productionStatus = invoke('GameServer/Bot/Economy/CraftWorkshopService').producerStatus(state, (deps.memory?.relations || []).map(row => row.targetId));
    const key = inputKey(state, { ...deps, timestamp });
    const actorKey = deps.actorKey || `character:${Number(state.characterId || 0)}`;
    const sourceBoard = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const held = cache.get(actorKey);
    if (held?.key === key && marketHolds(sourceBoard, held.reads)) return remember(cache, actorKey, held).context;
    const reads = new Map();
    let building = true;
    const read = id => { id = Number(id); if (!reads.has(id)) reads.set(id, marketToken(sourceBoard, id)); };
    const watch = id => { if (building) read(id); };
    const Data = invoke('GameServer/DataCache');
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const persona = deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
    const role = state.party?.role || state.stats?.role || invoke('GameServer/Bot/AI/BotRoles').inferRole(state.stats?.classId || 0);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    const hunt = Hunt.huntIncome(state, timestamp, deps.mode);
    const board = watchedBoard(sourceBoard, watch);
    const prices = new Map();
    const knowledgeEnabled = deps.knowledgeEnabled ?? Learning.knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.stats?.marketTrades, knowledgeEnabled, board, timestamp };
    // A price is remembered in `prices`, so every price read counts, also a
    // late one through context.price: its item joins the review's inputs.
    const price = id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = Belief.prior(id, priceCtx);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    };
    const buyback = id => invoke('GameServer/Items/NpcSellRules')
        .npcBuyPrice(Number(ItemIndex.find(Data.items, id)?.template?.price || 0));
    const own = Hunt.sampledRows(state, timestamp, deps.mode);
    const calibrations = own.flatMap(row => {
        const base = Table.value(row.spotId, tableRole, state.level, true);
        return base?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / base.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const Tendency = require('../AI/TendencyRoll');
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const context = { inputKey: key, actorKey, state, timestamp, persona, board, hunt, price, buyback, calibration,
        riskWeight: Valuation.riskWeight(state, persona), bestSpotId: hunt.spotId || state.spotId,
        deathHours: Valuation.deathHours(state, { ...hunt, lostGearHours }), lostGearHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours }), expectedDeathHours: 0 };
    context.spotValue = require('./SpotEconomics').create(state, { ...deps, timestamp, persona, deathHours: context.deathHours });
    const bestTable = (context.bestSpotId && Table.value(context.bestSpotId, tableRole, state.level, true))
        || Table.best(tableRole, state.level, true);
    context.expectedDeathHours = positive(bestTable?.deaths) * context.deathHours;
    context.karmaHours = Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) });
    context.stock = kind => {
        const shots = kind === 'shots';
        const plan = shots ? invoke('GameServer/Inventory/ShotStock').planForState(state)
            : invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state);
        const use = shots && !(plan.perAction > 0) ? 0 : positive(bestTable?.[shots ? 'shots' : 'potions']);
        const current = positive(state.inventory?.[plan.selfId]?.amount);
        const targetHours = 1 + 2 * Valuation.trait(persona, 'commitment');
        const target = Math.ceil(use * targetHours);
        const missing = Math.max(0, target - current);
        const without = shots && context.bestSpotId ? Table.value(context.bestSpotId, tableRole, state.level, false) : null;
        const benefitHours = shots ? Math.max(0, 1 - positive(without?.exp) / Math.max(1, positive(bestTable?.exp))) * targetHours
            : positive(bestTable?.deaths) * context.deathHours * targetHours;
        return { itemId: Number(plan.selfId), usePerHour: use, current, hours: use > 0 ? current / use : Infinity,
            targetHours, target, missing, unitPrice: price(plan.selfId), benefitHours,
            needed: use > 0 && current < use };
    };
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    const projection = Providers.build(state, context, { ...deps, nodes: [...(deps.nodes || []), ...extra] });
    // The items read so far name this network; a later price read through
    // context.price still joins `reads` and keeps the held context honest.
    const networkKey = `${key}#${marketKey(reads)}`;
    let network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        wallet: positive(state.adena), survivalReserve: survivalReserve(state),
        playedHours: positive(state.stats?.playedHours), persona,
        previous: { focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes },
        hourAdena: hunt.perHour, riskWeight: context.riskWeight });
    // A known production opportunity uses the same marginal hour. Its
    // provider never calls Context, so the common evaluation has no cycle.
    if (isMainThread && state.stats?.workshop?.entries?.length) {
        const opportunities = invoke('GameServer/Bot/Economy/ColdWealthCraftService').opportunities(state, {
            hourAdena: network.hourAdena, worth: price, timestamp, insideContext: true });
        // The crafter's exits read the board directly: their products are inputs too.
        for (const row of opportunities) if (row.recipe?.productId) watch(row.recipe.productId);
        const statusNode = projection.nodes.find(node => node.key === 'status:producer');
        if (statusNode && opportunities.length) statusNode.paths = [{activity:'crafting',kind:'producer_status',
            recipeId:opportunities[0].recipe.recipeId,costHours:opportunities[0].margin?.hours || 0,available:true}];
        for (const row of opportunities.slice(0, 1)) projection.moneyPaths.push({ activity: 'crafting', kind: 'production',
            recipeId: row.recipe?.recipeId, object: row.recipe?.productId,
            incomePerHour: row.expectedProfit / Math.max(1 / 3600, row.margin?.hours || row.hours || row.basket?.hours || 1) });
        if (opportunities.length) network = engine.build({ actorKey, inputKey: networkKey + ':production', ...projection,
            wallet: positive(state.adena), survivalReserve: survivalReserve(state),
            playedHours: positive(state.stats?.playedHours), persona,
            previous: { focus: network.focus, dormant: network.dormant }, hourAdena: hunt.perHour, riskWeight: context.riskWeight });
    }
    context.inputKey = networkKey;
    context.horizonHours = projection.horizon;
    context.projection = projection;
    context.network = network;
    context.moneyPrice = network.moneyPrice;
    context.hourAdena = network.hourAdena;
    context.itemUsefulness = id => (network.demands.get(`item:${id}`) || projection.values.get(Number(id)) || 0)
        * (knowledgeEnabled ? 1 + (1 - Number(persona.understanding ?? 0.3))
            * (2 * Tendency.roll('usefulness', state.characterId, id) - 1) : 1);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    const gap = network.queue.findIndex(wish => !wish.funded);
    const wanted = gap < 0 ? network.queue : network.queue.slice(0, gap + 1);
    const watched = new Set();
    context.watchList = wanted.flatMap(wish => {
        const id = Number(wish.object?.itemId || 0);
        if (!id || watched.has(id) || positive(state.inventory?.[id]?.amount) >= positive(wish.object?.amount || 1)) return [];
        watched.add(id);
        return [{ itemId: id, amount: Math.max(1, Math.floor(wish.object?.amount || 1)),
            worth: context.worth(id) ?? price(id), kind: wish.object?.kind, key: wish.key }];
    }).slice(0, 3);
    context.purchaseBudget = id => {
        let left = Math.max(0, positive(state.adena) - survivalReserve(state));
        for (const wish of network.queue) {
            if (Number(wish.object?.itemId) === Number(id)) return left;
            if (!wish.funded) return 0;
            left -= wish.price;
        }
        return 0;
    };
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant };
    building = false;

    remember(cache, actorKey, { key, reads, context });
    return context;
}
function survivalReserve(state = {}) {
    // Only an already authored survival trip/potion requirement is held.
    // There is no percentage, level cushion or separate investment purse.
    return positive(state.stats?.survivalReserve) + positive(state.stats?.townVisit?.returnFee);
}
function forActor(actor, session, deps = {}) { return forState(stateForActor(actor, session), deps); }
function forGroup(group, members, deps = {}) {
    const contexts = (members || []).slice(0, 9).map(state => forState(state, deps));
    const first = contexts[0];
    if (!first) return null;
    const actorKey = `group:${group.id || group.partyId}`;
    const wallet = positive(group.adena ?? group.wallet);
    const key = [wallet, ...contexts.map(context => context.inputKey)].join('|');
    const held = cache.get(actorKey);
    // A member rebuilt on a late price read keeps its network key; the held
    // group copies its first member, so it is valid only with the same members.
    if (held?.key === key && held.members.every((member, i) => member === contexts[i]))
        return remember(cache, actorKey, held).context;
    const nodes = [], roots = [];
    // Each member keeps its actual wishes/effects. Namespaced dependencies
    // enter the group's one purse and one engine, never a second evaluator.
    for (let i = 0; i < contexts.length; i++) {
        const source = contexts[i].projection;
        const prefix = `${i}:`;
        for (const node of source.nodes) nodes.push({ ...node, key: prefix + node.key,
            paths: (node.paths || []).map(path => ({ ...path, requirements: (path.requirements || [])
                .map(row => ({ ...row, key: prefix + row.key })) })) });
        roots.push(...source.roots.map(key => prefix + key));
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    roots.sort((a, b) => positive(byKey.get(b).valueHours) / Math.max(1, positive(byKey.get(b).price))
        - positive(byKey.get(a).valueHours) / Math.max(1, positive(byKey.get(a).price)));
    roots.length = Math.min(12, roots.length);
    const collect = () => { const seen = new Set(); const visit = key => { if (seen.has(key)) return;
        seen.add(key); for (const path of byKey.get(key)?.paths || []) for (const row of path.requirements || []) visit(row.key); };
        roots.forEach(visit); return seen; };
    let kept = collect();
    while (kept.size > 40 && roots.length) { roots.pop(); kept = collect(); }
    const network = engine.build({ actorKey, inputKey: key, nodes: nodes.filter(node => kept.has(node.key)), roots,
        wallet, playedHours: positive(group.playedHours), persona: group.persona || first.persona,
        previous: { focus: group.wishFocus, dormant: group.dormantWishes },
        hourAdena: contexts.reduce((sum, context) => sum + context.hunt.perHour, 0),
        moneyPaths: first.projection.moneyPaths, riskWeight: first.riskWeight });
    const groupHunt = { ...first.hunt, perHour: contexts.reduce((sum, member) => sum + member.hunt.perHour, 0),
        expPerHour: contexts.reduce((sum, member) => sum + member.hunt.expPerHour, 0) };
    const context = { ...first, actorKey, inputKey: key, network, hunt: groupHunt, groupIncomePerHour: groupHunt.perHour,
        moneyPrice: network.moneyPrice,
        hourAdena: network.hourAdena, statsPacket: { wishFocus: network.focus, dormantWishes: network.dormant } };
    context.itemUsefulness = id => contexts.reduce((sum, member) => sum + member.itemUsefulness(id), 0);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    remember(cache, actorKey, { key, members: contexts, context }); return context;
}
function forget(id) { const key = `character:${id}`; cache.delete(key); engine.forget(key); }
function reset() { cache.clear(); engine.clear(); }
module.exports = { forState, forActor, forGroup, stateForActor, inputKey, survivalReserve, forget, reset, configure, registerProvider };
