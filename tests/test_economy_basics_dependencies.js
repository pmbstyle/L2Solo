'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const board = new BoardIndex(), nativeIndex = Sources.recipeIndex;
const fixture = require('./fixtures/wish_spot_native_state.json');
let indexes = 0;
Sources.recipeIndex = (...args) => { indexes++; return nativeIndex(...args); };
const unnecessary = () => { throw Error('basic reader touched production'); };
const deps = { board, spots: [], timestamp: 1791335800000, npcOffersFor: () => [],
    workshop: unnecessary, knownRecipes: unnecessary, producerSource: unnecessary,
    buyOrderEscrow: unnecessary, onSourceScope: unnecessary };
try {
    const variants = [fixture, { ...fixture, inventory: {} }, { ...fixture, adena: 0 },
        { ...fixture, stats: { ...fixture.stats, karma: 100 } }];
    for (const original of variants) {
        const state = structuredClone(original), before = structuredClone(state);
        const basic = Economy.basics(state, deps);
        const full = Economy.forState(state, { ...deps, producerSource: null, onSourceScope: undefined,
            workshop: { known: true, incomePerHour: 0 }, knownRecipes: [], buyOrderEscrow: 0,
            routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
                () => ({ known: true, durationMs: 0, fee: 0 })) });
        for (const kind of ['shots', 'potions', 'scrolls']) assert.deepEqual(basic.stock(kind), full.stock(kind));
        for (const field of ['survivalReserve', 'deathHours', 'lostGearHours', 'karmaHours', 'riskWeight', 'bestSpotId'])
            assert.deepEqual(basic[field], full[field], 'native foundation agrees with the full wish review: ' + field);
        assert.deepEqual(state, before, 'both readers leave physical inputs untouched');
        Economy.reset(); Profile.forgetBuild(state.characterId);
    }
    assert.equal(indexes, variants.length, 'only full reviews resolve the actual production index');
    indexes = 0;
    // A board with only permitted price reads is enough for stock. It has no
    // recipe/list API because this path does not build public production goals.
    const partial = { ...deps, board: { first: () => null } };
    Economy.basics(fixture, partial).stock('shots');
    Economy.stockFor(fixture, 'potions', partial);
    assert.equal(indexes, 0);
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS native basics: identical stocks/reserves/risk, zero production/book/workshop/escrow readers, complete review retains production');
} finally { Sources.recipeIndex = nativeIndex; Economy.reset(); Profile.forgetBuild(fixture.characterId); }
process.exit(0);
