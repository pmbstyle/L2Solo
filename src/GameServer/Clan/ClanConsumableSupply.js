'use strict';
const Shots = invoke('GameServer/Inventory/ShotStock');
const BeginnerShots = require('../Items/C4BeginnerShots');
const Henna = invoke('GameServer/Henna/HennaRules');
const { isStaticService } = require('../Bot/AI/BotServiceIdentity');
const refreshPartyMemberships = require('../World/PartyMembershipPublication');

const count = value => Math.max(0, Math.floor(Number(value) || 0));
const clanOf = state => Number(state?.clanId ?? state?.stats?.clanId);
const isDecision = leaf => /^(henna:\d+|stock:shots)$/.test(leaf?.rootKey || '');
const hotChecks = new WeakMap();

function shotRequest(state, { plan = Shots.planForState(state), kit, targetAmount } = {}) {
    const selfId = Number(plan?.selfId);
    if (!selfId || BeginnerShots.isRestricted(selfId)) return null;
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const beginner = Shots.beginnerAmount(state, plan);
    const stock = targetAmount !== undefined ? null : kit
        ? Economy.shotRefillStock(state, { ...kit.stock('shots'), beginnerCurrent: beginner })
        : Economy.keptKit(state).stock('shots');
    if (stock && Number(stock.itemId) !== selfId) return null;
    const target = count(targetAmount ?? stock?.refillTarget ?? stock?.target);
    if (!Number.isSafeInteger(target)) return null;
    const incoming = count(state.acceptedIncoming?.[selfId]);
    const held = count(state.inventory?.[selfId]?.amount) + beginner + incoming;
    if (held >= target || stock && !stock.refillTarget && held >= stock.survivalTarget) return null;
    return { selfId, amount: target - held, target: target - incoming,
        shotRefillTarget: targetAmount === undefined ? target - beginner : null };
}

function decisionRequest(state, leaf) {
    if (leaf?.rootKey === 'stock:shots') return shotRequest(state);
    const symbolId = Number(/^henna:(\d+)$/.exec(leaf?.rootKey || '')?.[1]);
    if (!symbolId) return null;
    const classId = state.stats?.classId ?? state.classId;
    const slots = (state.stats?.hennas || []).filter(Boolean);
    if (slots.includes(symbolId) || slots.length >= Henna.slotsForClass(classId)) return null;
    const symbol = Henna.symbolForClass(classId, symbolId);
    if (!symbol) return null;
    const amount = require('./ClanDyeStock').remaining(state, leaf.rootKey, leaf.itemId);
    return amount > 0 ? { selfId: symbol.dyeSelfId, amount, symbolId } : null;
}

async function draw(state, request, actor = null, beforeWrite = null) {
    if (!request || !(clanOf(state) > 0) || state.incomingPending || isStaticService(state)
        || state.activity === 'dead' || state.stats?.tradeMeeting) return null;
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Database = invoke('Database');
    const owner = Life.cachedState(state.characterId);
    if (!owner || owner.phase !== (actor ? 'hot' : 'cold')) return null;
    if (!actor && owner !== state) return null;
    const session = actor?.session;
    const itemId = request.selfId, clanId = clanOf(state);
    const meeting = invoke('GameServer/AfkTrade/TradeMeetingService');
    const validate = () => {
        beforeWrite?.();
        if (Life.cachedState(state.characterId) !== owner || meeting.hasPreparation(state.characterId)) return false;
        if (!actor) return true;
        return session?.actor === actor && session.coldLifeState?.phase !== 'cold'
            && Number(actor.fetchClanId?.()) === clanId && !actor.isDead?.()
            && !session.activeTrade && !session.trade && !session.activeNegotiation && !session.botTradeReservations?.size
            && !actor.fetchPrivateStoreType?.() && !actor.state?.fetchHits?.() && !actor.state?.fetchCasts?.()
            && count(state.inventory?.[itemId]?.amount) === actor.backpack.fetchItems().reduce((sum, item) =>
                sum + (item.fetchSelfId() === itemId ? count(item.fetchAmount()) : 0), 0)
            && (request.symbolId || Shots.planForActor(actor).selfId === itemId);
    };
    if (!validate() || !await Database.hasFreeClanWarehouseItem(clanId, itemId)) return null;
    const revision = Number(owner.simulation?.revision || 0);
    const result = await Life.applyClanMaterialTransfer({
        clanId, characterId: state.characterId, selfId: itemId, amount: request.amount,
        goalKey: `consumable:${revision}`, expectedSimulationRevision: revision,
        consumable: { phase: owner.phase, symbolId: request.symbolId, errand: request.errand,
            shotRefillTarget: request.shotRefillTarget, validate }
    }, true, actor && (result => {
        if (session.actor !== actor) return;
        const backpack = actor.backpack;
        const rows = new Map(result.items.map(row => [Number(row.id), row]));
        for (const item of backpack.fetchItems()) {
            if (item.fetchSelfId() !== itemId) continue;
            const row = rows.get(Number(item.fetchId()));
            if (row) item.setAmount(row.amount);
            rows.delete(Number(item.fetchId()));
        }
        for (const row of rows.values()) backpack.insertItem(row.id, itemId, row);
        session.coldLifeState = result.state;
        refreshPartyMemberships([session], invoke);
        session.dataSendToMe?.(invoke('GameServer/Network/Response').itemsList(backpack.fetchItems()));
    }));
    return result?.code === 'warehouse_withdraw_applied'
        ? { ...result, target: request.target, partial: result.amount < request.amount } : null;
}

