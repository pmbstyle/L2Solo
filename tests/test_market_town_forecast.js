'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const state = { characterId: 1701, adena: 100000, activity: 'hunting', currentRegion: 'Dion', loc: { locX: 20000, locY: 140000, locZ: -3000 }, stats: {} };
const board = new BoardIndex();
const template = require('../src/GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, 123);
const npc = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Number(template.template.price));
const item = { selfId: 123, price: npc + 50000, count: 1 };
const context = { characterId: state.characterId, board, moneyPrice: .001, trader: { wait: 0 },
    travelDetails: () => ({ known: true, hours: 0, fees: 0 }),
    demandFor: (id, enchant, town) => town === 'Giran' ? { origin: 'observed_item_flow', authority: { revision: 1 },
        selfId: id, enchant, town, known: true, applicableUnits: 1, willingUnits: 1, delayHours: 0,
        availability: { from: 0, until: 10000 } } : null };
assert.equal(Town.shopTown(state, [item], { context, tripCost: () => 0, timestamp: 1000 }), 'Giran', 'supported item opportunity overrides grade fallback');
board.put({ id: 1, ownerId: 999, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 1, selfId: 123, count: 1, price: 1000 }] });
assert.equal(Town.shopTown(state, [item], { context, tripCost: () => 0, timestamp: 1000 }), Town.targetTownForItems(state, [item]), 'finite cheaper rival stock exhausts the supported lot opportunity');
assert.equal(Town.shopTown(state, [item], { timestamp: 1000 }), Town.targetTownForItems(state, [item]), 'category history is not an item forecast');
const emptyBoard = new BoardIndex();
const fresh = { ...context, board: emptyBoard };
assert.equal(Town.shopTown(state, [{ ...item, count: .5 }, { ...item, count: .5 }], { context: fresh, tripCost: () => 0, timestamp: 1000 }), Town.targetTownForItems(state, [item]), 'fractional inventory is never a supported offered lot');
assert.equal(Town.shopTown(state, [item], { context: { ...fresh, demandFor: (...args) => {
    const demand = fresh.demandFor(...args); return demand && { ...demand, origin: 'public_bid' };
} }, tripCost: () => 0, timestamp: 1000 }), Town.targetTownForItems(state, [item]), 'a finite bid is not a repeating demand forecast');
assert.equal(Town.shopTown(state, [item], { context: { ...fresh, travelDetails: () => ({ known: true, hours: 0, fees: 100001 }) }, tripCost: () => 100001, timestamp: 1000 }), null, 'an unaffordable trip does not open a shop');
for (let id = 1; id <= 21; id++) emptyBoard.put({ id, ownerId: 999, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: id, selfId: 123, count: 1, price: item.price + 1 }] });
assert.equal(Town.shopTown(state, [item], { context: fresh, tripCost: () => 0, timestamp: 1000 }), Town.targetTownForItems(state, [item]), 'a truncated rival tail cannot prove a town opportunity');
const held = { ...state, stats: { shopTown: { town: 'Dion', at: 1 } } };
assert.deepEqual(Town.openingTown(held, [item], 1000), { town: 'Dion', shopTown: null }, 'an accepted shop town does not reroll');
const iterator = Town.chooseTown(state, [item], { context, tripCost: () => 0, timestamp: 1000 });
let step, yields = 0; do { step = iterator.next(); if (!step.done) yields++; } while (!step.done);
assert(yields > 0); assert.equal(step.value.town, Town.shopTown(state, [item], { context, tripCost: () => 0, timestamp: 1000 }), 'cooperative and direct consumers share the decision');
console.log('Market town: supported item forecast, finite competing stock and honest grade fallback passed');
