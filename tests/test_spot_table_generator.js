const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The spot table generator on two spots with short hunts: the same file with
// one worker and with two, and every count in place; the server's spot
// catalogue (T123) the same at every start, by night or day, whatever the
// live random points, and the one the table keys. About a minute (the world
// spawns take most of it).
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-table-'));
function generate(jobs) {
    const out = path.join(dir, `table-${jobs}.json`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-spot-table.js'),
        '--spots=2', '--hours=0.1', '--curve-hours=0.05', `--jobs=${jobs}`, `--out=${out}`],
    { cwd: root, encoding: 'utf8', env: { ...process.env } });
    assert.strictEqual(result.status, 0, `generator failed: ${result.stderr}`);
    return fs.readFileSync(out, 'utf8');
}

// The hunting spot ids of a server start: the world spawned in `periodMode`
// with `random` as the live Math.random.
function startIds(periodMode, random) {
    require('../src/Global');
    invoke('GameServer/DataCache').init();
    const World = invoke('GameServer/World/World');
    const SpotService = invoke('GameServer/Bot/AI/SpotService');
    const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const draw = Math.random;
    const saved = { npc: World.npc, user: World.user };
    Math.random = random;
    try {
        const world = { user: { sessions: [] },
            npc: { spawns: [], grid: {}, nextId: 1000000, periodMode, periodRevision: 0, periodDefinitions: [],
                raidBossRespawnTimers: new Map(), raidBossState: new Map(), gridKeys: new WeakMap() },
            items: { spawns: [], nextId: 5000000 }, addNpcToGrid() {}, indexSpawnsInGrid() {} };
        invoke('GameServer/World/Generics/SpawnNpcs').call(world);
        World.npc = world.npc; World.user = world.user;
        SpotService.reset(); SpotProfiles.reset();
        return SpotProfiles.ensure().filter((spot) => spot.raidBoss !== true).map((spot) => spot.id).sort();
    } finally {
        Math.random = draw;
        World.npc = saved.npc; World.user = saved.user;
        SpotService.reset(); SpotProfiles.reset();
    }
}

