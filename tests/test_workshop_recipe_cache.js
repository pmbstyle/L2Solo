'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const originals = { fetch: Database.fetchCharacterRecipes, cached: Life.cachedState, save: Life.upsertState };
let reads = 0, writes = 0, known = [20], current;
const state = { characterId: 707, name: 'Smith', phase: 'cold', activity: 'hunting', level: 60,
    classId: 57, stats: { classId: 57 }, currentRegion: 'Giran', inventory: {} };
Database.fetchCharacterRecipes = async () => { reads++; return known.map(recipeId => ({ recipeId })); };
Life.cachedState = () => current;
Life.upsertState = async next => { writes++; current = next; return next; };
(async () => {
    current = await Workshop.review(state);
    assert.equal(reads, 1); assert.equal(writes, 1);
    const first = current;
    assert.equal(await Workshop.review(current), first);
    assert.equal(reads, 1, 'a second review reads the recipe cache');
    assert.equal(writes, 1, 'an unchanged workshop writes no life row');
    known = [20, 21]; Workshop.recipesChanged(state.characterId);
    current = await Workshop.review(current);
    assert.equal(reads, 2); assert.equal(writes, 2);
    assert.equal(current.stats.workshop.entries.length, 2);
    known = []; Workshop.recipesChanged(state.characterId);
    current = await Workshop.review(current);
    assert.equal(reads, 3); assert.equal(writes, 3);
    assert.deepEqual(current.stats.workshop.entries, [], 'deleting the last recipe removes its public offer');
    await Workshop.review(current);
    assert.equal(reads, 3); assert.equal(writes, 3);
    Workshop.remove(state.characterId);
    await Workshop.review(current);
    assert.equal(reads, 4, 'removal releases the per-bot cache');
    assert.equal(Database.isReady(), false);
    console.log('PASS workshop recipe cache, unchanged write suppression, learning and deletion');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Database.fetchCharacterRecipes = originals.fetch; Life.cachedState = originals.cached;
    Life.upsertState = originals.save; Workshop.remove(state.characterId);
});
