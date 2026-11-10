'use strict';
const Station = require('../../World/GiranCrystallizationStation');
const Index = require('../../Item/ItemTemplateIndex');
const BATCH_LIMIT = 16;
let Rules, templates, candidates = new Map();
function canSelf(state, rank = 'd') {
    return (state.stats?.coldCombat?.skills || state.skills || [])
        .some(skill => Number(skill.selfId) === 248 && Number(skill.level) >= (rank === 'c' ? 2 : 1));
}
function reward(template, enchant = 0, self = false) {
    const rank = template?.etc?.rank;
    if (!['d', 'c'].includes(rank)) return null;
    const kind = template.template.kind;
    const gross = (Rules ||= require('../../Items/C4EnchantRules')).crystalCount({ rank, cristals: template.etc.cristals, enchant,
        isWeapon: () => kind.startsWith('Weapon.'), isArmor: () => kind.startsWith('Armor.'),
        fetchKind: () => kind });
    const net = self ? gross : gross - Math.ceil(gross * 15 / 100);
    return net > 0 ? { gross, net, crystalId: rank === 'd' ? 1458 : 1459 } : null;
}
function catalog(rank = 'd') {
    const Data = invoke('GameServer/DataCache');
    if (templates !== Data.items) { templates = Data.items; candidates = new Map(); }
    if (candidates.has(rank)) return candidates.get(rank);
    // The immutable D catalogue bounds the scan. Rank only after reading
    // actual quotes: a template-price shortlist hides cheap live inputs.
    const rows = templates.filter(row => row.etc?.rank === rank && reward(row) && Number(row.template.price) > 0)
        .sort((a, b) => a.template.price / reward(a).net - b.template.price / reward(b).net || a.selfId - b.selfId)
        .map(row => Number(row.selfId));
    candidates.set(rank, rows); return rows;
}
function spareState(state) {
    // The selected exchange reserves its inputs for this operation. Other
    // equipment, component and future-gear owners still protect their bag.
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    return plan?.strategy === 'luxury_exchange' ? { ...state, stats: { ...state.stats,
        equipmentPlan: plan.inputPreparation ? { inputPreparation: plan.inputPreparation } : null } }
        : plan?.crystalPreparation ? { ...state, stats: { ...state.stats,
            equipmentPlan: { ...plan, crystalPreparation: null } } } : state;
}
function freeReader(state) {
    const source = spareState(state);
    const freeAmount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount;
    const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(source);
    return id => freeAmount(source, source.inventory?.[id] || {}, reserved);
}
function free(state, id) {
    return freeReader(state)(id);
}
function choices(state, purchase, trip, incomePerHour = 0, rank = 'd', quantityInputs = null) {
    const self = canSelf(state, rank);
    if (!self && !trip?.known) return [];
    const operation = self ? { known: true, hours: 0, fees: 0 } : trip;
    const Data = invoke('GameServer/DataCache');
    const rows = [], seen = new Set(catalog(rank)), bundle = [], readFree = freeReader(state);
    const capacity = Math.max(0, Math.min(BATCH_LIMIT, require('../../Inventory/InventoryLimits').forState(state)
        - invoke('GameServer/Bot/Economy/ItemDisposition').inventorySlotCount(state)));
    let bundleAmount = 0, bundleNet = 0;
    for (const row of Object.values(state.inventory || {})) { const template = Index.find(Data.items, row.selfId); if (template?.etc?.rank === rank && reward(template)) seen.add(Number(row.selfId)); }
    for (const id of seen) {
        const held = state.inventory?.[id], own = readFree(id);
        // Missing bag identities are fenced by the caller's structural event.
        // These are the exact native questions for its existing physical rows.
        if (held) {
            quantityInputs?.present(id, Number(held.amount) || 0);
            quantityInputs?.crystalFree(id, own);
        }
        // A bought copy of worn/useful gear could be reconciled into the kit.
        // Prefer a different type or an already free physical spare.
        if (Number(held?.amount) > 0 && !own) continue;
        const template = Index.find(Data.items, id), result = reward(template, 0, self);
        if (own && bundle.length < 4 && bundleAmount < BATCH_LIMIT) {
            const amount = Math.min(own, BATCH_LIMIT - bundleAmount);
            bundle.push({ selfId: id, amount }); bundleAmount += amount; bundleNet += amount * result.net;
        }
        const offer = purchase(id);
        if (!own && !offer) continue;
        const batchLimit = Math.min(BATCH_LIMIT, own + Math.min(capacity, Number(offer?.availableUnits || 0)));
        if (!batchLimit) continue;
        const total = own ? 0 : offer.price + offer.tripFees;
        rows.push({ selfId: id, ...result, score: (total + (own ? 0 : offer.tripHours) * incomePerHour) / result.net,
            sourceType: own ? 'owned' : offer.sourceType,
            batchLimit, hours: (own ? 0 : offer.tripHours) + operation.hours });
    }
    rows.sort((a, b) => a.score - b.score || a.hours - b.hours || a.selfId - b.selfId);
    const reliable = rows.some(row => ['npc', 'luxury'].includes(row.sourceType))
        ? rows.filter(row => ['npc', 'luxury', 'owned'].includes(row.sourceType)) : rows;
    const selected = [], limit = bundle.length > 1 ? 1 : 2;
    // Kit reconciliation is expensive. Check candidates in actual landed
    // price order and stop once the two retained paths are safe inputs.
    for (const row of reliable) {
        const id = row.selfId;
        if (!state.inventory?.[id]) {
            const template = Index.find(Data.items, id);
            const inventory = { ...state.inventory, [id]: { selfId: id, amount: 1, slot: template.etc.slot, equipped: false } };
            const equipped = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipInventoryUpgrades(state, inventory);
            if (equipped[id]?.equipped || equipped[id]?.equippedCount > 0) continue;
        }
        selected.push(row);
        if (selected.length === limit) break;
    }
    return bundle.length > 1
        ? [{ inputs: bundle, net: bundleNet, batchLimit: 1 }, ...selected] : selected;
}
function inputAmount(state, id) {
    const shot = require('./ShotCrystalInput').amount(state,id);
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (!(plan?.strategy === 'luxury_exchange' || plan?.crystalPreparation) || plan.status !== 'active'
        || !reward(Index.find(invoke('GameServer/DataCache').items, id))) return shot;
    return Math.max(shot,Math.min(BATCH_LIMIT, Number((plan.crystalPreparation?.materials || plan.materials)
        ?.find(row => Number(row.selfId) === Number(id))?.amount || 0)));
}
// Paid physical inputs can finish their conversion while another ingredient
// of the final B recipe has no current route. That gap cannot release them
// to sale or replace their equipment owner.
function preparation(state) {
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (!plan?.crystalPreparation || plan.status !== 'active' || !plan.target?.selfId) return null;
    const missing = Number(plan.materials?.find(row => Number(row.selfId) === 1459)?.amount || 0)
        - Number(state.inventory?.[1459]?.amount || 0);
    if (!(missing > 0)) return null;
    const Data = invoke('GameServer/DataCache'), prep = plan.crystalPreparation;
    const key = `crystal_input:${plan.target.selfId}:${plan.target.slot}`;
    for (const rank of ['c', 'd']) {
        const inputs = []; let amount = 0;
        for (const row of prep.materials || []) {
            if (Index.find(Data.items, row.selfId)?.etc?.rank !== rank) continue;
            const count = Math.min(BATCH_LIMIT - amount, Number(row.amount || 0), free(state, row.selfId));
            if (count > 0) { inputs.push({ selfId: Number(row.selfId), amount: count }); amount += count; }
        }
        if (inputs.length) {
            const self = canSelf(state, rank);
            return { key, plan, self, path: { kind: 'crystallize', activity: 'improving',
                itemId: rank === 'c' ? 1459 : 1458, batches: amount,
                improvement: { kind: 'crystallize', ...(self ? { mode: 'self' } : { npcId: Station.npcId }),
                    items: inputs, ...(inputs.length === 1 ? { sourceSelfId: inputs[0].selfId } : {}) } } };
        }
    }
    const exchange = require('./BotLuxuryExchange').resolve(prep.exchange);
    return exchange && exchange.materials.every(row => free(state, row.selfId) >= row.amount)
        ? { key, plan, self: false, path: { kind: 'luxury_exchange', activity: 'improving', itemId: exchange.itemId,
            improvement: { kind: 'luxury_exchange', ...exchange, forCrystals: true } } } : null;
}
// Scheduler admission reads only the selected bounded inputs. The worker
// still chooses the operation and the native transaction validates ownership.
// quantityInputs (optional) records the bag reads a crystal preparation's
// answer rests on, for a caller whose decision is held on them.
function ready(state, quantityInputs = null) {
    // Ordinary scheduler rows need no game catalogue or reservation services.
    const saved = state?.stats?.equipmentPlan;
    if (!saved?.crystalPreparation && saved?.strategy !== 'luxury_exchange'
        && saved?.exchange?.kind !== 'luxury_exchange') return false;
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (plan?.crystalPreparation && plan.status === 'active') {
        const prep = plan.crystalPreparation, reader = freeReader(state);
        const readFree = id => { const amount = reader(id); quantityInputs?.crystalFree(id, amount); return amount; };
        const held = Number(state.inventory?.[1459]?.amount);
        quantityInputs?.physical(1459, Math.max(0, held || 0));
        return (prep.materials || []).some(row => reward(Index.find(invoke('GameServer/DataCache').items, row.selfId))
            && readFree(row.selfId) > 0) || prep.exchange?.materials?.length > 0 && prep.exchange.materials.every(row => readFree(row.selfId) >= row.amount)
            || held >= Number(plan.materials?.find(row => Number(row.selfId) === 1459)?.amount);
    }
    if (plan?.strategy !== 'luxury_exchange' || plan.status !== 'active'
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').allowsCGradeAcquisition(state)) return false;
    const amount = id => invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {});
    const cost = plan.exchange?.materials?.find(row => Number(row.selfId) === 1458)?.amount;
    if (Number(cost) > 0 && amount(1458) >= Number(cost)) return true;
    const inputs = (plan.materials || []).filter(row => Number(row.selfId) !== 1458);
    return inputs.length > 0 && inputs.length <= BATCH_LIMIT && inputs.every(row => Number(row.amount) > 0
        && amount(row.selfId) >= Number(row.amount));
}
function completionKey(state, quantityInputs = null) {
    // Each build asks; a saved plan with neither a crystal preparation nor a
    // luxury exchange has no completion (ready's guard, same reading).
    const saved = state?.stats?.equipmentPlan;
    if (!saved?.crystalPreparation && saved?.strategy !== 'luxury_exchange'
        && saved?.exchange?.kind !== 'luxury_exchange') return null;
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (plan?.crystalPreparation && plan.status === 'active' && ready(state, quantityInputs)
        && !invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipmentTargetFulfilled(state, plan))
        return `power:${plan.target.selfId}:${Number(plan.target.slot)}`;
    if (plan?.strategy !== 'luxury_exchange' || plan.status !== 'active' || !plan.target?.slot) return null;
    const Luxury = require('./BotLuxuryExchange'), exchange = Luxury.resolve(plan.exchange);
    if (!exchange || Number(plan.target.selfId) !== exchange.itemId || !Luxury.eligible(state, exchange)) return null;
    const freeOf = id => {
        const amount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {});
        quantityInputs?.free(id, amount);
        return amount;
    };
    const crystalsReady = exchange.materials.every(row => freeOf(row.selfId) >= row.amount);
    const receivedInputs = (plan.materials || []).some(row => reward(Index.find(invoke('GameServer/DataCache').items, row.selfId))
        && freeOf(row.selfId) > 0);
    if (!crystalsReady && !receivedInputs) return null;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    if (Planner.equipmentTargetFulfilled(state, plan)) return null;
    const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression'), assessment = Progression.assess(state);
    const priority = Progression.priority(Index.find(invoke('GameServer/DataCache').items, exchange.itemId), plan.target.slot, assessment);
    // Finish the selected paid-for kit piece before reallocating its crystals
    // to alternatives. A newly missing weapon or urgent stock still wins.
    if (!priority || priority < Math.max(0, ...[...assessment.gaps.values()].map(row => row.priority))) return null;
    return `power:${exchange.itemId}:${Number(plan.target.slot)}`;
}
module.exports = { canSelf, reward, catalog, choices, free, freeReader, inputAmount, preparation, ready, completionKey, npcId: Station.npcId, BATCH_LIMIT };
