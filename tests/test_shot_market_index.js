const assert = require('assert');
const { ShotMarketIndex } = require('../src/GameServer/Bot/Economy/ShotMarketIndex');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const now = 1800000000000;
const board = new BoardIndex();
const shot = 1463, recipe = 1799, crystal = 1458, gear = 700;
const templates = new Map([
    [shot, { selfId: shot, template: { price: 20, kind: 'Other.Shot' } }],
    [recipe, { selfId: recipe, template: { price: 100, kind: 'Other.Recipe' } }],
    [crystal, { selfId: crystal, template: { price: 650, kind: 'Other.Material' } }],
    [gear, { selfId: gear, template: { price: 10000, kind: 'Weapon.Sword' }, etc: { rank: 'd', cristals: 10 } }]
]);
const forbidden = () => { throw new Error('seller must not read foreign inventory/wishes/wallet/level'); };
const npc = [{ selfId: crystal, price: 650 }, { selfId: gear, price: 10000 }];
const index = new ShotMarketIndex({ itemTemplates: templates, shotProductIds: [shot], shotRecipeItemIds: [recipe],
    board: () => board, npcOffers: () => npc, stateFor: forbidden, demandSignal: forbidden, priceFor: forbidden,
    stockFor: () => ({ itemId: shot, target: 30 }) });
const foreign = { characterId: 2, phase: 'cold', activity: 'resting', level: 40, adena: 1e9,
    inventory: { [shot]: { selfId: shot, amount: 1000 }, [recipe]: { selfId: recipe, amount: 10 } },
    stats: { shotDemand: { itemId: shot, amount: 500, maxSpend: 1e9, at: now }, shotCraft: {} } };
index.update(foreign, now);
let view = index.marketSnapshot(now);
assert.deepEqual(view.shotDemand.get(shot), []);
assert.equal(view.recipeStock.get(recipe), 0);
assert.deepEqual(view.recipeHolders.get(recipe), []);
assert.equal(view.unlistedSupply.size, 0, 'foreign unlisted inventory is absent from seller knowledge');
assert.equal(view.repeatable, false);
assert.equal(view.lifetimeKnown, false);
assert.deepEqual(index.size(), { spare: 0, demand: 0, recipeStock: 0, recipeHolders: 0 },
    'no per-owner foreign signal/stock/holder store retained');
board.put({ id: 10, ownerId: 2, storeType: BUY, revision: 7, town: 'Giran',
    lines: [{ lineId: 10, selfId: shot, count: 10, price: 25 }] });
board.put({ id: 20, ownerId: 3, storeType: SELL, revision: 1, town: 'Dion', lines: [
    { lineId: 20, selfId: recipe, count: 2, price: 100 }, { lineId: 21, selfId: shot, count: 50, price: 30 },
    { lineId: 22, selfId: gear, count: 1, price: 9000 }] });
view = index.marketSnapshot(now);
const quote = view.shotDemand.get(shot)[0];
assert.equal(quote.amount, 10);
assert.equal(quote.budget, 250, 'compatibility value is the public price*count, never hidden wallet funding');
assert.equal(quote.origin, 'public_bid');
assert.equal(quote.needId, 'bid:10:10');
assert.deepEqual(quote.authority, { recordId: 10, lineId: 10, revision: 7 });
assert.equal(quote.observedAt, now);
assert.deepEqual(quote.availability, { from: now, until: now });
assert.equal(quote.exclusive, false);
assert.equal(quote.guaranteed, false);
assert.equal(quote.repeatable, false);
assert.equal(view.shotSupply.get(shot), 50);
assert.equal(view.shotMinPrice.get(shot), 30);
assert.equal(view.recipeStock.get(recipe), 2);
assert.equal(view.recipeHolders.get(recipe)[0].lineId, 20, 'recipe acquisition sees its public physical quote');
assert.equal(view.gear.get('d').length, 2);
assert.equal(index.offersFor(recipe, SELL, 3).length, 0);
assert.equal(index.offersFor(recipe, SELL, 1)[0].expectedRevision, 1);
const stable = view.shotDemand.get(shot);
index.update({ ...foreign, adena: 0, level: 1, inventory: {}, stats: { shotDemand: null } }, now + 1);
assert.strictEqual(index.marketSnapshot(now + 1).shotDemand.get(shot), stable,
    'same permitted evidence gives exactly the same demand despite changed hidden state');
board.put({ id: 99, ownerId: 9, storeType: SELL, revision: 1,
    lines: [{ lineId: 99, selfId: 999, count: 1, price: 1 }] });
assert.strictEqual(index.marketSnapshot(now + 2).shotDemand.get(shot), stable,
    'unrelated item source does not rebuild a shot quote');
board.put({ id: 10, ownerId: 2, storeType: BUY, revision: 8, town: 'Giran',
    lines: [{ lineId: 10, selfId: shot, count: 2, price: 25 }] });
const changed = index.marketSnapshot(now + 3).shotDemand.get(shot);
assert.notStrictEqual(changed, stable);
assert.equal(changed[0].amount, 2);
assert.equal(changed[0].authority.revision, 8);
assert.equal(stable[0].amount, 10, 'a changed source does not mutate an in-flight captured quote');
const own = { characterId: 1, inventory: { [shot]: { selfId: shot, amount: 100 },
    [recipe]: { selfId: recipe, amount: 1 } }, stats: { clanMaterialDemand: { [shot]: 10 } } };
const ownView = index.marketSnapshot(now + 4, own);
assert.equal(ownView.unlistedSupply.get(shot), 60);
assert.equal(ownView.ownRecipeStock.get(recipe), 1);
assert.equal(index.marketSnapshot(now + 4).unlistedSupply.size, 0, 'own forecast never publishes private stock globally');
board.remove(10);
assert.deepEqual(index.marketSnapshot(now + 5).shotDemand.get(shot), [], 'exhausted/closed public bid vanishes on used revision');
index.remove(2); index.remove(2);
assert.deepEqual(index.size(), { spare: 0, demand: 0, recipeStock: 0, recipeHolders: 0 });
console.log('Permitted shot quote index: hidden-state independence, own stock, revisions and finite recipe sources passed');
