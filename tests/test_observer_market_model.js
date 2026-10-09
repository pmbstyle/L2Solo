'use strict';

const assert = require('assert');
const MarketModel = require('../src/WorldObserver/public/marketModel');

const data = {
    items: [
        { selfId: 10, name: 'Steel', category: 'materials', grade: 'no-grade' },
        { selfId: 20, name: 'Sword', category: 'weapons', grade: 'd' }
    ],
    stores: [
        { id: 'fixed:smith', source: 'fixed', side: 'wts', town: 'Dion', ownerName: 'Smith', items: [
            { selfId: 10, count: 999999, price: 1 }
        ] },
        { id: 'afk:1', source: 'afk_bot', side: 'wts', town: 'Giran', ownerName: 'Seller', items: [
            { selfId: 10, count: 5, price: 200 }, { selfId: 20, count: 1, price: 500 }
        ] },
        { id: 'afk:2', source: 'afk_player', side: 'wts', town: 'Dion', ownerName: 'Player', items: [
            { selfId: 10, count: 3, price: 150 }
        ] },
        { id: 'afk:3', source: 'afk_bot', side: 'wtb', town: 'Giran', ownerName: 'Buyer', items: [
            { selfId: 10, count: 2, price: 180 }
        ] }
    ]
};

const offers = MarketModel.activeOffers(data);
const sales = MarketModel.filterOffers(offers, { side: 'wts', source: 'market' });
assert.strictEqual(sales.length, 3);
assert.deepStrictEqual(MarketModel.summary(sales), { shops: 2, announcements: 0, traders: 2, listings: 3, units: 9, items: 2 });
assert.deepStrictEqual(MarketModel.filterOffers(offers, { side: 'wtb', source: 'market' }).map((offer) => offer.ownerName), ['Buyer']);
assert.deepStrictEqual(MarketModel.filterOffers(offers, { side: 'wts', source: 'fixed' }).map((offer) => offer.price), [1]);
assert.deepStrictEqual(MarketModel.filterOffers(offers, { side: 'wts', source: 'players', town: 'Dion', query: 'player' }).map((offer) => offer.selfId), [10]);
assert.deepStrictEqual(MarketModel.filterOffers(offers, { side: 'wts', source: 'market', query: '#20' }).map((offer) => offer.selfId), [20]);
assert.deepStrictEqual(MarketModel.filterOffers(offers, { side: 'wts', source: 'market', category: 'weapons' }).map((offer) => offer.selfId), [20]);

const groups = MarketModel.groupOffers(sales, 'wts');
const steel = groups.find((group) => group.selfId === 10);
assert.strictEqual(steel.best.price, 150, 'fixed trader prices must not become the market best ask');
assert.strictEqual(steel.best.town, 'Dion');
assert.strictEqual(steel.units, 8);
assert.strictEqual(MarketModel.sortRows(groups, { side: 'wts', sort: 'shops' })[0].selfId, 10);

const bids = MarketModel.groupOffers([
    ...MarketModel.filterOffers(offers, { side: 'wtb', source: 'market' }),
    { ...offers.find((offer) => offer.ownerName === 'Buyer'), price: 190, ownerName: 'Higher buyer' }
], 'wtb');
assert.strictEqual(bids[0].best.price, 190);

console.log('Observer market model checks passed');

const mixed = MarketModel.activeOffers({ items: data.items, stores: [data.stores[1], {
    id: 'afk:ad', source: 'afk_bot', side: 'wtb', kind: 'buy_ad', custodyPolicy: 1, conditional: true,
    ownerName: 'Buyer', ownerId: 99, town: 'Giran', expiresAt: 1234,
    loc: { locX: 80000, locY: 140000 }, items: [{ selfId: 10, count: 20, price: 1000 }]
}] });
const ad = mixed.find(offer => offer.kind === 'buy_ad');
assert.strictEqual(ad.loc, null, 'a meeting town must not become the location of a physical stall');
assert.strictEqual(ad.conditional, true, 'conditional execution must reach the UI');
assert.strictEqual(ad.custodyPolicy, 1);
assert.strictEqual(ad.expiresAt, 1234);
assert.strictEqual(MarketModel.summary(mixed).shops, 1, 'announcements must not inflate physical shop counts');
assert.strictEqual(MarketModel.summary(mixed).announcements, 1);
assert.strictEqual(MarketModel.filterOffers(mixed, { listing: 'shops' }).length, 2);
assert.deepStrictEqual(MarketModel.filterOffers(mixed, { listing: 'ads' }), [ad]);
