const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const data = invoke('GameServer/DataCache');
data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const { ShotMarketIndex, SHOT_RECIPES } = require('../src/GameServer/Bot/Economy/ShotMarketIndex');
const { BoardIndex, offerFields } = require('../src/GameServer/AfkTrade/BoardIndex');
const demandSignal = require('../src/GameServer/Bot/Economy/MarketDemandIndex').demandSignal;
const recipes = SHOT_RECIPES.map(id => Recipes.resolveByRecipeId(id)).filter(Boolean);
const shotIds = [...new Set(recipes.map(recipe => Number(recipe.productId)))];
const recipeIds = [...new Set(recipes.map(recipe => Number(recipe.recipeItemId)))];
assert.equal(shotIds.length, 15, 'the complete native product catalogue is retained');
assert.equal(recipeIds.length, 15, 'all native shot recipe items are indexed');
const templates = new Map(data.items.map(item => [Number(item.selfId), item]));
const npcOffers = require('../src/GameServer/World/Generics/NpcShopBuyLists').allOffers();
const stockFor = state => ({ itemId: state.keepId, target: state.keepAmount });
const priceFor = (state, item, template) => Math.round(Number(template?.template?.price || 0)
    * (0.7 + (Number(state.characterId) % 21) / 100));
let board = new BoardIndex();
const states = new Map();
let listReads = 0;
function trackBoard(current) {
    const list = current.list.bind(current);
    current.list = (...args) => { listReads++; return list(...args); };
}
trackBoard(board);
const index = new ShotMarketIndex({ itemTemplates: templates, shotProductIds: shotIds,
    shotRecipeItemIds: recipeIds, board: () => board, npcOffers: () => npcOffers,
    stockFor, demandSignal, priceFor, stateFor: id => states.get(id) });
const now = 1791332800000;
let seed = 43929;
function random(max) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
function record(id, selfId, side, price, count, ownerId = id, enchant = 0) {
    board.put({ id, ownerId, storeType: side, botOwned: true, town: 'Giran',
        lines: [{ lineId: id, selfId, price, count, enchant }] });
}
for (let id = 1; id <= 1700; id++) {
    const product = shotIds[id % shotIds.length], inventory = {};
    const crafter = id <= 200;
    if (crafter || id % 9 === 0) inventory[product] = { selfId: product, amount: 100 + random(2000) };
    if (id % 13 === 0) {
        const book = recipeIds[id % recipeIds.length];
        inventory[book] = { selfId: book, amount: 1 + random(3) };
    }
    const state = { characterId: id, phase: 'cold', activity: id % 37 === 0 ? 'merchant' : 'hunting',
        level: 8 + id % 70, adena: 1000 + random(100000), inventory, keepId: product, keepAmount: 300,
        stats: { ...(crafter ? { shotCraft: { productId: product } } : {}),
            ...(id % 19 === 0 ? { shotDemand: { itemId: product, amount: 100, maxSpend: 1000, at: now } } : {}) } };
    index.update(state, now); states.set(id, state);
}
record(2001, shotIds[0], 1, 50, 300);
record(2002, shotIds[0], 3, 40, 500);
record(2003, recipeIds[0], 1, 1000, 7);
const gearId = [...templates].find(([, item]) => item.etc?.rank === 'd' && Number(item.etc?.cristals) > 0
    && /^Weapon\./.test(item.template?.kind || ''))[0];
record(2004, gearId, 1, 5000, 3);
record(2005, gearId, 1, 100, 4, 2005, 1); // enchanted equipment is not crystal scrap

