'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const oldKnowledge = Config.knowledgeErrorsEnabled;
Config.knowledgeErrorsEnabled = false;
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const state = { characterId: 990121, level: 50, adena: 3000, stats: { classId: 2, money: [3719, 0.0001, 1000, 900000] } };
const persona = { traits: {}, understanding: 0.5 };
const saved = { value: Table.value, best: Table.best, income: Hunt.huntIncome, samples: Hunt.sampledRows };
try {
    const rows = { near: { exp: 234195, adena: 30000, loot: 8294, kills: 10, deaths: 0 },
        middle: { exp: 112756, adena: 13000, loot: 2941, kills: 10, deaths: 0 },
        grey: { exp: 40270, adena: 3000, loot: 719, kills: 10, deaths: 0 } };
    Table.value = id => rows[id] || null;
    Hunt.huntIncome = () => ({ perHour: 3719, expPerHour: 40270 });
    Hunt.sampledRows = () => [];
    const money = Economics.create(state, { persona, deathHours: 0, moneyWeight: 1 });
    const experience = Economics.create(state, { persona, deathHours: 0, moneyWeight: 0 });
    for (const id of Object.keys(rows)) {
        close(money({ id }).valueHours, (rows[id].adena + rows[id].loot) / 3719);
        close(experience({ id }).valueHours, rows[id].exp / 40270);
    }
    assert(money({ id: 'near' }).valueHours > 10.2 && money({ id: 'middle' }).valueHours > 4.2);
    assert.equal(Economics.moneyWeight({ ...state, stats: { money: [3719, 1, 0, 900000], wishFocus: [1, 0, 5000] }, adena: 10000 }), 1);
    for (const stats of [{ money: [3719, 1, 0, 0] }, {}, { wishFocus: [1, 0, 0] },
        { wishFocus: [1, 0, null] }, { wishFocus: [1, 0, Infinity] }, { wishFocus: [1, 0, 3000] }]) {
        assert.equal(Economics.moneyWeight({ ...state, stats }), 0);
    }
    assert.equal(Economics.moneyWeight({ ...state, stats: { wishFocus: [1, 0, 900000] } }), 1);
    Table.best = () => ({ adena: 6000, loot: 4000 });
    Hunt.huntIncome = () => ({ perHour: 0, expPerHour: 40270 });
    const unsampled = Economics.create({ ...state, stats: { classId: 2, wishFocus: [1, 0, 900000] } },
        { persona, deathHours: 0 });
    close(unsampled({ id: 'near' }).valueHours, 38294 / 10000);
    Table.best = () => null;
    close(Economics.create({ ...state, stats: { classId: 2 } }, { persona, deathHours: 0, moneyWeight: 1 })({ id: 'grey' }).valueHours, 3719);
} finally {
    Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.income; Hunt.sampledRows = saved.samples;
    Config.knowledgeErrorsEnabled = oldKnowledge;
}
console.log('PASS saved money gap, unfunded-focus fallback and shared spot-value units');