try {
    let seed = 7;
    const night = startIds('night', Math.random);
    const day = startIds('day', () => (seed = seed * 48271 % 2147483647) / 2147483647);
    assert.deepStrictEqual(day, night, 'two starts give the same spot ids');
    const one = generate(1);
    const two = generate(2);
    assert.strictEqual(one, two, 'the table does not depend on the number of workers');
    const table = JSON.parse(one);
    const roles = table.roles.length;
    // A key per C4 class line (its second profession), the author's role names as aliases.
    assert.strictEqual(roles, 31, 'a key per second-profession class line');
    assert.strictEqual(table.header.inputs.roleLines.dps, '2');
    assert.deepStrictEqual(table.header.inputs.roleClasses['3'], [0, 1, 3], 'a line holds its classes by profession stage');
    assert.deepStrictEqual(table.shots, [1, 0, 2], 'shots, none, blessed spiritshot');
    assert.strictEqual(table.spots.length, 2);
    assert.strictEqual(table.header.counts.spots, 2);
    assert.strictEqual(table.header.counts.rows, 2 * roles * 3);
    assert.strictEqual(table.rows.length, 2);
    assert(table.rows.every((rows) => rows.length === roles * 3), 'a row per role and shots');
    const dps = table.roles.indexOf(table.header.inputs.roleLines.dps);
    assert(table.rows.every((rows) => rows[dps * 3 + 2] === null), 'no blessed spiritshot row for a soulshot class');
    assert(table.rows.flat().every((row) => row === null || row.length === table.rowFields.length), 'complete rows');
    assert.strictEqual(table.rows.flat().filter(Boolean).length, table.header.counts.huntableRows);
    assert(table.header.counts.huntableRows > 0, 'the first spots are huntable');
    assert(table.header.counts.catalogueSpots > 1500, 'the spawned world has its hunting spots');
    assert.strictEqual(table.header.counts.catalogueSpots, night.length, 'the generator\'s catalogue is the server\'s');
    assert.deepStrictEqual(table.spots.map((spot) => spot[0]), night.slice(0, 2), 'the table keys the server\'s spot ids');
    assert.strictEqual(table.header.inputs.rate, 'x1');
    assert(/^[0-9a-f]{7,}/.test(table.header.revision), 'the revision is recorded');
    assert.deepStrictEqual(table.header.fingerprint, require('../src/GameServer/Bot/AI/TableFingerprint').fingerprint('spot'),
        'the files it was simulated by are recorded (npm run check compares them)');
    assert(table.spots.every((spot) => spot.length === 9 && spot[3] > 0 && spot[4] === 1 && spot[5] > 0 && spot[6] > 0
        && spot[7] > 0 && spot[8] > 0),
        'every spot has its level, density, kill cap, a pull of one monster, its loot response to the rate and its kills\' accuracy and evasion');
    // Per-mob rows: mobs per fight, the cap of the spawns the bot may fight, the kills by species.
    const field = name => table.rowFields.indexOf(name);
    for (const row of table.rows.flat().filter(Boolean)) {
        assert(row[field('pull')] >= 1 && row[field('cap')] > 0, 'a row has its pull and its own cap');
        const mix = row[field('mix')];
        assert(Array.isArray(mix) && mix.length >= 2 && mix.length % 2 === 0, 'a row has its kill mix');
        const shares = mix.filter((_, at) => at % 2 === 1);
        assert(Math.abs(shares.reduce((sum, share) => sum + share, 0) - 1) < 0.01, 'the mix shares make the kills');
        // The gate per gap (T106): cap x 256 + the mix species that bot may fight, open at the reference.
        const gate = row[field('gate')];
        assert(Array.isArray(gate) && gate.length === table.gaps.length, 'a gate value per gap');
        const reference = gate[table.gaps.findLastIndex(gap => gap <= row[field('refGap')])];
        assert(reference > 0 && reference % 256 > 0 && reference % 256 < 1 << (mix.length / 2), 'the reference gap is open');
        // The admitted part of the gate species' production per gap (the fight's soloShareMobs).
        const share = row[field('gateShare')];
        assert(Array.isArray(share) && share.length === table.gaps.length && share.every(part => part > 0 && part <= 1),
            'a production share per gap');
    }
    // A row hunts on an outing's shots and potions, so its bag weighs what a bot
    // carries and the drops it picks up stay in its loot and stacks.
    const hunted = table.rows.flat().filter(Boolean);
    const looted = hunted.filter((row) => row[field('loot')] > 0 && row[field('stacks')] > 0).length;
    assert(looted * 4 > hunted.length, `the rows keep their loot (${looted} of ${hunted.length} rows with loot and stacks)`);
    // Gladiator and Warlord lines are one Warrior below 40: a row read there is measured once.
    const gladiator = table.roles.indexOf('2'), warlord = table.roles.indexOf('3'), exp = field('exp');
    table.rows.forEach((rows, spot) => {
        const row = rows[gladiator * 3];
        if (row && table.spots[spot][1] + row[field('refGap')] < 40) {
            assert.strictEqual(rows[warlord * 3][exp], row[exp], 'lines of one class share its hunt');
        }
    });
    // The kit surface: fight and damage-taken coefficients per
    // line and band over the kit features, fitted from real fights in kits.
    assert.deepStrictEqual(table.kitSurface.features, ['offence', 'pDefence', 'mDefence', 'hp']);
    const surfaces = Object.entries(table.kitSurface.rows).flatMap(([line, byBand]) =>
        Object.entries(byBand).map(([band, surface]) => [`${line}/${band}`, ...surface]));
    assert(surfaces.length > 0, 'a band has its kit surface');
    for (const [where, fight, taken, points] of surfaces) {
        // taken null: a line that kills before contact in every kit (a bow below 40 too).
        assert(fight.length === 4 && (taken === null || taken.length === 4) && points >= 8, 'four coefficients each, from enough kits');
        // A summoner's blows are held under its pet's hate (PetTankRule): the pet sets the pace.
        const line = where.split('/')[0];
        const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
        if (table.header.inputs.roleClasses[line].some((classId) => BotRoles.isSummoner({ classId }))) continue;
        assert(fight[0] < 0, `a stronger weapon shortens the fight of ${where}: ${fight}`);
    }
    for (const role of Object.keys(table.curves)) {
        for (const curve of Object.values(table.curves[role])) {
            assert(table.curveFields.every((field) => curve[field].length === table.gaps.length), 'a curve value per gap');
            assert.strictEqual(curve.kph[table.gaps.indexOf(table.header.inputs.refGap)], 1, 'curves are relative to the reference gap');
        }
    }
    // A split run's part pairs with the run of its own task list only.
    (async () => {
        const Generator = require('../scripts/generate-spot-table');
        const parts = path.join(dir, 'parts');
        fs.mkdirSync(parts);
        const tasks = [{ kind: 'row', spotId: 'a', hours: 2 }, { kind: 'row', spotId: 'b', hours: 2 }];
        const part = (tasksHash) => fs.writeFileSync(path.join(parts, 'rows-1.json'),
            JSON.stringify({ phase: 'rows', total: 2, tasksHash, indices: [0, 1], results: ['A', 'B'] }));
        part(Generator.tasksHash(tasks));
        assert.deepStrictEqual(await Generator.phaseResults('rows', tasks, { phase: 'merge', parts }), ['A', 'B'], 'its own run\'s part');
        part(Generator.tasksHash([tasks[1], tasks[0]]));
        await assert.rejects(Generator.phaseResults('rows', tasks, { phase: 'merge', parts }), /another run/,
            'a part of the same size from other spots is refused');
    })().then(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        // The built table through the real reader: every row's fight + rest fit
        // in its hour per kill at every level the reader serves it (its least
        // gap to the deep-blue gap), so a reader's idle (HuntCycle's hour:
        // 3600 / kph - fight - rest) is never clamped and the kills an hour a
        // reader charges are the cell's own, within the rows' 4-digit rounding.
        const { ROUNDING } = require('../scripts/generate-spot-table');
        const Invariants = require('../scripts/economy-model/fight/invariants');
        const Table = invoke('GameServer/Bot/AI/SpotValueTable');
        const ProgressionRates = invoke('GameServer/ProgressionRates');
        const built = JSON.parse(fs.readFileSync(path.join(root, 'data', 'Bots', 'spot-table.json'), 'utf8'));
        const field = Object.fromEntries(built.rowFields.map((name, index) => [name, index]));
        const maxLevel = built.header.inputs.maxLevel;
        const over = [];
        let read = 0;
        built.rows.forEach((rows, s) => rows.forEach((row, index) => {
            if (!row) return;
            const [spotId, spotLevel] = built.spots[s];
            const role = built.roles[Math.floor(index / built.shots.length)], shots = built.shots[index % built.shots.length];
            const from = Math.max(1, Math.ceil(spotLevel + row[field.minGap]));
            const to = Math.min(maxLevel, Math.floor(spotLevel + ProgressionRates.DEEP_BLUE_LEVEL_GAP));
            for (let level = from; level <= to; level++) {
                const cell = Table.cycle(spotId, role, level, shots === 2 ? 2 : shots === 1);
                if (!cell) continue;
                read += 1;
                if (Invariants.overHour(cell, ROUNDING)) over.push(`${spotId} ${role} level ${level} shots ${shots}: ${cell.fight + cell.rest} s over ${3600 / cell.kph} s`);
            }
        }));
        console.log(`the reader read ${read} cells of the built table, ${over.length} over their hour per kill`);
        assert(read > 1000000, `the reader reads the built rows at every gap (${read})`);
        assert.deepStrictEqual(over.slice(0, 10), [], `every built row fits in its hour per kill at every gap (${over.length} do not)`);
        console.log('Spot table generator determinism and counts passed');
    }, (error) => {
        fs.rmSync(dir, { recursive: true, force: true });
        console.error(error);
        process.exit(1);
    });
} catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
}