function forDecision(state, leaf, beforeWrite) {
    return clanOf(state) > 0 ? draw(state, decisionRequest(state, leaf), null, beforeWrite) : null;
}

function forColdShots(state, options) {
    return clanOf(state) > 0 ? draw(state, shotRequest(state, options)) : null;
}

function forShotOrder(state, selfId, amount, terms, errand = null) {
    if (!(clanOf(state) > 0) || !['shots', 'raid_supply'].includes(terms.purpose)) return null;
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState(state.characterId);
    if (!current || current.simulation?.revision !== state.simulation?.revision) return null;
    const plan = Shots.planForState(current);
    if (plan.selfId !== Number(selfId)) return null;
    const held = count(current.inventory?.[selfId]?.amount);
    const orderTarget = terms.purpose === 'raid_supply'
        ? require('../Bot/Population/RaidSupplyPolicy').held(current) : null;
    if (terms.purpose === 'raid_supply'
        && (!orderTarget || orderTarget.id !== terms.raidPreparationId || orderTarget.supply?.selfId !== plan.selfId)) return null;
    const targetAmount = Math.min(held + count(amount), orderTarget?.supply.target ?? Infinity)
        + Shots.beginnerAmount(current, plan);
    const request = shotRequest(current, { plan, targetAmount });
    return request ? draw(current, { ...request, errand }) : null;
}

function forActorShots(actor, options = {}) {
    if (!(Number(actor?.fetchClanId?.()) > 0)) return null;
    const state = invoke('GameServer/Bot/Economy/EconomyContext').stateForActor(actor);
    return draw(state, shotRequest(state, { ...options, plan: options.plan || Shots.planForActor(actor) }), actor);
}

// Once the refill has started, finish up to its original target even if the
// free units brought the bag above the threshold for starting one.
function refillKit(kit, target) {
    if (target === undefined) return kit;
    return { ...kit, stock(kind) {
        const stock = kit.stock(kind);
        return kind === 'shots' ? { ...stock, target, survivalTarget: target } : stock;
    } };
}

function continueActorRefill(actor, options, withdrawal) {
    if (!withdrawal) return Shots.purchaseActorRestock(actor, options);
    if (Shots.planForActor(actor).selfId !== withdrawal.selfId) {
        return { ok: true, changed: true, delta: withdrawal.amount, cost: 0 };
    }
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const kit = refillKit(options.kit || Economy.keptKit(Economy.stateForActor(actor)), withdrawal.target);
    return Shots.purchaseActorRestock(actor, { ...options, kit }).then(result => ({ ...result, changed: true,
        delta: withdrawal.amount + Number(result.delta || 0), refillTarget: withdrawal.target }));
}

async function restockActor(actor, options = {}) {
    const session = actor?.session;
    const wasLive = session?.actor === actor && !!actor;
    const withdrawal = await forActorShots(actor, options);
    if (wasLive && session.actor !== actor) return { ok: false, reason: 'actor_changed' };
    return continueActorRefill(actor, options, withdrawal);
}

async function afterWeaponChange(actor, slots, logTag) {
    if (actor.session?.actor !== actor || !(Number(actor.fetchClanId?.()) > 0)
        || !slots.some(require('../Bot/AI/BotEquipmentCompatibility').isWeaponSlot)) {
        return Shots.restockAfterWeaponChange(actor, slots, logTag);
    }
    try {
        const session = actor.session;
        const withdrawal = await forActorShots(actor);
        if (session?.actor !== actor) return null;
        if (!withdrawal) return Shots.restockAfterWeaponChange(actor, slots, logTag);
        await continueActorRefill(actor, {}, withdrawal);
        return Shots.enableAutoShot(actor);
    } catch (error) {
        utils.infoWarn(logTag, 'failed to refresh shots for %s: %s', actor.fetchName?.(), error.message);
    }
}

function forActorDecision(actor, leaf) {
    if (!(Number(actor.fetchClanId?.()) > 0)) return null;
    const state = invoke('GameServer/Bot/Economy/EconomyContext').stateForActor(actor);
    return draw(state, decisionRequest(state, leaf), actor);
}

// The active decision can send a near bot to a seller or a drop spot.
// Try the clan's stock before the bot starts that leg of the plan.
function reviewActorDecision(session, leaf) {
    const actor = session.actor;
    if (!(Number(actor?.fetchClanId?.()) > 0) || !isDecision(leaf)
        || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.() || actor.isDead?.()) return false;
    const previous = hotChecks.get(actor);
    if (previous?.pending) return true;
    if (previous?.leaf === leaf && previous?.clanId === Number(actor.fetchClanId())) return false;
    const check = { leaf, clanId: Number(actor.fetchClanId()), pending: true };
    hotChecks.set(actor, check);
    Promise.resolve().then(() => forActorDecision(actor, leaf)).then(result => {
        if (!result || session.actor !== actor) return;
        const Events = invoke('GameServer/Bot/AI/DecisionEvents');
        Events.raiseDecision(session, result.partial
            ? (leaf.rootKey === 'stock:shots' ? 'stock_low:shots' : 'goal_failed') : 'goal_done:goal');
        Shots.enableAutoShot(actor);
    }).catch(error => {
        utils.infoWarn('ClanWarehouse', 'bot %d could not collect consumables: %s', actor.fetchId(), error.message);
    }).finally(() => {
        check.pending = false;
        if (session.actor === actor) invoke('GameServer/Bot/BotAI').wakeup(session);
    });
    return true;
}

module.exports = { forDecision, forColdShots, forShotOrder, forActorShots, forActorDecision, reviewActorDecision,
    isDecision, refillKit, restockActor, afterWeaponChange };
