'use strict';
// The hunting leaf names a spot the bot may hunt (docs/architecture.md §2
// route, BotRoute.leafFitReader): in a worker build a solo bot whose table
// pick is unfit for it (a party-only ground, a raid spot, outside its level
// window), excluded by its own risk marks, or missing from the catalog gets a
// fitting spot of the income ranking (the money leaf: the first by income;
// the experience leaf: the most exp), with that spot's numbers, and the
// route's leaf check takes that spot; a fitting own sample row still counts;
// with no fitting spot the table's pick stays. Main's basics (execution caps
// only) keep the table's pick. The fit cases run in a worker thread with
// plain basics deps: what pins the cold worker's wiring is the thread itself.
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (isMainThread) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-fit-'));
    const priorConfig = process.env.L2NODE_CONFIG_FILE;
    const priorShared = process.env.L2NODE_SHARED_CONFIG_FILE;
    const config = path.join(dir, 'config.ini');
    fs.writeFileSync(config, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
        + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
    // Set before the worker starts: it takes a copy of this environment.
    process.env.L2NODE_CONFIG_FILE = config;
    delete process.env.L2NODE_SHARED_CONFIG_FILE;
    process.on('exit', () => {
        if (priorConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = priorConfig;
        if (priorShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = priorShared;
        fs.rmSync(dir, { recursive: true, force: true });
    });
}
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const at = Date.now();

// A level-35 human fighter wearing its whole baseline kit: no gear to earn,
// so no income route; its hunt comes from the shared table.
const inventory = {};
Gear.planFor({ classId: 1, level: 20 }).items.forEach((item, index) => {
    inventory[index + 1] = { selfId: Number(item.selfId), amount: 1, equipped: true, equippedSlots: [Number(item.slot)] };
});
const state = { characterId: 990101, level: 35, phase: 'cold', activity: 'hunting', stats: { classId: 1 }, inventory };
const role = Roles.tableRoleFor(state);
const ranked = Table.rankedIncome(role, 35, Hunt.consumablePrices(state), -7, true, { spoilSkillLevel: 0 });
const tableBest = Table.best(role, 35, true).spotId;
const tableIncome = ranked[0].spotId;
assert.notEqual(tableBest, tableIncome, 'the fixture needs two table picks: the progress spot and the income spot');
const spot = (id, extra = {}) => ({ id, avgLevel: 35, minLevel: 34, maxLevel: 36, density: 10,
    tagsAuthoritative: true, tags: [], npcEntries: [], ...extra });
const build = (bot, spots) => Economy.basics(bot, { timestamp: at, spots });
const leafSpot = basics => basics.hunt.progressSpotId || basics.bestSpotId;
// T43 table: the top seven, so a fitting spot with more exp than the first fitting earner is listed.
const listed = [...new Set([tableBest, ...ranked.slice(0, 7).map(row => row.spotId)])];
const unfit = new Set([tableBest, tableIncome]);
// The two table picks made unfit in one way, the other listed spots plain.
const catalogWith = extra => listed.map(id => spot(id, unfit.has(id) ? extra : {}));
const catalog = catalogWith({ tags: ['catacomb'] });

if (isMainThread) {
    // Main's basics keep the table's picks.
    const main = build(state, catalog);
    assert.deepEqual([leafSpot(main), main.bestSpotId], [tableBest, tableIncome], 'main keeps the table');
    const worker = new Worker(__filename);
    let verified = false;
    worker.on('message', message => { verified = message === 'verified'; });
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => {
        if (code || !verified) { process.exitCode = code || 1; return; }
        console.log('test_leaf_fit passed');
    });
} else {
    const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
    // What the fit walk reads: the ranked rows in order, the first fitting
    // one earns, the fitting one with the most exp levels.
    const walk = fit => {
        const rows = ranked.slice(0, 32).filter(row => fit.includes(row.spotId));
        return { earning: rows[0], leveling: rows.reduce((top, row) => row.exp > top.exp ? row : top, rows[0]) };
    };
    const fitting = walk(listed.filter(id => !unfit.has(id)));
    assert(fitting.earning && fitting.leveling !== fitting.earning,
        'the fixture holds fitting ranked spots that earn and level best apart');
    const swappedTo = (basics, spots, why) => {
        assert.equal(basics.bestSpotId, fitting.earning.spotId, `${why}: the money leaf names the first fitting spot by income`);
        assert.equal(leafSpot(basics), fitting.leveling.spotId, `${why}: the experience leaf names the fitting spot with the most exp`);
        // The route's leaf check takes both: the economy names no spot the route refuses.
        for (const spotId of [basics.bestSpotId, leafSpot(basics)]) {
            assert.deepEqual(BotRoute.leafChoice(state, { activity: 'hunting', spotId }, { spots, timestamp: at }),
                { spotId }, `${why}: the route takes the leaf's spot ${spotId}`);
        }
    };

    // Unfit: both table picks are party-only grounds for a solo bot.
    const swapped = build(state, catalog);
    swappedTo(swapped, catalog, 'party-only ground');
    assert.equal(swapped.hunt.perHour, fitting.earning.income, 'the hunt earns the income spot\'s income');
    assert.equal(swapped.hunt.expPerHour, fitting.leveling.exp, 'and levels at the progress spot\'s exp');

    // Raid: both table picks are raid spots.
    const raids = catalogWith({ raidBoss: true });
    swappedTo(build(state, raids), raids, 'raid spot');

    // Level window: both table picks hold monsters far below the bot.
    const low = catalogWith({ avgLevel: 10, minLevel: 9, maxLevel: 11 });
    swappedTo(build(state, low), low, 'level window');

    // The exp leaf falls back by exp: only the progress pick is unfit.
    const progressOnly = walk(listed.filter(id => id !== tableBest));
    const leveling = build(state, listed.map(id => spot(id, id === tableBest ? { tags: ['catacomb'] } : {})));
    assert.equal(leveling.bestSpotId, tableIncome, 'a fitting income pick stays');
    assert.equal(leafSpot(leveling), progressOnly.leveling.spotId, 'the progress pick is the fitting spot with the most exp');
    assert.notEqual(progressOnly.leveling.spotId, progressOnly.earning.spotId, 'not the first by income');

    // Excluded: the bot's own risk exclusions (spots it was turned away from as full).
    const turnedAway = { ...state, stats: { ...state.stats, capacityBackoffs: [...unfit].map(spotId => ({ spotId, untilStep: 50 })) } };
    const plain = listed.map(id => spot(id));
    const excluded = build(turnedAway, plain);
    assert.equal(excluded.bestSpotId, fitting.earning.spotId, 'an excluded spot is no income pick');
    assert.equal(leafSpot(excluded), fitting.leveling.spotId, 'nor a progress pick');

    // Missing: the catalog does not hold the table picks.
    const present = ranked.slice(1, 6).map(row => row.spotId).filter(id => id !== tableBest);
    const kept = build(state, present.map(id => spot(id)));
    assert.equal(kept.bestSpotId, walk(present).earning.spotId, 'a spot missing from the catalog is skipped');
    assert.equal(leafSpot(kept), walk(present).leveling.spotId);

    // Own samples: an unfit best row gives way to the bot's other fitting row.
    let sampled = state;
    for (let i = 0; i < 3; i++) for (const [spotId, adena] of [[tableBest, 9000], [fitting.earning.spotId, 3000]]) {
        sampled = { ...sampled, stats: { ...sampled.stats, huntEfficiency: Hunt.record(sampled,
            { spotId, cycleMs: 60000, exp: 100, adena, kills: 5, timestamp: at }) } };
    }
    const own = build(sampled, catalog);
    assert.equal(own.hunt.source, 'own', 'a fitting own row still counts');
    assert.equal(own.bestSpotId, fitting.earning.spotId);

    // Nothing fits: the table's pick stays.
    const none = build(state, listed.map(id => spot(id, { tags: ['catacomb'] })));
    assert.equal(leafSpot(none), tableBest, 'with no fitting spot the progress pick is the table\'s');
    assert.equal(none.bestSpotId, tableIncome, 'and the income pick is the table\'s');

    parentPort.postMessage('verified');
}
