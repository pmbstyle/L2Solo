const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const fs = require('fs');
const path = require('path');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
// ---------------------------------------------------------------- lookups on a hand-made table
// Spot S (level 18, the spot allows 250 kills per hour) and T (allows 48): dps rows with and without
// shots measured at gap 6, a spoiler row, and the dps curve of the spots' band.
Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
useRate('x1');

const ref = Table.value('S', 'dps', 24, true);
near(ref.kills, 200, 'at the reference level the row\'s kills');
// ARCH-NOTE: the shipped reader already applies the C4 gap-six XP/SP penalty;
// this older fixture expected unpenalized rewards. Preserve that gameplay rule.
near(ref.exp, 20000 * (5 / 6), 'exp per hour = kills x exp per kill x gap-six penalty');
near(ref.sp, 1000 * (5 / 6), 'SP per hour follows the same C4 penalty');
assert.strictEqual(ref.rewardSource, 'unavailable', 'a combat-only fixture must not invent native reward facts');
near(ref.adena, 0, 'no fabricated adena without an NPC catalog');
near(ref.loot, 0, 'no fabricated loot without an NPC catalog');
near(ref.shots, 800, 'shots per hour');
near(ref.deaths, 0.2, 'deaths per hour = kills x deaths per kill');
near(ref.busyShare, 0.5, 'combat and recovery share of the hour');
assert.strictEqual(ref.stacks, null, 'an old table does not invent zero bag growth');
near(Table.value('S', 'dps', 18).kills, 100, 'at the spot\'s level the curve halves the kills');
near(Table.value('S', 'dps', 18).deaths, 100 * (0.001 + 0.01), 'deaths per kill add the curve\'s difference');
near(Table.value('S', 'dps', 19).kills, 200 * 0.625, 'between measured gaps the curve is linear');
near(Table.value('S', 'dps', 30).kills, 240, 'higher levels follow the curve');
near(Table.value('S', 'dps', 40).kills, 240, 'beyond the last gap the curve is flat');
near(Table.value('S', 'dps', 29).adena, 0, 'an old reward curve cannot stand in for actual NPCs');
near(Table.value('S', 'dps', 90).kills, Table.value('S', 'dps', 78).kills, 'levels above the maximum count as the maximum');
near(Table.value('T', 'dps', 24).kills, 48, 'kills never exceed what the spot\'s monster count allows');
assert.strictEqual(Table.value('S', 'dps', 15), null, 'below the lowest level that finds a safe target: no solo hunt');
assert.strictEqual(Table.value('S', 'dps', 24, false), null, 'no row: no value');
assert.strictEqual(Table.value('X', 'dps', 24), null, 'unknown spot');
assert.strictEqual(Table.value('S', 'healer', 24), null, 'unknown role');
near(Table.value('S', 'spoiler', 18).kills, 150, 'a role without a measured curve keeps its row at every level');
assert.strictEqual(Table.referenceLevel('S', 'spoiler'), 24, 'the level the row was measured at');
assert.strictEqual(Table.spotLevel('T'), 18);

// Combat rates remain independent of native reward availability.
useRate('x10');
const x10 = Table.value('S', 'dps', 24, true);
near(x10.kills, ref.kills, 'the rate does not change the fights');
near(x10.exp, ref.exp * 10, 'exp x rate');
near(x10.sp, ref.sp * 10, 'SP x rate');
assert.strictEqual(x10.rewardSource, 'unavailable');
useRate('x50');
near(Table.value('S', 'dps', 24, true).loot, ref.loot * 50 * 0.6, 'and at x50');
near(Table.value('T', 'dps', 24, true).loot, 0, 'rates cannot create missing native loot facts');
useRate('x1');