// Build the server's real catalogue with the generator's deterministic spawn.
// This fixture uses no Database.init(): every world actor is process-local.
const World = invoke('GameServer/World/World');
const Service = invoke('GameServer/Bot/AI/SpotService');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const savedRandom = Math.random;
const savedWorld = { npc: World.npc, user: World.user };
const savedGate = Routes.isSpotAllowedForState;
const savedReader = Routes.spotAllowedReaderFor;
let catalogueSeed = 20261005;
try {
    Config.knowledgeErrorsEnabled = false;
    Math.random = () => {
        catalogueSeed = (catalogueSeed + 0x6D2B79F5) | 0;
        let t = Math.imul(catalogueSeed ^ (catalogueSeed >>> 15), 1 | catalogueSeed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const world = { user: { sessions: [] },
        npc: { spawns: [], grid: {}, nextId: 1000000, periodMode: 'day', periodRevision: 0,
            periodDefinitions: [], raidBossRespawnTimers: new Map(), raidBossState: new Map(), gridKeys: new WeakMap() },
        items: { spawns: [], nextId: 5000000 }, addNpcToGrid() {}, indexSpawnsInGrid() {} };
    invoke('GameServer/World/Generics/SpawnNpcs').call(world);
    World.npc = world.npc; World.user = world.user;
    Service.reset(); Spots.reset();
    const catalogue = Spots.ensure();
    Math.random = savedRandom;
    const fighter = { characterId: 990122, classId: 0, level: 50, adena: 3000, phase: 'cold', activity: 'hunting',
        stats: { classId: 0, money: [3719, 0.0001, 1000, 900000] },
        inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } },
        vitals: {}, loc: {}, timing: {} };
    const kit = Cold.profileFor(fighter);
    fighter.vitals = { hp: kit.maxHp, maxHp: kit.maxHp, mp: kit.maxMp, maxMp: kit.maxMp };
    const options = { profiles: catalogue, occupancy: {}, timestamp: 1800000000000,
        matchupProfiles: Match.stateProfiles(fighter) };
    const near = catalogue.filter(s => !s.raidBoss && s.minLevel <= 54 && s.maxLevel >= 46
        && savedGate(s, fighter, options));
    assert.equal(near.length, 0, 'naked NG kit must actually enter the weak-kit fallback');
    const oracle = catalogue.filter(s => !s.raidBoss && s.maxLevel < 46 && savedGate(s, fighter, options));
    const income = s => {
        const row = Table.value(s.id, 'dps', 50, true);
        return row ? Hunt.netIncome(row, Hunt.consumablePrices(fighter)) : 0;
    };
    // The table ends at the deep-blue gap (drops at 30%, user 10-29): every camp a naked
    // L50 survives lies past it, so none pays and the fallback takes the closest safe ground.
    assert.equal(Math.max(...oracle.map(income)), 0, 'no camp past the deep-blue gap carries table income');
    const distance = s => Math.abs(s.avgLevel - fighter.level);
    const closest = Math.min(...oracle.map(distance));
    const grey = oracle.filter(s => s.maxLevel <= 35).sort((a, b) => a.avgLevel - b.avgLevel)[0];
    assert(grey, 'fixture needs a real grey camp');
    fighter.spotId = grey.id;
    let fallbackChecks = 0;
    Routes.isSpotAllowedForState = (spot, candidate, opts) => {
        if (spot.maxLevel < 46) fallbackChecks++;
        return savedGate(spot, candidate, opts);
    };
    Routes.spotAllowedReaderFor = (candidate, opts) => {
        const read = savedReader(candidate, opts);
        return (spot) => {
            if (spot.maxLevel < 46) fallbackChecks++;
            return read(spot);
        };
    };
    const picked = Spots.findForState(fighter, options);
    assert(fallbackChecks > 0 && fallbackChecks <= 128, `fallback checks ${fallbackChecks}`);
    assert(picked, 'the full catalogue must provide a surviving camp within the fixed fallback budget');
    assert.notEqual(picked.id, grey.id, 'a far grey camp cannot pin this fighter');
    assert.equal(distance(picked), closest, `picked ${picked.id} at ${picked.avgLevel}, closest safe gap ${closest}`);
    const upper = Match.soloSpotUpperBound(options.matchupProfiles);
    assert(oracle.every(spot => upper(spot)), 'cheap bound must retain every exact-safe camp');
    assert(Match.soloSpotUpperBound([{ survivalKnown: false }])(catalogue[0]), 'unknown kits remain neutral');
    console.log(`PASS full catalogue: ${world.npc.spawns.length} spawns, near=${near.length}, `
        + `fallback=${fallbackChecks}, picked=${picked.id} at ${picked.avgLevel}`);
} finally {
    Math.random = savedRandom;
    World.npc = savedWorld.npc; World.user = savedWorld.user;
    Routes.isSpotAllowedForState = savedGate;
    Routes.spotAllowedReaderFor = savedReader;
    Config.knowledgeErrorsEnabled = oldKnowledge;
    Service.reset(); Spots.reset();
}
