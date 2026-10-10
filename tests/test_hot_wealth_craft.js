'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
let dead = false, mp = 100, missing = false, demand = true, changed = false, protectedAmount = 0;
let craftCalls = 0, learned = 0, prepared = 0, forgotten = 0, release = null;
let nativeBook = [{ recipeId: 47 }];
const recipe = { recipeId: 47, productId: 850, mpCost: 20, type: 'dwarven' };
const actor = { fetchId: () => 1, fetchIsOnline: () => true, isDead: () => dead,
    fetchHp: () => dead ? 0 : 100, fetchMp: () => mp, fetchPrivateStoreType: () => 0,
    state: { fetchHits: () => false, fetchCasts: () => false },
    backpack: { fetchRecipeBook: () => nativeBook } };
const session = { actor, plan: 'hunting' };
const registered = { actor, session };
const liveState = () => ({ characterId: 1, phase: 'hot', stats: { classId: 57 },
    inventory: { 1902: { selfId: 1902, amount: 7, protectedAmount } } });
const context = { network: { activity: { activity: 'crafting', rootKey: 'resale:850', recipeId: 47 } } };
const modules = {
    'GameServer/Bot/Economy/EconomyContext': { stateForActor: liveState, forget: () => { forgotten++; } },
    'GameServer/World/World': { registeredActorById: () => registered },
    'GameServer/Bot/Economy/CraftShopService': { isServiceCrafter: () => true, canCraft: () => true },
    'GameServer/Items/C4RecipeItems': { resolveByRecipeId: () => changed ? { ...recipe, productId: 851 } : recipe },
    'GameServer/Bot/Economy/BotWarehouseService': { learnActorRecipes: async (a, state, s, options) => {
        assert.strictEqual(a, actor); assert.strictEqual(s, session); assert.deepEqual(options.recipeIds, [47]);
        learned++; nativeBook = [{ recipeId: 47 }];
    } },
    'GameServer/Crafting/RecipeCrafting': { craftSelf: async (s, id) => {
        assert.strictEqual(s, session); assert.equal(id, 47); craftCalls++;
        if (release) await new Promise(resolve => { release = resolve; });
        return false; // A real failure still finishes this selected attempt.
    } }
};
const owner = { exports: {} };
new Function('require', 'invoke', 'module', 'exports', fs.readFileSync(path.resolve(__dirname,
    '../src/GameServer/Bot/Economy/HotWealthCraftService.js'), 'utf8'))(name => {
    if (name === './ColdWealthCraftService') return { recheck: (state, step, book) => {
        assert.equal(step.recipeId, 47); assert.equal(step.batches, 1); assert.deepEqual(step.scroll, [-1]);
        assert.strictEqual(book, nativeBook);
        // The real recheck takes free stock once (protected units excluded) and
        // orders the shortfall; readiness reads only that basket.
        const free = Number(state.inventory?.[1902]?.amount || 0) - Number(state.inventory?.[1902]?.protectedAmount || 0);
        return demand ? { basket: { purchases: missing || free < 7 ? [{}] : [], owned: [{ selfId: 1902, count: Math.min(7, free) }] } } : null;
    } };
    if (name === './WealthCraftDecision') return { freeAmount: (state, row) => Number(row.amount) - Number(row.protectedAmount || 0) };
    if (name === '../AI/DecisionEvents') return { prepared: () => { prepared++; } };
    throw Error(name);
}, name => { assert(name in modules, name); return modules[name]; }, owner, owner.exports);
(async () => {
    for (const mode of ['missing', 'dead', 'mp', 'changed', 'withdrawn', 'protected', 'party', 'combat']) {
        missing = mode === 'missing'; dead = mode === 'dead'; mp = mode === 'mp' ? 0 : 100;
        changed = mode === 'changed'; demand = mode !== 'withdrawn'; protectedAmount = mode === 'protected' ? 1 : 0;
        session.hotBackgroundPartyId = mode === 'party' ? 2 : null;
        session.currentTargetId = mode === 'combat' ? 2 : null;
        assert.equal((await owner.exports.review(session, context)).attempted, false, mode);
        assert.equal(craftCalls, 0, `${mode} cannot enter the native craft writer`);
    }
    missing = dead = changed = false; demand = true; mp = 100; protectedAmount = 0;
    session.hotBackgroundPartyId = session.currentTargetId = null;
    const previousPrepared = prepared, previousForgotten = forgotten;
    release = true;
    const first = owner.exports.review(session, context), second = owner.exports.review(session, context);
    assert.strictEqual(first, second, 'concurrent ticks share one selected native attempt');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(craftCalls, 1); release(); release = null;
    assert.deepEqual(await first, { attempted: true, crafted: false });
    assert.equal(prepared, previousPrepared + 1, 'native craft failure retires the old prepared decision without a new trait roll');
    assert.equal(forgotten, previousForgotten + 1);
    nativeBook = [];
    await owner.exports.review(session, context);
    assert.equal(learned, 1, 'only the selected physical recipe is learned before native self craft');
    assert.equal(craftCalls, 2); assert.equal(prepared, previousPrepared + 2);
    assert.equal((await owner.exports.review(session, { network: { activity: { ...context.network.activity, rootKey: 'power:850:12' } } })).attempted, false);
    console.log('PASS hot producer native dispatch: guarded whole owned inputs, withdrawn demand, selected learning, no purchase/sale/wallet effects, concurrent tick and failure completion');
})().catch(error => { console.error(error); process.exitCode = 1; });