function fullRecompute(timestamp) {
    const unlistedSupply = new Map(), shotDemand = new Map(), recipeStock = new Map(), recipeHolders = new Map();
    const shotSupply = new Map(), shotMinPrice = new Map();
    for (const id of shotIds) {
        const offers = board.list(id, 1).map(line => offerFields(line));
        shotSupply.set(id, offers.reduce((sum, offer) => sum + Number(offer.count), 0));
        shotMinPrice.set(id, offers.reduce((price, offer) => Math.min(price, Number(offer.price)), Infinity));
        const sources = [...states.values()].filter(state => state.phase === 'cold'
            && (Number(state.inventory?.[id]?.amount) > 0 || Number(state.stats?.shotDemand?.itemId) === id));
        const signals = sources.map(state => demandSignal(state, id, timestamp))
            .filter(signal => signal?.source === 'shots' && signal.budget > 0);
        const owners = new Set(signals.map(signal => signal.characterId));
        for (const offer of board.list(id, 3).map(line => offerFields(line))) if (!owners.has(Number(offer.sourceId))) {
            signals.push({ characterId: Number(offer.sourceId), amount: Number(offer.count),
                budget: Number(offer.count) * Number(offer.price), maxPrice: Number(offer.price) });
        }
        shotDemand.set(id, signals);
        unlistedSupply.set(id, sources.reduce((sum, state) => {
            if (!state.stats?.shotCraft) return sum;
            const stock = stockFor(state);
            return sum + Math.max(0, Number(state.inventory?.[id]?.amount || 0)
                - (Number(stock.itemId) === id ? Number(stock.target) : 0));
        }, 0));
    }
    for (const id of recipeIds) {
        const offers = board.list(id, 1).map(line => offerFields(line));
        const sources = [...states.values()].filter(state => state.phase === 'cold' && state.activity !== 'merchant'
            && Number(state.inventory?.[id]?.amount) > 0);
        recipeStock.set(id, offers.reduce((sum, offer) => sum + Number(offer.count), 0)
            + sources.reduce((sum, state) => sum + Number(state.inventory[id].amount), 0));
        recipeHolders.set(id, sources.filter(state => state.level >= 10).map(state => ({ characterId: state.characterId,
            price: priceFor(state, state.inventory[id], templates.get(id)) })).sort((a,b) => a.price - b.price));
    }
    return { unlistedSupply, shotDemand, recipeStock, recipeHolders, shotSupply, shotMinPrice };
}
function normalizedMap(map, sortedRows = false) {
    return [...map].map(([id, value]) => [id, sortedRows ? value.slice().sort((a,b) =>
        (a.price ?? 0) - (b.price ?? 0) || a.characterId - b.characterId || a.amount - b.amount) : value])
        .sort((a,b) => a[0] - b[0]);
}
function equal(timestamp, step) {
    const snapshot = index.marketSnapshot(timestamp), oracle = fullRecompute(timestamp);
    for (const key of ['unlistedSupply','recipeStock','shotSupply','shotMinPrice']) {
        assert.deepEqual(normalizedMap(snapshot[key]), normalizedMap(oracle[key]), `${key} at update ${step}`);
    }
    for (const key of ['shotDemand','recipeHolders']) {
        assert.deepEqual(normalizedMap(snapshot[key], true), normalizedMap(oracle[key], true), `${key} at update ${step}`);
    }
    for (const rows of snapshot.recipeHolders.values()) for (let at=1;at<rows.length;at++) {
        assert(rows[at-1].price <= rows[at].price, 'recipe buyers receive ascending native prices');
    }
}
equal(now, 0);
assert(index.marketSnapshot(now).gear.get('d').some(row => row.selfId === gearId && row.source === 'afk' && row.price === 5000));
assert(!index.marketSnapshot(now).gear.get('d').some(row => row.selfId === gearId && row.price === 100), 'enchanted gear is never counted as scrap');
assert.equal(index.offersFor(shotIds[0], 1, 2001).length, 0, 'a native offer read excludes the buyer');
for (let step = 1; step <= 1000; step++) {
    const ownerId = 1 + random(1700), previous = states.get(ownerId) || {
        characterId: ownerId, inventory: {}, stats: ownerId <= 200 ? { shotCraft: {} } : {}
    }, product = shotIds[random(shotIds.length)];
    const inventory = { ...previous.inventory, [product]: { selfId: product, amount: random(3000) } };
    if (step % 3 === 0) {
        const book = recipeIds[random(recipeIds.length)];
        inventory[book] = { selfId: book, amount: random(4) };
    }
    const next = { ...previous, phase: step % 31 === 0 ? 'hot' : 'cold',
        activity: step % 17 === 0 ? 'merchant' : 'hunting', level: 5 + random(70),
        adena: random(50000), inventory, keepId: product, keepAmount: random(500),
        stats: { ...previous.stats, shotDemand: step % 5 === 0 ? null
            : { itemId: product, amount: 1 + random(1000), maxSpend: random(20000), at: step % 23 === 0 ? now - 3600000 : now } } };
    if (step % 29 === 0) { index.remove(ownerId); states.delete(ownerId); }
    else { index.update(next, now); states.set(ownerId, next); }
    if (step % 37 === 0) record(3000 + step % 9, product, step % 2 ? 1 : 3, 1 + random(100), 1 + random(1000), ownerId);
    equal(now, step);
}
// A buy ad is shadowed by that holder's funded signal, then restored when
// the holder's own signal is retired; no buyer roster is enumerated.
const buyerId = 9000, product = shotIds[0];
record(9000, product, 3, 8, 12, buyerId);
const buyer = { characterId: buyerId, phase: 'cold', activity: 'hunting', level: 20, adena: 100,
    inventory: {}, stats: { shotDemand: { itemId: product, amount: 2, maxSpend: 16, at: now } } };
