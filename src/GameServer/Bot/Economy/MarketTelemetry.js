const counters = {
    listingsOpened: 0,
    purchases: 0,
    itemsSold: 0,
    adenaTraded: 0,
    noOffer: 0,
    offerChanged: 0,
    purchaseFailed: 0,
    soldOut: 0,
    expired: 0,
    expiredItems: 0,
    staticBuyerSales: 0,
    staticBuyerItems: 0,
    staticBuyerAdena: 0,
    buyStoresOpened: 0,
    dynamicBuyerSales: 0,
    dynamicBuyerItems: 0,
    dynamicBuyerAdena: 0
};
let previous = { ...counters };

function add(key, amount = 1) { counters[key] = Number(counters[key] || 0) + Number(amount || 0); }

module.exports = {
    listingOpened() { add('listingsOpened'); },
    buyStoreOpened() { add('buyStoresOpened'); },
    purchase(offer, quantity = 1) {
        const count = Math.max(1, Number(quantity) || 1);
        add('purchases');
        add('itemsSold', count);
        add('adenaTraded', Math.max(0, Number(offer?.price || 0)) * count);
    },
    noOffer() { add('noOffer'); },
    offerChanged() { add('offerChanged'); },
    purchaseFailed() { add('purchaseFailed'); },
    closed(reason, items = 0) {
        if (reason === 'sold_out') add('soldOut');
        if (reason === 'expired') { add('expired'); add('expiredItems', Math.max(0, Number(items) || 0)); }
    },
    staticBuyerSale(items = 0, adena = 0) {
        add('staticBuyerSales');
        add('staticBuyerItems', Math.max(0, Number(items) || 0));
        add('staticBuyerAdena', Math.max(0, Number(adena) || 0));
    },
    dynamicBuyerSale(items = 0, adena = 0) {
        add('dynamicBuyerSales');
        add('dynamicBuyerItems', Math.max(0, Number(items) || 0));
        add('dynamicBuyerAdena', Math.max(0, Number(adena) || 0));
    },
    snapshot() {
        const delta = Object.fromEntries(Object.keys(counters).map((key) => [key, counters[key] - previous[key]]));
        previous = { ...counters };
        return { total: { ...counters }, delta };
    }
};
