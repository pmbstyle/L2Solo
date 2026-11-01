'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const probe = require('./helpers/workerEconomyDecision');

const now = Date.now(), recipe = Recipes.resolveByRecipeId(79), item = recipe.materials[0];
const state = { characterId: 910001, accountName: 'bot_pop_recipe_test', name: 'RecipeSmith', phase: 'cold',
    activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 60, adena: 1000000,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, updatedAt: now, timing: {},
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, workshop: { entries: [] },
        money: [1000, .001, 0, 0], wealthCraft: { recipeId: recipe.recipeId, productId: recipe.productId,
            batches: 1, outcome: 'buying', at: now } } };
const records = [];
function record(id, selfId, side, price, count, custody = 0) {
    records.push([id, rowOf({ id, ownerId: id + 100, storeType: side, kind: custody ? 'sell_ad' : 'shop', custodyPolicy: custody,
        status: 'active', town: 'Giran', revision: 1, lines: [{ id: id * 10, selfId, count, price, enchant: 0 }] })]);
}
record(910100, recipe.productId, 3, 100000, 1);
recipe.materials.forEach((row, index) => record(910101 + index, row.selfId, 1, 1, row.amount, index === 0 ? 1 : 0));
const request = { token: 'production-input', actorA: state.characterId, actorB: 910201, seqA: 1, seqB: 1,
    town: 'Giran', point: state.loc, parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0, revision: 0,
        sequence: 1, needRevision: 0, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
    lines: [{ payer: 0, itemId: 920001, selfId: item.selfId, enchant: 0, count: item.amount, price: 1,
        adId: 910101, adRevision: 1, certificate: null }] };
const opts = rows => ({ timestamp: now, boardRows: rows, recipes: { recipeBook: Codec.pack([recipe.recipeId]) },
    meetingRequest: structuredClone(request) });

(async () => {
    const accepted = await probe(state, opts(records));
    const certificate = Intent.decode(accepted.request.lines[0].certificate);
    assert.equal(certificate.key, `production:${recipe.recipeId}`);
    assert.equal(certificate.amount, item.amount);
    assert.deepEqual(accepted.forbiddenLoaded, []);
    const changed = records.filter(([id]) => id !== 910100);
    await assert.rejects(probe(state, opts(changed)), /trade_meeting_need_changed/,
        'a vanished output buyer cannot fund an old production errand');
    const excess = opts(records); excess.meetingRequest.lines[0].count++;
    await assert.rejects(probe(state, excess), /trade_meeting_need_changed/,
        'production does not authorize more than the fresh basket requires');
    const wrongQuote = opts(records); wrongQuote.meetingRequest.lines[0].adId++;
    await assert.rejects(probe(state, wrongQuote), /trade_meeting_need_changed/,
        'production does not transfer consent to a different advertisement');
    const alreadyHeld = { ...state, inventory: { [item.selfId]: { selfId: item.selfId, amount: item.amount } } };
    await assert.rejects(probe(alreadyHeld, opts(records)), /trade_meeting_need_changed/,
        'stock acquired after the journey removes the missing input');
    const underfunded = { ...state, adena: 0 };
    await assert.rejects(probe(underfunded, opts(records)), /trade_meeting_need_changed|trade_meeting_funding/,
        'a previously affordable basket cannot spend an empty wallet');
    const unknownBook = opts(records); unknownBook.recipes = null;
    await assert.rejects(probe(state, unknownBook), /trade_meeting_preparation_pending/,
        'a partial public workshop is not mistaken for the complete recipe book');
    const incoming = opts(records); incoming.meetingRequest.incoming = [{ [item.selfId]: item.amount }, {}];
    await assert.rejects(probe(state, incoming), /trade_meeting_preparation_pending/,
        'an unresolved accepted delivery cannot be bought a second time');
    const scrollRow = [910199, rowOf({ id: 910199, ownerId: 910299, storeType: 1, kind: 'sell_ad',
        custodyPolicy: 1, status: 'active', town: 'Giran', revision: 1,
        lines: [{ id: 9101990, selfId: recipe.recipeItemId, count: 1, price: 10, enchant: 0 }] })];
    const scroll = opts([...records, scrollRow]); scroll.recipes = { recipeBook: Codec.pack([]) };
    scroll.meetingRequest.lines[0] = { ...scroll.meetingRequest.lines[0], selfId: recipe.recipeItemId,
        count: 1, price: 10, adId: 910199 };
    const scrollResult = await probe(state, scroll);
    assert.equal(Intent.decode(scrollResult.request.lines[0].certificate).key, `production:${recipe.recipeId}`,
        'a fresh profitable production basket also certifies its missing recipe scroll');
    const coal = Recipes.resolveByRecipeId(28);
    const coalState = { ...state, stats: { ...state.stats, wealthCraft: { recipeId: 28,
        productId: coal.productId, batches: 21, outcome: 'buying', at: now } } };
    const coalRows = [];
    for (const row of [
        { id: 911000, ownerId: 911100, storeType: 3, kind: 'shop', custodyPolicy: 0, selfId: coal.productId, count: 21, price: 10000 },
        { id: 911001, ownerId: 911101, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, selfId: 1864, count: 105, price: 52 }
    ]) coalRows.push([row.id, rowOf({ ...row, status: 'active', town: 'Giran', revision: 1,
        lines: [{ id: row.id * 10, selfId: row.selfId, count: row.count, price: row.price, enchant: 0 }] })]);
    const coalOptions = { ...opts(coalRows), recipes: { recipeBook: Codec.pack([28]) } };
    coalOptions.meetingRequest.lines[0] = { ...coalOptions.meetingRequest.lines[0], selfId: 1864,
        count: 105, price: 52, adId: 911001 };
    const coalResult = await probe(coalState, coalOptions);
    assert.equal(Intent.decode(coalResult.request.lines[0].certificate).key, 'production:28',
        'the actual 21-batch recipe authorizes its freshly priced 105 coal');
    console.log('PASS fresh production meeting consents only to the selected profitable basket and finite quantity');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