index.update(buyer,now); states.set(buyerId,buyer); equal(now,'board-shadow');
const capturedShotSignal = index.marketSnapshot(now).shotDemand.get(product).find(row => row.characterId === buyerId);
assert.equal(index.marketSnapshot(now + 3600000).shotDemand.get(product).find(row => row.characterId === buyerId).budget,
    capturedShotSignal.budget, 'a snapshot clock does not change demand membership or the captured native budget');
index.update(buyer,now + 3600000); states.set(buyerId,buyer);
assert.equal(index.marketSnapshot(now + 3600000).shotDemand.get(product).find(row => row.characterId === buyerId).maxPrice, 8,
    'an expired funded signal is dropped at the owner update and the original buy ad is restored');
index.remove(buyerId); states.delete(buyerId); equal(now,'board-restore');
index.marketSnapshot(now);
listReads = 0;
for (let at=0;at<100;at++) index.marketSnapshot(now);
assert.equal(listReads,0,'warm snapshots query item tokens without walking any offer or holder roster');
const savedStock=index.stockFor, savedPrice=index.priceFor, savedDemand=index.demandSignal;
index.stockFor=index.priceFor=index.demandSignal=()=>{throw new Error('snapshot re-evaluated a holder');};
index.marketSnapshot(now);
index.stockFor=savedStock;index.priceFor=savedPrice;index.demandSignal=savedDemand;
record(2001, shotIds[0], 1, 3, 9);
listReads=0; index.marketSnapshot(now);
assert.equal(listReads,2,'one changed shot reads only that item sell/buy lines');
record(99999,99999,1,7,7);
listReads=0; index.marketSnapshot(now);
assert.equal(listReads,0,'an unrelated board item does not invalidate the shot picture');
const samples=[];
for(let batch=0;batch<100;batch++) {
    const start=performance.now();
    for(let at=0;at<100;at++) index.marketSnapshot(now);
    samples.push((performance.now()-start)/100);
}
samples.sort((a,b)=>a-b);
const p95=samples[95], median=samples[50];
assert(p95<=0.5, `1700-state/200-crafter warm snapshot P95 ${p95.toFixed(4)}ms >0.5ms`);
for(const ownerId of states.keys()) { index.remove(ownerId); states.delete(ownerId); }
assert.deepEqual(index.size(),{spare:0,demand:0,recipeStock:0,recipeHolders:0},'release deletes every holder-owned store');
assert([...index.marketSnapshot(now).unlistedSupply.values()].every(value=>value===0));
board = new BoardIndex(); trackBoard(board);
const cleared=index.marketSnapshot(now);
assert([...cleared.shotDemand.values()].every(rows=>rows.length===0),'a board replacement drops cached ads');

// A changed price/time must subtract the keep recorded when the previous
// canonical state was indexed, not recompute that old keep at today's price.
const canonical = new Map(), emptyOffers = [], deltaBoard = new BoardIndex();
let keepTarget = 30;
const delta = new ShotMarketIndex({itemTemplates:templates,shotProductIds:shotIds,
    shotRecipeItemIds:recipeIds,board:()=>deltaBoard,npcOffers:()=>emptyOffers,stateFor:id=>canonical.get(id),
    stockFor:(_state,_kind,timestamp)=>({itemId:shotIds[0],target:timestamp>now?keepTarget:30})});
const original={characterId:1,phase:'cold',activity:'hunting',level:30,stats:{shotCraft:{}},
    inventory:{[shotIds[0]]:{amount:100}}};
delta.update(original,now);canonical.set(1,original);
assert.equal(delta.marketSnapshot(now).unlistedSupply.get(shotIds[0]),70);
keepTarget=0;
const projected={...original,inventory:{[shotIds[0]]:{amount:150}}};
for(let tries=0;tries<10;tries++) {
    assert.equal(delta.marketSnapshot(now+3600000,projected).unlistedSupply.get(shotIds[0]),150);
    assert.equal(delta.marketSnapshot(now+3600000).unlistedSupply.get(shotIds[0]),70,
        'a prospective bag never publishes its delta globally before ACK');
}
assert.equal(delta.keeps.has(projected),false,'the prospective overlay retains no state or keep entry');
delta.update(projected,now+3600000);canonical.set(1,projected);
assert.equal(delta.marketSnapshot(now+3600000).unlistedSupply.get(shotIds[0]),150,
    'the real publication subtracts the historical keep once even after its price became unaffordable');
