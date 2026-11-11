'use strict';

const Funding = require('../Economy/PurchaseFunding');
const OfferQuery = require('../Economy/OfferQuery');
const OfferOrder = require('../Economy/OfferOrder');
const { isMainThread } = require('node:worker_threads');
let marketSource = null;

// Main reads the live book; the simulation thread supplies its existing mirror.
// Never replace absent physical supply with a valuation or an NPC list price.
function market() {
    if (marketSource) return marketSource();
    if (!isMainThread) return null;
    const offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
    return { board: invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        npcOffersFor: id => [...offers.npcOffersAll(id), ...offers.fixedStoreOffers(id)],
        findSpot: id => invoke('GameServer/Bot/AI/SpotService').findById(id) };
}

function quote(state, selfId, amount, { timestamp = Date.now(), money = Infinity, claimed = new Map(), sources = market() } = {}) {
    if (!sources) return null;
    const trip = sources.tripFrom?.(state, timestamp)
        || OfferOrder.purchaseTrip(state, sources.findSpot || (() => null), timestamp);
    return OfferQuery.cheapestTown(sources.board, selfId, { amount, money, claimed, requireRepeatable: true,
        moneyForTown: town => Math.max(0, money - Math.max(0, trip(town))),
        excludeOwner: state.characterId, npcOffers: sources.npcOffersFor?.(selfId) || [], cost: trip,
        accept: line => !line.conditional && line.custodyPolicy !== 1
            && ['shop', 'sell_ad'].includes(line.kind) });
}

// Public stock is not reserved during a trip. The same quote already carries
// its town's repeatable price and route, so no extra market/route read is needed.
function quoteBudget(purchase, amount, trip = purchase?.trip ?? purchase?.landed - purchase?.cost) {
    const reservePrice = Math.max(0, Number(purchase?.npcPrice) || 0);
    return { priceCap: Math.max(OfferQuery.topPrice(purchase), reservePrice),
        cashNeeded: Math.max(Number(purchase?.cost) || 0, amount * reservePrice) + Math.max(0, Number(trip)) };
}

function held(state, now = Date.now()) {
    const value = state?.stats?.raidSupplyPreparation;
    return value?.id && Number(value.expiresAt) > now ? value : null;
}

function cash(state) { return Funding.spendable(state, 0, { upperBound: true }); }

function supplies(members, shotPlans, timestamp = Date.now()) {
    const Shots = invoke('GameServer/Inventory/ShotStock');
    const claimed = new Map(), sources = market();
    return shotPlans.map(plan => {
        const state = members.find(s => s.characterId === plan.id);
        const shot = Shots.planForState(state);
        const target = Math.max(0, plan.required - Shots.beginnerAmount(state, shot));
        const missing = Math.max(0, plan.required - plan.stock);
        const purchase = missing ? quote(state, plan.selfId, missing, { timestamp, claimed, sources }) : null;
        for (const { line, count } of purchase?.lines || []) {
            const key = `${line.recordId}:${line.lineId}`;
            claimed.set(key, (claimed.get(key) || 0) + count);
        }
        return { id: plan.id, selfId: plan.selfId, target, missing,
            available: purchase?.units || 0, price: OfferQuery.topPrice(purchase), cost: purchase?.landed || 0,
            reserveCost: purchase ? quoteBudget(purchase, missing).cashNeeded : 0,
            cash: cash(state) };
    });
}

// This is an explicit, expiring purchase authority, not another wallet.
// Native writers re-read the current bag, reserve and wallet on every debit.
function purchaseBudget(state, terms, now = Date.now()) {
    if (!terms?.raidPreparationId) return null;
    const prep = held(state, now), supply = prep?.supply;
    if (prep?.id !== terms.raidPreparationId || Number(supply?.selfId) !== Number(terms.itemId)) return 0;
    const missing = Math.max(0, Number(supply.target) - Number(state.inventory?.[supply.selfId]?.amount || 0));
    return Math.min(Math.max(0, Funding.budget(state) - Funding.clanCredit(state) - Funding.operatingReserve(state)),
        missing * Math.max(0, Number(supply.priceCap) || 0));
}

module.exports = { held, cash, quote, quoteBudget, supplies, purchaseBudget, useMarket: source => { marketSource = source; } };
