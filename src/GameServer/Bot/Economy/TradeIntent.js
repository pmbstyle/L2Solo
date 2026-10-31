'use strict';

// Version 1 of the board command's typed root certificate. Its root is a
// fresh wish or production decision, never another wallet or saved plan.
const roots = [null, 'power', 'stock', 'book', 'enchant', 'sa', 'henna', 'status', 'resale', 'production'];
const stockKinds = [null, 'shots', 'potions', 'scrolls'];
const Funding = require('./PurchaseFunding');
const { MAX_DEPTH } = require('./WishNetwork');
const integer = n => Number.isSafeInteger(n) && n >= 0;
// Selected NPC and configured shot quotes already have a native purchase owner.
// Public BUY ads describe alternative player supply, not a duplicate store job.
const isNativeSource = source => source === 'npc' || source === 'configured_store';
const nativePurchase = plan => isNativeSource(plan?.sourceType) && plan.quoted === true && plan.executable === true;
// Only completed preparation can retire public supply. A different root may
// still project player supply for the same item, so keep that alternative.
function npcOwnsPurchase(economy, selfId) {
    return !economy?.intentPending
        && nativePurchase(economy?.network?.plans?.get?.(`item:${Number(selfId)}`))
        && Array.isArray(economy.watchList)
        && !economy.watchList.some(row => Number(row.itemId) === Number(selfId));
}
function rootTuple(key) {
    const parts = String(key).split(':'), kind = roots.indexOf(parts[0]);
    if (kind < 1) throw Error('trade_intent_unknown_root');
    const arity = [1, 4, 5].includes(kind) ? 3 : 2;
    if (parts.length !== arity) throw Error('trade_intent_invalid_root');
    const a = kind === 2 ? stockKinds.indexOf(parts[1]) : Number(parts[1]);
    const b = arity === 3 ? Number(parts[2]) : 0;
    if (!integer(a) || a <= 0 || !integer(b) || arity === 3 && b <= 0) throw Error('trade_intent_invalid_root');
    return [kind, a, b];
}
function rootKey(kind, a, b) {
    if (!roots[kind] || !integer(a) || a <= 0 || !integer(b)) throw Error('trade_intent_invalid_root');
    const key = kind === 2 ? `stock:${stockKinds[a]}`
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

// Every caller passes a quantity-prepared network (EconomyContext.forState
// builds it with a stock reader). A network without one has no remaining
// amounts to project: defer the command instead of subtracting stock here.
function project(state, network, projection, worth, limit = 3, board = null, routeDetails = null) {
    if (!network?.quantityPrepared) return null;
    const regular = preparedProject(network, worth, limit);
    if (!regular) return null;
    const retained = retainedProjectIntents(state, network, worth, board, routeDetails);
    if (!retained.length) return regular;
    const regularById = new Map(regular.map((row, at) => [Number(row.itemId), at]));
    const extra = [], extraById = new Map();
    for (const row of retained) {
        const id = Number(row.itemId);
        const regularAt = regularById.get(id);
        if (regularAt !== undefined) {
            // One native order carries one real root certificate. Do not
            // inflate an unrelated root; keep the larger independently
            // justified need at the existing priority position.
            if (Number(row.amount) > Number(regular[regularAt].amount)) regular[regularAt] = row;
            continue;
        }
        const extraAt = extraById.get(id);
        if (extraAt !== undefined) {
            if (Number(row.amount) > Number(extra[extraAt].amount)) extra[extraAt] = row;
        } else if (extra.length < limit) {
            extraById.set(id, extra.length); extra.push(row);
        }
    }
    // Retained projects use spare publication slots, not the survival or
    // active wishes that the network placed ahead of them.
    return [...regular, ...extra].slice(0, limit);
}

// Retained equipment projects may keep standing key-material bids.
// Its requests are reconstructed from the current recipe and physical stock
// at every review/meeting, so an old quote cannot outlive the actual need.
// The marginal money rate spends only after higher-priority funded wishes.
function retainedProjectIntents(state, network, worth, board = null, routeDetails = null) {
    const owner = state?.stats?.equipmentPlan;
    const activePersonal = owner?.strategy === 'craft' && !owner.clanGoal
        && ['active', 'component_ready', 'ready_to_craft'].includes(owner.status)
        && ['b', 'a', 's'].includes(invoke('GameServer/Item/ItemTemplateIndex')
            .find(invoke('GameServer/DataCache').items, Number(owner.target?.selfId))?.etc?.rank)
        && !invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipmentTargetFulfilled(state, owner);
    const includeOwner = !!owner?.recipeId && (owner.status === 'deferred' && owner.reason === 'wish_focus'
        || !!owner.clanGoal && ['active', 'component_ready', 'ready_to_craft'].includes(owner.status) || activePersonal);
    if (!owner?.inputPreparation && !includeOwner) return [];
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
    if (!Warehouse.ready()) return [];
    const own = includeOwner ? {} : Disposition.equipmentMaterialAmounts(state, owner), stored = Warehouse.inventory(state);
    const production = Disposition.productionInputAmounts(state);
    const clan = invoke('GameServer/Clan/ClanSupplyPolicy').reservedAmounts(state);
    const freeAmount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount;
    const rate = Number(network.moneyPrice);
    if (!(rate > 0) || !Number.isFinite(rate)) return [];
    const rows = [], seen = new Set();
    for (let saved = includeOwner ? owner : owner?.inputPreparation; saved && !seen.has(saved); saved = saved.inputPreparation) {
        seen.add(saved);
        if (!saved.recipeId || !saved.target?.selfId || !saved.target?.slot || saved.clanGoal && saved !== owner
            || saved !== owner && owner?.strategy === 'craft' && Number(saved.target.selfId) === Number(owner?.target?.selfId)
                && Number(saved.target.slot) === Number(owner?.target?.slot)) continue;
        const plan = Disposition.equipmentInputPlan(state, saved);
        if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') continue;
        const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(plan.recipeId);
        if (!recipe) continue;
        const inputs = require('../../Clan/ClanCraftingPolicy').recipeForProvider(recipe, plan.craftProviders?.[recipe.recipeId]).materials || [];
        const part = recipe.materials.find(row => Number(row.selfId) !== Number(recipe.recipeItemId));
        if (!part) continue;
        const ids = new Set([Number(part.selfId), Number(recipe.recipeItemId)]);
        const key = `power:${Number(plan.target.selfId)}:${Number(plan.target.slot)}`;
        for (const input of inputs) {
            const id = Number(input.selfId), required = Number(input.amount);
            if (!ids.has(id) || !Number.isSafeInteger(required) || required < 1) continue;
            const item = { ...(state.inventory?.[id] || {}), selfId: id };
            const bag = Math.max(0, Number(item.amount || 0));
            const held = Number(own[id] || 0) + Number(production[id] || 0) + Number(clan[id] || 0);
            const priority = Math.max(held, Number(item.equippedCount || (item.equipped ? bag : 0)),
                Number(item.protectedAmount || 0), Number(item.reservedAmount || 0), Number(item.starterMobLootAmount || 0),
                Number(state.stats?.clanMaterialDemand?.[id] || 0));
            const blocked = item.protected || item.acceptedCustomer || item.assignedClan || item.available === false;
            const bank = blocked ? 0 : Math.max(0, Number(stored[id]?.amount || 0)
                - Number(stored[id]?.reservedAmount || 0) - Math.max(0, priority - bag));
            const free = freeAmount(state, item, { [id]: held }) + bank;
            // Newly purchased pieces can arrive while the project is paused;
            // count free physical stock even if it postdates heldInputs.
            const captured = saved.clanGoal ? Math.max(free, Number(saved.materials?.find(row => Number(row.selfId) === id)?.owned || 0)) : free;
            const amount = Math.max(0, required - captured - Number(state.acceptedIncoming?.[id] || 0));
            if (!Number.isSafeInteger(amount) || !amount) continue;
            let estimate = Number(worth(id)) || Number(invoke('GameServer/Bot/Economy/MarketCounters').firstPrice(id));
            if (board?.list) {
                const allowed = require('../Population/PartyAdmission').personalOfferAllowed;
                const offers = board.list(id, 1), money = offers.length && routeDetails
                    ? Funding.spendable(state, 0, { r: Funding.significant(rate) }) : 0;
                let quote = null;
                for (let at = 0; at < Math.min(offers.length, 20); at++) {
                    const row = offers[at];
                    if (Number(row.ownerId) === Number(state.characterId) || !(Number(row.count) > 0)
                        || !(Number(row.price) > 0) || Number(row.enchant || 0) || !allowed(row, state)) continue;
                    if (routeDetails) {
                        const route = routeDetails(row.town);
                        if (row.custodyPolicy !== 1 || route?.known !== true || !Number.isFinite(route.fees) || route.fees < 0
                            || !Number.isFinite(route.hours) || route.hours < 0
                            || Number(row.price) * Math.min(amount, Number(row.count)) + route.fees > money) continue;
                    }
                    quote = row; break;
                }
                const targetValue = Number(worth(plan.target.selfId))
                    || Number(invoke('GameServer/Bot/Economy/MarketCounters').firstPrice(plan.target.selfId));
                const ceiling = id === Number(recipe.recipeItemId) ? targetValue : targetValue / required;
                if (quote && ceiling > 0) estimate = Math.max(estimate, Math.min(Number(quote.price), ceiling));
            }
            if (!(estimate > 0) || !Number.isFinite(estimate)) continue;
            rows.push({ itemId: id, amount, worth: estimate, key, recipeId: Number(recipe.recipeId), retainedProject: true,
                valueHours: amount * estimate * rate, valueRate: Funding.significant(rate) });
        }
        for (const [id, amount] of Object.entries(Disposition.equipmentMaterialAmounts(state, saved)))
            own[id] = Number(own[id] || 0) + Number(amount || 0);
    }
    return rows;
}

// A bid and its later consent price the same remaining goal. The generic
// item estimate can be lower than this goal's allocated usefulness (a kit
// piece or craft input); it is only the fallback before money is prepared.
function purchaseWorth(intent, moneyPrice) {
    return intent?.key && moneyPrice > 0
        ? Number(intent.valueHours) / Math.max(1, Number(intent.amount)) / moneyPrice
        : Number(intent?.worth);
}
// A quantitative network already owns allocation and batch rounding. Readers
// only project that result; they never subtract physical stock a second time.
function preparedProject(network, worth, limit) {
    const watched = new Set(), result = [];
    for (const wish of network.queue || []) {
        if (!wish.object?.itemId && !wish.object?.materials) continue;
        try { rootTuple(wish.key); } catch (_) { return null; }
        // Keep the chosen acquisition first. A craft alternative can add
        // future supply, but cannot replace an exchange's crystal inputs or
        // add a second quantity for the same item to this goal.
        const rows = wishRows(wish, worth, false);
        for (const [id, row] of wishRows(wish, worth, true)) if (!rows.has(id)) rows.set(id, row);
        for (const [id, row] of rows) if (!watched.has(id)) { watched.add(id); result.push(row); }
    }
    return result.slice(0, limit);
}

// Standing bids have one row per item and a publication limit. Meeting
// consent also needs the other funded roots' actual inputs, before either
// projection drops them. Alternative craft paths never grant quote consent.
function wishRows(wish, worth, alternatives) {
    const rows = new Map();
    const visit = (key, plan, value, recipeId = 0, depth = 0) => {
        if (!plan || depth > MAX_DEPTH || !(plan.missingAmount > 0)) return;
        const id = key.startsWith('item:') ? Number(key.slice(5)) : 0;
        if (id && value > 0 && !nativePurchase(plan)) {
            const previous = rows.get(id);
            const quote = plan.kind === 'buy' && plan.sourceType === 'afk' && plan.quoted === true
                && plan.executable === true && integer(plan.unitPrice) && plan.unitPrice > 0 && plan.town
                ? { price: plan.unitPrice, town: plan.town,
                    amount: Math.min(plan.missingAmount, Number(plan.availableUnits)) } : null;
            rows.set(id, { itemId: id, amount: plan.missingAmount + (previous?.amount || 0), worth: worth(id),
                kind: wish.object?.kind, key: wish.key, recipeId, valueHours: value + (previous?.valueHours || 0),
                valueRate: Funding.significant(wish.ratio),
                ...(quote && integer(quote.amount) && quote.amount > 0 ? { quote } : {}) });
        }
        const path = alternatives && plan.intentionPath || plan, command = path.execution || path;
        const all = command.requirements || [];
        const keys = path.keyInputs || command.keyInputs;
        const staged = keys?.length ? all.filter(row => keys.includes(row.key)) : [];
        const requirements = staged.length ? staged : all;
        const share = path.execution ? Math.min(1, Number(command.availableUnits) / plan.missingAmount) : 1;
        const total = requirements.reduce((sum, row) => sum + row.amount, 0);
        for (const row of requirements) visit(row.key, row.plan, value * share * row.amount / Math.max(1, total), path.recipeId || recipeId, depth + 1);
    };
    visit(wish.key, wish.plan, wish.valueHours);
    return rows;
}

// Public willingness prices all missing units. The current funded action has
// already accepted a concrete finite quote, which can exceed that estimate
// for a required kit piece. Keep that consent local to meeting preparation;
// it neither raises standing bids nor authorizes a different or larger buy.
function meetingPurchase(network, intents, { selfId, count, price, town, enchant = 0 }, state = null) {
    if (!network?.quantityPrepared) return null;
    const ordinary = intents?.find(row => row.itemId === selfId && row.amount >= count
        && purchaseWorth(row, network?.moneyPrice) >= price);
    const leaf = network.activity;
    const nativeQuote = nativePurchase(leaf) && Number(leaf.valueHours) > 0;
    const actual = (network.queue || []).filter(wish => wish.funded === true)
        .map(wish => wishRows(wish, () => 0, false).get(selfId)).filter(Boolean);
    // A funded kit may acquire its prerequisites in either order. Use the
    // fresh graph's concrete input quote, not the value apportioned among
    // all ingredients, to consent to that finite required purchase.
    const required = !ordinary && enchant === 0 && integer(count) && count > 0 && integer(price) && price > 0
        && (leaf?.itemId !== selfId || network.queue.some(wish => wish.key === leaf.rootKey && wish.funded === true))
        && actual.find(row => (leaf?.itemId !== selfId || row.key !== leaf.rootKey)
            && row.amount >= count && row.quote?.amount >= count
            && row.quote.town === town && row.quote.price >= price);
    const quoted = required ? { ...required, amount: required.quote.amount, worth: required.quote.price,
        valueHours: required.valueHours * required.quote.amount / required.amount } : null;
    if (!network?.quantityPrepared || leaf?.kind !== 'buy' || leaf.activity !== 'shopping'
        || leaf.sourceType !== 'afk' && !nativeQuote || leaf.quoted !== true || leaf.executable !== true
        || leaf.itemId !== selfId || leaf.town !== town || enchant !== 0
        || !integer(leaf.amount) || leaf.amount <= 0 || !integer(leaf.unitPrice) || leaf.unitPrice <= 0
        || !integer(count) || count <= 0 || count > leaf.amount || !(leaf.availableUnits >= count)
        || !integer(price) || price <= 0 || price > leaf.unitPrice) return ordinary || quoted || null;
    const wish = network.queue?.find(row => row.key === leaf.rootKey && row.funded === true);
    // The executable NPC leaf is deliberately absent from public WTB rows.
    // A cheaper same-town player quote may still fulfill that exact funded
    // purchase; it cannot enlarge the native quantity or price ceiling.
    const intent = wish && (actual.find(row => row.key === wish.key && row.amount >= leaf.amount)
        || nativeQuote && { itemId: selfId, amount: leaf.amount, key: wish.key, recipeId: 0,
            valueHours: Number(leaf.valueHours), valueRate: Funding.significant(wish.ratio) });
    if (!intent) return ordinary || quoted || null;
    // A fresh source review can change the hour estimate while the native
    // row still holds this same goal's funded bucket. Spend at that bucket's
    // stored priority; another goal's reserve cannot authorize this quote.
    const packet = state?.stats?.money;
    let valueRate = intent.valueRate;
    if (state?.stats?.wishFocus?.[0] === wish.key && Array.isArray(packet)) {
        for (let at = 4; at + 2 < packet.length; at += 3) {
            if (Number(packet[at + 2]) === Number(wish.object?.itemId) && packet[at] > 0 && packet[at] >= packet[1]) {
                valueRate = Number(packet[at]); break;
            }
        }
    }
    return ordinary?.key === wish.key ? { ...ordinary, valueRate }
        : { ...intent, amount: leaf.amount, worth: leaf.unitPrice, valueRate,
            valueHours: intent.valueHours * leaf.amount / intent.amount };
}
module.exports = { rootTuple, rootKey, encode, decode, project, retainedProjectIntents, purchaseWorth, meetingPurchase, npcOwnsPurchase, isNativeSource };