delta.remove(1);delta.remove(1);
assert.equal(delta.marketSnapshot(now).unlistedSupply.get(shotIds[0]),0,'remove is idempotent before canonical retirement');
assert.equal(delta.size().spare,0);

const packedCanonical = new Map();
const packed = new ShotMarketIndex({ itemTemplates: templates, shotProductIds: shotIds,
    shotRecipeItemIds: recipeIds, stateFor: id => packedCanonical.get(id), stockFor, priceFor });
const nativeRecipeView = packed.marketSnapshot(now).recipeHolders.get(recipeIds[0]);
for (let at = 0; at < 200; at++) {
    const characterId = 2000000 + at, state = { characterId, phase: 'cold', activity: 'hunting', level: 30,
        keepId: shotIds[0], keepAmount: 300, stats: { shotCraft: {} },
        inventory: Object.fromEntries([...recipeIds.map(id => [id, { selfId: id, amount: 1 }]),
            [shotIds[0], { selfId: shotIds[0], amount: 1000 }]]) };
    packed.update(state, now); packedCanonical.set(characterId, state);
}
assert.equal(packed.marketSnapshot(now).recipeHolders.get(recipeIds[0]), nativeRecipeView,
    'snapshots reuse one readonly recipe view without materializing a holder array');
assert(Array.isArray(nativeRecipeView), 'the native array reader contract remains available');
assert.equal(nativeRecipeView.length, 200);
assert(nativeRecipeView.find(row => row.characterId === 2000123));
assert.equal(Object.values(nativeRecipeView).length, 200, 'ordinary array enumeration sees the same lazy rows');
assert.equal([...packed.recipeOwners.values()].reduce((sum, ids) => sum + ids.bytes.byteLength, 0), 3000,
    'all fifteen books share each vector base and store exact one-byte deltas for this dense native population');
assert.throws(() => nativeRecipeView.push({ characterId: 1, price: 1 }), TypeError,
    'a market consumer cannot modify the shared recipe view');
for (const characterId of [0x1000000 + 7, 0x100000000 + 9, Number.MAX_SAFE_INTEGER - 99]) {
    const state = { characterId, phase: 'cold', activity: 'hunting', level: 30, stats: {},
        inventory: { [recipeIds[0]]: { selfId: recipeIds[0], amount: 1 } } };
    packed.update(state, now); packedCanonical.set(characterId, state);
    assert(nativeRecipeView.find(row => row.characterId === characterId),
        'wide fallback preserves the exact owner ID without truncation');
}
for (const id of packedCanonical.keys()) { packed.remove(id); packedCanonical.delete(id); }
assert.deepEqual(packed.size(), { spare: 0, demand: 0, recipeStock: 0, recipeHolders: 0 });
console.log(`PASS 1700 states/200 crafters, 1000 random updates/removals and board changes: exact supply/demand/recipe values; warm snapshot median=${median.toFixed(4)}ms P95=${p95.toFixed(4)}ms; all holder stores empty after release`);

if (global.gc) {
    for (const dense of [false,true]) {
        const emptyBoard=new BoardIndex(), keep=()=>({itemId:shotIds[0],target:300});
        const fixtures=Array.from({length:200},(_,at)=>({characterId:at+1,phase:'cold',activity:'hunting',level:30,
            stats:{shotCraft:{}},inventory:Object.fromEntries((dense?shotIds:[shotIds[at%15]])
                .map(id=>[id,{selfId:id,amount:1000}]))}));
        const deltas=[];
        for(let run=0;run<5;run++) {
            const canonical=new Map(fixtures.map(state=>[state.characterId,state]));
            const measured=new ShotMarketIndex({itemTemplates:templates,shotProductIds:shotIds,
                shotRecipeItemIds:recipeIds,board:()=>emptyBoard,npcOffers:()=>npcOffers,stockFor:keep,stateFor:id=>canonical.get(id)});
            measured.marketSnapshot(now);global.gc();const before=process.memoryUsage().heapUsed;
            for(const state of fixtures) { measured.update(state,now); canonical.set(state.characterId,state); }
            global.gc();deltas.push(process.memoryUsage().heapUsed-before);
            for(const state of fixtures) { measured.remove(state.characterId); canonical.delete(state.characterId); }
        }
        deltas.sort((a,b)=>a-b);
        console.log(JSON.stringify({indexHeapCase:dense?'15-products-per-crafter':'1-product-per-crafter',
            crafters:200,bytes:deltas[2],bytesPerCrafter:deltas[2]/200,bytesPerProductEntry:deltas[2]/(200*(dense?15:1))}));
    }
}
