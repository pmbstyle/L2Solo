'use strict';

const { SELL } = require('../../AfkTrade/BoardIndex');
const { personalOfferAllowed } = require('../Population/PartyAdmission');
const { fill } = require('./OfferQuery');
const { MAX_INSPECTED } = require('./ReadyTradeChoice');
const Production = require('./ProductionPolicy');

// A quote is an outside option only for a whole, affordable purchase over a
// known route. Reserved shop stock is public authority. A conditional ad
// needs the buyer's already prepared executable purchase; an advertised
// count alone cannot promise another owner's stock or consent.
function cap(selfId, ctx, { units = 1, town, money, enchant = 0, proof = null, proofMoney = 0 } = {}) {
    if (!Number.isSafeInteger(units) || units < 1 || !(money >= 0)
        || typeof ctx.travelDetails !== 'function' || !Number.isFinite(ctx.hour) || ctx.hour < 0) return Infinity;
    const routeFor = where => {
        const route = ctx.travelDetails(where);
        return route?.known && [route.hours, route.fees].every(n => Number.isFinite(n) && n >= 0) ? route : null;
    };
    const meeting = routeFor(town);
    if (!meeting) return Infinity;
    if (meeting.fees > money) return 0;
    const groups = new Map();
    const group = where => {
        if (!where) return null;
        if (!groups.has(where)) groups.set(where, { lines: [], npcPrice: 0 });
        return groups.get(where);
    };
    const planned = ctx.economy?.network?.activity || ctx.economy?.activity;
    for (const line of (ctx.board?.list(selfId, SELL) || []).slice(0, MAX_INSPECTED)) {
        if (line.ownerId === ctx.characterId || Number(line.enchant || 0) !== enchant
            || !Number.isSafeInteger(line.price) || line.price <= 0
            || !Number.isSafeInteger(line.count) || line.count <= 0 || line.available === false
            || line.executable === false || !personalOfferAllowed(line, ctx.state)) continue;
        if (line.custodyPolicy === 1 && !(planned?.activity === 'shopping' && planned.kind === 'buy'
            && planned.sourceType === 'afk' && planned.quoted === true && planned.executable === true
            && planned.itemId === Number(selfId) && planned.town === line.town
            && planned.unitPrice === line.price && planned.amount >= units && line.count >= units)) continue;
        group(line.town)?.lines.push(line);
    }
    const npcAllowed = !Production.GRADED_SHOTS.has(Number(selfId)) || Production.allowsNpcShot(selfId);
    if (!enchant && npcAllowed) for (const offer of (ctx.purchaseNpcOffersFor || ctx.npcOffersFor)?.(selfId) || []) {
        if (offer.sourceType !== 'npc' || offer.available === false || offer.executable === false || !(offer.price > 0)
            || !Number.isSafeInteger(offer.price) || offer.count < units || offer.availableUnits < units) continue;
        const entry = group(offer.town);
        if (entry) entry.npcPrice = entry.npcPrice ? Math.min(entry.npcPrice, offer.price) : offer.price;
    }
    let ceiling = Infinity;
    for (const [where, entry] of groups) {
        const route = routeFor(where);
        if (!route || route.fees > money) continue;
        // A backed alternative with no longer trip and a lower combined cash
        // cost dominates this meeting. If the meeting is funded later, the
        // same-item alternative is funded too, even when all cash is reserved.
        // Conditional stock cannot provide this independent proof.
        if (proof && route.hours <= meeting.hours && route.fees <= proofMoney) {
            const guaranteed = fill(entry.lines.filter(line => line.custodyPolicy !== 1), units,
                { npcPrice: entry.npcPrice, money: proofMoney - route.fees });
            if (guaranteed.units === units) {
                const limit = Math.max(0, Math.floor((guaranteed.cost + route.fees - meeting.fees) / units));
                if (limit < proof.ceiling) {
                    proof.ceiling = limit;
                    proof.required = guaranteed.cost + route.fees + Number(proof.otherCost || 0);
                    proof.offers = guaranteed.lines.map(({ line, count }) =>
                        [Number(line.recordId), Number(line.lineId), Number(line.revision), count, Number(line.price)]);
                }
            }
        }
        const purchase = fill(entry.lines, units, { npcPrice: entry.npcPrice, money: money - route.fees });
        if (purchase.units !== units) continue;
        // Subtract routes before monetising: identical trips cancel exactly,
        // without a spurious one-Adena discount from floating-point totals.
        const extraTrip = route.fees - meeting.fees + (route.hours - meeting.hours) * ctx.hour;
        ceiling = Math.min(ceiling, Math.max(0, Math.floor((purchase.cost + extraTrip) / units)));
    }
    return ceiling;
}

const moneyForLine = (line, ctx) => ctx.adena + (line.custodyPolicy === 1 ? 0 : line.price * line.count);
function cashCap(line, ctx) {
    const route = ctx.travelDetails?.(line.town);
    const fees = route?.known && Number.isFinite(route.fees) ? Math.max(0, route.fees) : 0;
    return Math.max(0, Math.floor((moneyForLine(line, ctx) - fees) / Math.max(1, line.count)));
}
function forLine(line, ctx) {
    return cap(line.selfId, ctx, { units: line.count, town: line.town, enchant: Number(line.enchant || 0),
        money: moneyForLine(line, ctx) });
}

// Recheck consent over the complete agreed quantity, including physical
// stacks split by the native meeting. Use fresh own cash/routes/sources;
// neither an old WTB price nor a high wish value authorizes overpayment.
function assertMeetingPurchase(lines, payer, town, ctx, money = ctx.adena) {
    const purchases = new Map();
    for (const line of lines) if (line.payer === payer) {
        const key = `${line.selfId}:${line.enchant || 0}`;
        let purchase = purchases.get(key);
        if (!purchase) purchases.set(key, purchase = { selfId: line.selfId, enchant: line.enchant || 0, units: 0, cost: 0 });
        purchase.units += line.count; purchase.cost += line.count * line.price;
    }
    if (!purchases.size) return;
    const route = ctx.travelDetails?.(town);
    if (!route?.known || ![route.hours, route.fees, ctx.hour].every(n => Number.isFinite(n) && n >= 0))
        throw Error('trade_meeting_route');
    const total = [...purchases.values()].reduce((sum, purchase) => sum + purchase.cost, 0);
    for (const purchase of purchases.values()) {
        const proof = { ceiling: Infinity, otherCost: total - purchase.cost };
        const ceiling = cap(purchase.selfId, ctx, { ...purchase, town,
            money: Math.max(0, money - (total - purchase.cost)), proof,
            proofMoney: Math.max(0, Number(ctx.proofMoney || 0) - (total - purchase.cost)) });
        if (purchase.cost > ceiling * purchase.units) {
            const error = Error('trade_meeting_purchase_price_changed');
            error.purchase = purchase;
            error.independentPriceProof = purchase.cost > proof.ceiling * purchase.units;
            if (error.independentPriceProof) {
                error.fundingDominance = true;
                error.priceWitness = proof.offers;
            }
            throw error;
        }
    }
}
module.exports = { cap, forLine, cashCap, assertMeetingPurchase };
