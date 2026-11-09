'use strict';

const Rules = require('../../AfkTrade/BoardRules');
const Places = require('./ShopPlaces');
const Funding = require('./PurchaseFunding');
const { withinCap, retainedLines } = require('./BuyAdPolicy');
const { marketBuyStoreTitle } = require('./MarketStoreTitle');
const AfkTradeService = invoke('GameServer/AfkTrade/AfkTradeService');
const BotImprovementService = invoke('GameServer/Bot/Economy/BotImprovementService');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const key = line => `${Number(line.selfId)}:${Number(line.enchant || 0)}`;

// The held bids ask for the same items and counts: their prices are the
// bot's own look's (MarketPricing.look), kept while within the prepared cap;
// a prepared cheaper price is a limit, not a reprice.
function sameBuyOrder(held, lines) {
    return held.length === lines.length && held.every(line => lines.some(wanted => key(wanted) === key(line)
        && Number(line.count) === Number(wanted.count)
        && withinCap(line.price, wanted.purchaseCap)));
}

// The wish queue already ordered and priced these bids. Allocate custody;
// never choose another price, need, or town on the main thread.
async function publish(state, wanted, town, { priority = 0, expectedAuthority = null, appearance } = {}) {
    const ownerId = Number(state.characterId);
    const current = AfkTradeService.findOwnerProjection(ownerId)?.shop || null;
    const records = AfkTradeService.ownerRecords(ownerId);
    const ads = records.filter(record => record.kind === 'buy_ad');
    const escrow = current?.storeType === Rules.BUY ? Number(current.escrowAdena) : 0;
    const budgetState = { ...state, adena: Funding.budget(state, escrow) };
    const kit = wanted.reduce((sum, line) => sum + Math.max(0, Number(line.survivalCost) || 0), 0);
    let money = Funding.spendable(budgetState, 0, { upperBound: true, survivalCost: kit });
    let shopLines = [], meetings = [];
    const roots = new Set();
    const mayUseShop = priority !== Rules.SELL && (!current || current.storeType === Rules.BUY || priority === Rules.BUY);
    const inTown = state.currentRegion === town && BotImprovementService.inTown(state);
    const mayOpen = state.phase === 'cold' && Places.hasPlaza(town) && (current?.town === town || inTown);
    let loc = null;
    if (wanted.length && mayUseShop && mayOpen) {
        loc = current?.town === town && Places.isStallArea(town, current)
            ? { locX: current.locX, locY: current.locY, locZ: current.locZ }
            : Places.take(town, Places.afkOwner(ownerId));
    }
    for (const line of wanted) {
        const cost = Number(line.count) * Number(line.price);
        if (loc && shopLines.length < Rules.BOT_SHOP_LINES && cost <= money
            && (!line.intent?.key || !roots.has(line.intent.key))) {
            const previous = records.filter(record => record.storeType === Rules.BUY && record.town === town)
                .flatMap(record => record.lines).find(old => key(old) === key(line) && old.price === line.price);
            shopLines.push({ ...line, ...(previous ? { fills: previous.fills, pricing: previous.pricing } : {}) });
            if (line.intent?.key) roots.add(line.intent.key);
            money -= cost;
        } else meetings.push(line);
    }
    const held = current?.storeType === Rules.BUY ? current.lines.filter(line => Number(line.count) > 0) : null;
    const shopSame = shopLines.length ? !!held && current.town === town && sameBuyOrder(held, shopLines) : !held;
    if (shopSame && held) shopLines = shopLines.map(line => {
        const previous = held.find(old => key(old) === key(line));
        return { ...line, price: previous.price, fills: previous.fills, pricing: previous.pricing,
            ...(line.intent ? { intent: { ...line.intent, price: previous.price } } : {}) };
    });
    // Only closing a shop releases its escrow. Its retained or new budget is
    // locked before a meeting can spend, so ads must fit the remaining wallet.
    const shopBudget = shopSame && held ? escrow : shopLines.reduce((sum, line) => sum + line.count * line.price, 0);
    const freeWallet = Math.max(0, Funding.budget(state, escrow) - shopBudget);
    const ownedAds = ads.flatMap(ad => ad.lines.map(line => ({ ...line, kind: ad.kind, storeType: ad.storeType, town: ad.town })));
    meetings = retainedLines({ ...state, adena: freeWallet }, meetings, ownedAds, town).slice(0, Rules.BOT_RECORDS.buy_ad);
    const center = ColdMarketListingService.townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
    try {
        // Unchanged order: no write. A side flip never matches: a sale shop is
        // no BUY shop, and a BUY shop the split left without lines closes.
        if (shopSame && ads.every(ad => ad.town === town) && sameBuyOrder(ads.flatMap(ad => ad.lines), meetings)) {
            return { shop: shopLines.length ? current : ads.find(ad => meetings.length && key(ad.lines[0]) === key(meetings[0])) || null,
                changed: false };
        }
        const look = shopLines.length ? current?.appearance || await appearance() : null;
        const result = await AfkTradeService.replaceBotRecords(ownerId, 'buy_ad', meetings.map(line => ({
            storeType: Rules.BUY, title: marketBuyStoreTitle([line]), town, ...center, lines: [line]
        })), {
            expected: Object.fromEntries(ads.map(ad => [ad.id, ad.revision])), expectedAuthority,
            buyShop: { expected: current ? { id: current.id, revision: current.revision } : null,
                config: shopLines.length ? { storeType: Rules.BUY, title: marketBuyStoreTitle(shopLines),
                    town, ...loc, head: current?.head || 0, appearance: look, lines: shopLines } : null }
        });
        return { shop: result.shop || result.retained?.[0] || result.opened[0] || null,
            changed: !!(result.closed.length || result.changed?.length || result.opened.length) };
    } finally {
        AfkTradeService.restorePlace(ownerId);
    }
}

module.exports = { publish };