// New tables report distinct bag slots per hour, with the drop response and
// without multiplying distinct kinds by the drop amount rate.
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spot-stacks-'));
try {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spot_table.json'), 'utf8'));
    fixture.rowFields.push('stacks');
    for (const rows of fixture.rows) for (const row of rows) if (row) row.push(.02);
    const file = path.join(scratch, 'table.json');
    fs.writeFileSync(file, JSON.stringify(fixture));
    Table.useFile(file);
    near(Table.value('S', 'dps', 24).stacks, 4, '200 kills x .02 new slots per kill');
    useRate('x10');
    near(Table.value('S', 'dps', 24).stacks, 4 * .8, 'distinct slots use the drop response, not the drop amount');
    useRate('x50');
    near(Table.value('S', 'dps', 24).stacks, 4 * .6, 'the high-rate response also preserves distinct kinds');
    fixture.rows[0][0][fixture.rowFields.indexOf('stacks')] = null;
    fs.writeFileSync(file, JSON.stringify(fixture));
    Table.useFile(file);
    assert.strictEqual(Table.value('S', 'dps', 24).stacks, null, 'an absent regenerated measurement remains unknown');
} finally {
    useRate('x1');
    Table.useFile();
    fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the committed table
const raw = JSON.parse(fs.readFileSync(Table.DEFAULT_FILE, 'utf8'));
assert.strictEqual(raw.rows.length, raw.spots.length, 'one row set per spot');
assert(raw.rows.every((rows) => rows.length === raw.roles.length * raw.shots.length), 'every spot has a row per role and shots');
assert(raw.rows.flat().every((row) => row === null || row.length === raw.rowFields.length), 'every row has every field');
assert.strictEqual(raw.rows.flat().filter(Boolean).length, raw.header.counts.huntableRows, 'header counts the huntable rows');
assert(raw.roles.every((role) => Object.keys(raw.curves[role] || {}).length > 0), 'every role has curves');
assert.strictEqual(raw.header.inputs.rate, 'x1', 'the file is at rate x1');
// The reader applies the C4 exp level-gap penalty; the measured curves must not carry it too
// (T43: a table measured with it read (5/6)^6 = 0.33 at gap 12 against the reference gap).
raw.roles.forEach((role) => {
    const ref = raw.gaps.indexOf(raw.header.inputs.refGap), far = raw.gaps.indexOf(12);
    const ratios = Object.values(raw.curves[role]).map((curve) => curve.exp)
        .filter((exp) => exp && exp[far] != null && exp[ref] > 0).map((exp) => exp[far] / exp[ref]).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    assert(median > 0.8, `${role}: exp per kill at gap 12 keeps the reference level's exp (median ${median})`);
});

// A few spots of the committed table (rate x1). Bearded Keltir fields (level 2): every role hunts it;
// a dps kills more with shots, more at a higher level, and never more than the spot allows.
Table.useFile();
const keltirNpc = DataCache.npcs.find(npc => npc.template?.name === 'Bearded Keltir' && Number(npc.template?.level) === 1);
assert(keltirNpc);
Table.useSpots([{ id: '-15_42', npcEntries: [{ selfId: keltirNpc.selfId, count: 1 }] }]);
const keltir = Table.value('-15_42', 'dps', 5, true);
assert(keltir && keltir.kills > 100 && keltir.kills <= 275.2 && keltir.exp > 0 && keltir.adena > 0, 'a low field gives a dps kills, exp and adena');
assert(Table.value('-15_42', 'dps', 5, false).kills <= keltir.kills, 'shots do not slow a dps');
assert(Table.value('-15_42', 'dps', 12, true).kills >= keltir.kills, 'a higher dps kills at least as fast');
assert(raw.roles.every((role) => Table.value('-15_42', role, 8, true)), 'every role hunts the newbie field');
// Level 44 spot 7_34: the dps row was measured six levels up; far below the spot there is no solo hunt.
assert.strictEqual(Table.referenceLevel('7_34', 'dps'), 50);
assert(Table.value('7_34', 'dps', 50).exp > Table.value('-15_42', 'dps', 8).exp * 5, 'higher spots give much more exp');
assert.strictEqual(Table.value('7_34', 'dps', 30), null, 'no solo hunt far below the spot\'s level');
// Seven Signs catacombs are not solo hunting grounds in the author's rules.
assert(raw.roles.every((role) => Table.value('8_23:catacomb_of_the_heretics', role, 50) === null), 'catacombs: no solo row');
useRate('x10');
const keltirX10 = Table.value('-15_42', 'dps', 5, true);
near(keltirX10.exp, keltir.exp * 10, 'the committed table scales exp with the rate');
useRate('x1');


// The value memo drops its oldest row at the cap, in insertion order, and a clear restarts the order at the
// first slot. Unknown spot names give one distinct string key each; every call stays a plain memo row.
{
    const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
    const developer = Config.developerDiagnostics;
    const CAP = 32768;
    const started = Date.now();
    Config.developerDiagnostics = true;
    try {
        Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
        const ask = (name) => {
            const before = Table.cacheStats();
            Table.value(name, 'dps', 24);
            const after = Table.cacheStats();
            return { hit: after.memoHits - before.memoHits === 1, miss: after.memoMisses - before.memoMisses === 1,
                evicted: after.memoEvictions - before.memoEvictions };
        };
        const fill = (prefix, count) => { for (let at = 0; at < count; at++) Table.value(`${prefix}${at}`, 'dps', 24); };
        const evictions = () => Table.cacheStats().memoEvictions;
        const base = evictions();
        fill('wrap', CAP + 1);
        assert.strictEqual(Table.cacheStats().memo, CAP, 'the memo holds the cap');
        assert.strictEqual(evictions() - base, 1, 'one key over the cap drops one row');
        assert(ask('wrap1').hit, 'the second key is still present');
        assert(ask(`wrap${CAP}`).hit, 'the newest key is present');
        // Three more keys drop the next three oldest, in insertion order.
        fill('late', 3);
        assert.strictEqual(evictions() - base, 4);
        assert(ask('wrap4').hit && ask('wrap5').hit, 'wrap4 is the oldest row left');
        for (const name of ['wrap0', 'wrap1', 'wrap2', 'wrap3']) assert(ask(name).miss, `${name} was dropped in order`);
        // A clear restarts the ring at the first slot: the first key after it is the first one dropped.
        Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
        assert.strictEqual(Table.cacheStats().memo, 0);
        const cleared = evictions();
        fill('again', CAP + 1);
        assert.strictEqual(evictions() - cleared, 1);
        assert(ask('again1').hit, 'after a clear the second key is present');
        assert(ask('again0').miss, 'after a clear the first key is the one dropped');
        assert.strictEqual(Table.cacheStats().memo, CAP);
        // A row that outlives a wrap still reads its own numbers: real rows first, then the ring wraps
        // over the older half of them; the newer half is asked newest first, so no ask drops one unread.
        Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
        const real = [];
        for (const spot of ['S', 'T']) for (let level = 16; level <= 80; level++) for (const shots of [true, false]) real.push([spot, 'dps', level, shots]);
        const rows = real.map((args) => Table.value(...args));
        fill('pad', CAP - real.length / 2);
        const hits = Table.cacheStats().memoHits;
        for (let at = real.length - 1; at >= 0; at--) assert.deepStrictEqual(Table.value(...real[at]), rows[at], `${real[at]} after the wrap`);
        assert.strictEqual(Table.cacheStats().memoHits - hits, real.length / 2, 'the newer half was read from the memo');
    } finally { Config.developerDiagnostics = developer; Table.useFile(); }
    console.log(`Spot value memo ring order and clear passed in ${Date.now() - started} ms`);
}
{
    // The uncached id view (a bot's own price beliefs) ranks exactly as the shared shortlist rows
    // of the committed table (the fixture has no rewards, so no income).
    Table.useFile();
    {
        for (const [role, level, costs, shots] of [['dps', 24, { shots: 0, potions: 0 }, true],
            ['dps', 30, { shots: 5, potions: 40 }, false], ['spoiler', 20, { shots: 2, potions: 10 }, true]]) {
            const ids = Table.rankedSpotIds(role, level, costs, -15, shots, { spoilSkillLevel: 1 });
            assert.deepStrictEqual(ids, Table.rankedIncome(role, level, costs, -15, shots, { spoilSkillLevel: 1 }).map(row => row.spotId),
                `${role} ${level}: the id view keeps the shortlist order`);
        }
        assert(Table.rankedSpotIds('dps', 24, { shots: 0, potions: 0 }, -15).length > 0, 'the committed table ranks a spot');
    }
}
{
    // Two spots of equal income (the same monsters, the same measured row, no level curve): the list
    // puts the spot whose level is closest to the bot's first, whatever their ids.
    const os = require('os');
    const fixture = { header: { schema: 1, inputs: { bandLevels: 2, maxLevel: 78 } }, roles: ['dps'], shots: [1, 0],
        gaps: [-4, -2, 0, 2, 4, 6, 8], rowFields: ['minGap', 'refGap', 'kph', 'busy', 'deaths', 'exp', 'sp', 'adena', 'loot', 'shots', 'potions'],
        curveFields: ['kph', 'busy', 'deaths', 'exp', 'adena'],
        spots: [['a_far', 20, 30, 250, 1, 1, 1], ['b_near', 24, 30, 250, 1, 1, 1]],
        rows: [[[-4, 0, 100, 9, 0, 100, 5, 30, 20, 0, 0], null], [[-4, 0, 100, 9, 0, 100, 5, 30, 20, 0, 0], null]], curves: {} };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spot-table-')), 'tie.json');
    fs.writeFileSync(file, JSON.stringify(fixture));
    const npcEntries = [{ selfId: 776, count: 17 }, { selfId: 418, count: 6 }];
    Table.useFile(file);
    Table.useSpots([{ id: 'a_far', npcEntries, rewards: { adenaMin: 40, adenaMax: 140 } },
        { id: 'b_near', npcEntries, rewards: { adenaMin: 40, adenaMax: 140 } }]);
    try {
        const ranked = Table.rankedIncome('dps', 23, { shots: 0, potions: 0 });
        assert.strictEqual(ranked.length, 2, 'both spots earn');
        assert.strictEqual(ranked[0].income, ranked[1].income, 'the two spots earn the same');
        assert.deepStrictEqual(ranked.map(row => row.spotId), ['b_near', 'a_far'], 'an income tie goes to the level-23 bot\'s closest spot');
        assert.deepStrictEqual(Table.rankedSpotIds('dps', 23, { shots: 0, potions: 0 }), ['b_near', 'a_far'], 'the id view keeps that order');
        assert.deepStrictEqual(Table.rankedSpotIds('dps', 20, { shots: 0, potions: 0 }), ['a_far', 'b_near'], 'a level-20 bot gets the other one first');
        // The spot search (minGap -7) and the income route (-15) share one basis per role and level.
        const free = { shots: 0, potions: 0 }, bases = Table.cacheStats().bases;
        Table.rankedSpotIds('dps', 23, free, -15);
        assert.strictEqual(Table.cacheStats().bases, bases, 'the wider band reads the basis the narrower one built');
        const wide = Table.rankedSpotIds('dps', 28, free, -15), narrow = Table.rankedSpotIds('dps', 28, free, -7);
        assert(wide.includes('a_far') && !narrow.includes('a_far'), 'a level-8-lower spot is in the wide band only');
        assert.deepStrictEqual(narrow, wide.filter(id => id !== 'a_far'), 'the narrow band keeps the wide order');
    } finally { Table.useSpots([]); Table.useFile(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
}
console.log('Spot value table lookups, curves, caps, rates and the committed table passed');