// A row hunts on the stock the game buys: a full bag's use plus the reserve
// (ConsumableTarget), restocked and its drops sold each time the bag would be
// full. The reference bot (human, solo) turns back at its 40-slot half bag; it
// wears one piece and drinks 10 Lesser Healing Potions every half hour (20 an
// hour), and each round offers two new kinds of material (4 new slots an
// hour). On the use pass its endless bottles weigh past maxLoad, so the
// pickup rule refuses every drop; the slots are counted on the loot as rolled
// all the same: 40 - the piece - the planned bottles = 38 free / 4 an hour =
// 9.5 h, before the weight step ((9999 - 2 - 5) / (20 x 5 x 1.1) = 90.8 h).
// A spot of Vrykolakas (lvl 15) kills 20 an hour at the kill mix's expected
// drop weight of 52.76 a kill (SpotRewardExpectation, the datapack's drop
// list): the load bounds the hours first, 9992 / (20 x 52.76 + 110) = 8.58 h.
function stockRow(spot, killedNpcs) {
    require('../src/Global');
    const Data = invoke('GameServer/DataCache'); Data.init();
    const RoundLoot = invoke('GameServer/Bot/Population/RoundLoot');
    const Generator = require('../scripts/generate-spot-table');
    const kinds = Data.items.filter(item => item.etc?.stackable && item.template?.kind === 'Other.Material'
        && item.template?.mass > 0 && item.selfId !== 1864).map(item => item.selfId);
    const seen = [];
    let offered = 0;
    const simulation = { items: Data.items,
        BotGear: { planFor: () => ({ items: [{ selfId: 1864, slot: 0 }] }) },
        Potions: { purchasePotionFor: () => ({ selfId: 1060 }) },
        CCP: { profileFor: () => ({ maxHp: 100, maxMp: 100, maxLoad: 20000 }), attackReach: () => 0,
            skillRecordsFromTree: () => [], skillSnapshotsFromRecords: () => [] },
        HuntEfficiency: { lootValue: () => 0 },
        BR: { admittedShares: () => null, admittedDensity: spot => spot.density, soloFightCount: () => 1,
            resolveSolo({ state, timestamp }) {
                const potions = Number(state.inventory['1060']?.amount || 0), used = Math.min(10, potions);
                seen.push({ timestamp, potions, drops: Object.keys(state.inventory).filter(id => kinds.includes(Number(id))).length });
                const loot = [{ selfId: kinds[offered++], amount: 1 }, { selfId: kinds[offered++], amount: 1 }];
                const inventory = { ...state.inventory, 1060: { ...state.inventory['1060'], amount: potions - used } };
                const { kept } = RoundLoot.keep(inventory, loot, 80, 20000);
                return { materialize: { items: kept }, debug: { wins: 10, mobsKilled: 10, killedNpcs, combatMs: 1000, potionsUsed: used },
                    patch: { inventory: RoundLoot.addTo(inventory, kept) }, nextResolveAt: timestamp + 1800000 };
            } } };
    let pass = null;
    Generator.hunt(spot, 'dps', 20, false, 12, simulation, null, undefined, name => {
        pass = name; seen.length = 0; offered = 0;
    });
    assert.strictEqual(pass, 'row');
    return seen;
}
function stockFixture() {
    const seen = stockRow({ id: 'stock', center: {}, density: 1 }, {});
    const start = seen[0].timestamp;
    assert.strictEqual(seen[0].potions, 204, 'the row sets out with a full bag\'s use plus the reserve: 20 x 9.25 x 1.1, the bag less the scroll the visit buys (old: 40, two hours\' use)');
    // Restocked at the round that fills the bag (9.5 h), not every two hours, and the visit sells the drops.
    const restocks = seen.filter((step, index) => index > 0 && step.potions > seen[index - 1].potions - 10);
    assert.deepStrictEqual(restocks.map(step => (step.timestamp - start) / 3600000), [9.5], 'the stock is restocked as the bag would be full');
    assert.strictEqual(restocks[0].drops, 0, 'the visit sold the drops: the outing after it starts with an empty bag');
    assert.strictEqual(seen[seen.indexOf(restocks[0]) - 1].drops, 36, 'the round before the visit set out with 18 rounds of drops; its own fill the 38 free slots');
    // The drop's weight: the row restocks at the load bound, before the slots fill.
    const heavy = stockRow({ id: 'stock-drop', center: {}, density: 1, npcEntries: [{ selfId: 398, count: 1 }] }, { 398: 10 });
    assert.strictEqual(heavy[0].potions, 187, 'the stock is a full bag\'s use by the drop\'s weight less the scroll\'s: 20 x 8.5 x 1.1 (the slots alone: 204)');
    const heavyRestocks = heavy.filter((step, index) => index > 0 && step.potions > heavy[index - 1].potions - 10);
    assert.deepStrictEqual(heavyRestocks.map(step => (step.timestamp - heavy[0].timestamp) / 3600000), [8.5],
        'the stock is restocked as the drop\'s weight reaches the first weight step (8.5 h), before the slots fill (9.25 h)');
}
stockFixture();
