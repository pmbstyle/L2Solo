'use strict';
// The economy model's game-data snapshot carries the server's own numbers:
// a spot hour as the spot table gives it, and per-item yields that price to
// the spot value's drop and spoil money per kill.
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Started from another folder, the snapshot still finds the recipe data
// (read relative to the working directory).
process.chdir(os.tmpdir());
const Boot = require('../scripts/economy-model/boot');
const Inputs = require('../scripts/economy-model/inputs');
Boot.boot('x50');

const line = '55', level = 30;
const caster = '12';
const snapshot = Inputs.extract({ preset: 'x50', lines: [line, '2', caster], levels: [level, level] });
assert.equal(snapshot.header.rates.drop, 50, 'the preset\'s rates');
assert.ok(snapshot.recipes.length > 700, 'recipes are read wherever the script starts');
const ssd = snapshot.recipes.find(row => row.productId === 1463);
assert.equal(ssd.productCount / ssd.mpCost, 3.9);

const DeathExperience = invoke('GameServer/Progression/DeathExperience');
assert.equal(snapshot.deathExp[40 - 1], DeathExperience.calculateLoss({ level: 40, exp: Number.MAX_SAFE_INTEGER }).expLost, 'the death exp is the game\'s rule');
assert.ok(snapshot.deathExp[40 - 1] > 0, 'a level 40 death takes exp');

const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const hour = snapshot.hours[line][level];
const best = Table.best(line, level, true, 'income');
for (const field of Inputs.HOUR_FIELDS) assert.equal(hour.best[field], best[field], `best ${field}`);
const ranked = Table.rankedIncome(line, level);
assert.equal(hour.top.length, 10, 'the ten spots an occupation ranks');
hour.top.forEach((row, i) => assert.equal(row.spotId, ranked[i].spotId, `top ${i} is the ranked income's`));
assert.equal(hour.top[0].adena, ranked[0].adena);
assert.equal(hour.shotId, 1463, 'a Bounty Hunter at 30 fires Soulshot D');
assert.ok(snapshot.kits[line][level].length > 0, 'the reference kit');

// Each spot a main may hold carries the levels the spot table has a row for
// the line there (spot_left fires outside them); the rows outside the top
// are spots it may keep or rank for a shot recipe's scroll, never a top spot.
const ranges = snapshot.spotLevels[line];
for (const row of hour.top) {
    const [low, high] = ranges[String(row.spotId)];
    assert.ok(low <= level && level <= high, `top spot ${row.spotId} in its range ${low}-${high}`);
    assert.ok(Table.value(String(row.spotId), line, low, true)?.kills > 0 && !(Table.value(String(row.spotId), line, high + 1, true)?.kills > 0), `${row.spotId}: the table's own rows bound the range`);
}
const ssdScroll = 1804;
for (const row of hour.others || []) {
    assert.ok(!hour.top.some(top => top.spotId === row.spotId), `${row.spotId} is not a top spot`);
    assert.ok(row.scrolls === undefined || row.scrolls.every(id => snapshot.recipes.some(recipe => recipe.recipeItemId === id && snapshot.items[recipe.productId]?.kind === 'Other.Shot')), 'scrolls named are shot recipes\' scrolls');
}
// A line whose best row with shots the game's solo gate closes without shots has the game's own shotless best beside it: the
// spot SpotValueTable.best names for a line hunting without shots, as an hour row of the other rows' shape (its hour with shots at
// the top level, the game's bare reading in shotless), its yields written (the Human Mystic line at the first level whose best
// row with shots the gate closes without them).
const gated = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find(at => !(Table.value(String(Table.best(caster, at, true, 'income').spotId), caster, at, false)?.kills > 0));
assert.ok(gated, 'fixture: a Mystic level whose best row with shots kills nothing without them');
const mystic = Inputs.extract({ preset: 'x50', lines: [caster], levels: [gated, gated] }), mysticHour = mystic.hours[caster][gated];
const bareSpot = String(Table.best(caster, gated, false, 'income').spotId), bareShots = Table.value(bareSpot, caster, gated, true), bareRead = Table.value(bareSpot, caster, gated, false);
assert.equal(mysticHour.bareBest.spotId, bareSpot);
for (const field of Inputs.HOUR_FIELDS) if (field !== 'spotId') assert.equal(mysticHour.bareBest[field], bareShots[field], `bareBest ${field} is the spot's hour with shots`);
assert.ok(mysticHour.bareBest.shots > 0, 'a bot at its bare best still has a shot need');
assert.equal(mysticHour.bareBest.shotless.kills, bareRead.kills, 'its shotless is the game\'s bare reading');
assert.ok(mysticHour.bareBest.shotless.kills > 0, 'its bare best kills without shots');
assert.equal(mysticHour.best.shotless.kills, 0, 'the best row with shots kills nothing without them');
assert.notEqual(mysticHour.bareBest.spotId, mysticHour.best.spotId, 'the bare best is another spot');
assert.ok(mystic.yields[`${bareSpot}@${gated}`]?.town, 'the bare best spot\'s yields and town are written');
// Where the bare best spot is also a top spot its row has the top row's values (one hour per spot whichever way it is read).
for (const level of [1, 2, 3]) {
    const hourAt = Inputs.extract({ preset: 'x50', lines: [caster], levels: [level, level] }).hours[caster][level];
    const top = hourAt.top.find(row => row.spotId === hourAt.bareBest?.spotId);
    if (top) for (const field of Inputs.HOUR_FIELDS) assert.equal(hourAt.bareBest[field], top[field], `level ${level}: bareBest ${field} is the top row's`);
}
const low = Inputs.extract({ preset: 'x50', lines: [line], levels: [22, 22] });
assert.ok((low.hours[line][22].others || []).some(row => row.scrolls?.includes(ssdScroll)), 'at 22 a spot that yields the Soulshot D recipe is a candidate outside the top');

// Spot value (SpotRewardExpectation) against the snapshot's per-item yields at the npcBuy price.
const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
const spots = Inputs.rewardSpots();
const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} against ${b}`);
const keys = Object.keys(snapshot.yields);
assert.ok(keys.length >= 3, 'yields for the spots of the hour');
let spoiled = 0;
for (const key of keys) {
    const row = snapshot.yields[key];
    const value = Rewards.value(spots.get(row.spotId), row.level, { spoilSkillLevel: row.spoilSkill });
    const priced = yields => Object.entries(yields).reduce((sum, [id, count]) => sum + (Number(id) === 57 ? 0 : count * snapshot.items[id].npcBuy), 0);
    close(priced(row.drop), value.drop, `${key} drop money per kill`);
    close(priced(row.spoil), value.spoil, `${key} spoil money per kill`);
    if (snapshot.compositions[row.spotId].npcs.every(npc => npc.rewardId !== null)) close(row.drop[57] || 0, value.adena, `${key} adena per kill`);
    if (value.spoil > 0) spoiled++;
}
assert.ok(spoiled > 0, 'a Bounty Hunter spoils at its spots');

// Every line carries the Spoil level the spot table gives it, not the Bounty
// Hunter's alone: line 57 at level 30 spoils exactly as the table says.
const other = Inputs.extract({ preset: 'x50', lines: ['57'], levels: [30, 30] });
const owed = Table.roleSpoilLevel('57', 30);
assert.ok(owed > 0, 'the table gives line 57 a Spoil level at 30');
const spoilers = Object.values(other.yields).filter(row => row.spoilSkill === owed);
assert.ok(spoilers.length > 0, 'its spots are priced at that Spoil level');
assert.ok(spoilers.some(row => Object.keys(row.spoil).length > 0), 'and carry spoil yields');

// Rates move the yields: a group item at x50 against x1.
const x1 = Inputs.extract({ preset: 'x1', lines: [line], levels: [level, level] });
const key = keys.find(k => x1.yields[k]);
assert.ok(Object.values(snapshot.yields[key].drop).reduce((a, b) => a + b, 0)
    > Object.values(x1.yields[key].drop).reduce((a, b) => a + b, 0), 'more items per kill at x50');
assert.deepEqual(snapshot.npcOffers.x1[1785], x1.npcOffers.preset[1785], 'NPC offers at x1 in every snapshot');
assert.equal(snapshot.npcOffers.preset[1785][0].price, x1.npcOffers.preset[1785][0].price, 'and the NPC prices of x50 are the x1 prices (the game prices x1 at every preset)');

// The design mode's additions, each the owner's own number: the hour without
// shots, a twin's max MP and store slots, a line's race, the crystal ids and
// the per-kill yields at the design's rates.
// hourRowWithForms on a stub spot table: the hour without shots is the zero hour where the bare reading kills
// nothing or does not exist (the latter marked unmeasured), the reading's own fields otherwise.
{
    const row = { spotId: 's', kills: 10, exp: 50, adena: 100, shots: 20, dropLoot: 1, spoilLoot: 0, loot: 1, potions: 0, busyShare: 1, deaths: 0 };
    const zero = Object.fromEntries(Inputs.SHOTLESS_FIELDS.map(field => [field, 0]));
    const stub = bare => ({ value: (spot, line, level, shots) => (shots === false ? bare : null) });
    const noKills = Inputs.hourRowWithForms(row, 1, 1, stub({ kills: 0, exp: 0, adena: 0, dropLoot: 0, spoilLoot: 0, loot: 0 }));
    assert.deepEqual(noKills.shotless, zero, 'bare kills 0: the zero hour');
    assert.ok(!('shotlessUnmeasured' in noKills), 'measured, so not marked');
    const none = Inputs.hourRowWithForms(row, 1, 1, stub(null));
    assert.deepEqual(none.shotless, zero, 'no bare reading: the zero hour');
    assert.equal(none.shotlessUnmeasured, true, 'and marked unmeasured');
    const normal = Inputs.hourRowWithForms(row, 1, 1, stub({ kills: 4, exp: 20, adena: 40, dropLoot: 1, spoilLoot: 0, loot: 1, extra: 9 }));
    assert.deepEqual(normal.shotless, { kills: 4, exp: 20, adena: 40, dropLoot: 1, spoilLoot: 0, loot: 1 }, 'a normal bare reading: its fields');
    assert.ok(!('shotlessUnmeasured' in normal));
}
Boot.usePreset('x50');
const bare = Table.value(String(hour.best.spotId), line, level, false);
for (const field of Inputs.SHOTLESS_FIELDS) assert.equal(hour.best.shotless[field], bare[field], `shotless ${field}`);
assert.ok(hour.best.shotless.kills < hour.best.kills, 'fewer kills without shots');
// A line that fires spiritshots carries each row's hour firing Blessed
// Spiritshots (the spot table's with shots 2); a soulshot line has none.
const rowsOf = at => [at.best, ...at.top, ...(at.others || [])].filter(Boolean);
const casterRows = rowsOf(snapshot.hours[caster][level]);
assert.ok(casterRows.length > 1, 'the caster\'s rows');
for (const row of casterRows) {
    const blessed = Table.value(String(row.spotId), caster, level, 2);
    assert.deepEqual(row.blessed, Object.fromEntries(Inputs.BLESSED_FIELDS.map(field => [field, blessed[field]])), `${row.spotId}: the blessed hour`);
}
assert.ok(casterRows.some(row => row.blessed.exp > row.exp && row.blessed.adena > row.adena), 'blessed shots earn and level faster at some spot');
for (const other of [line, '2']) assert.ok(rowsOf(snapshot.hours[other][level]).every(row => !('blessed' in row)), `line ${other} fires soulshots: no blessed hour`);
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
assert.equal(snapshot.twins[30].maxMp, Profile.profileFor({ level: 30, stats: { classId: 56 } }, 0).maxMp, 'an Artisan at 30');
assert.equal(snapshot.twins[55].classId, 57, 'a Warsmith from 40');
assert.deepEqual(snapshot.twins[30].storeSlots, { sell: 4, buy: 5 }, 'a dwarf\'s store slots');
assert.equal(snapshot.twins[10].createItem, 1, 'twins below 20 are read too');
assert.equal(snapshot.races['55'], 4, 'a Bounty Hunter is a dwarf');
assert.equal(snapshot.crystalIds.D, 1458);
const DesignIncome = require('../scripts/economy-model/design-income');
const Load = require('../scripts/economy-model/load');
const { DESIGN_RATES } = require('../scripts/economy-model/rules/dropRule');
const designKey = keys[0], designRow = snapshot.yields[designKey];
assert.deepEqual(snapshot.yieldsDesign[designKey], DesignIncome.designYields(snapshot, designRow.spotId, designRow.level, designRow.spoilSkill, DESIGN_RATES.x50, DesignIncome.gameRules()),
    'the design yields are the drop rule at the design\'s x50 rates');
const designAtX1 = DesignIncome.designYields(snapshot, designRow.spotId, designRow.level, designRow.spoilSkill, DESIGN_RATES.x1, DesignIncome.gameRules());
assert.ok(Math.abs(snapshot.yieldsDesign[designKey].drop[57] / (DESIGN_RATES.x50.adena * designAtX1.drop[57]) - 1) < 1e-9, 'design adena at x50 is the adena rate times its x1 yield');

// The market's additions, each the owner's own number: a line's bag slots
// and max load, each top spot's hour without
// shots and the C and D crystals a Luxury row takes.
const Inventory = require('../src/GameServer/Inventory/InventoryLimits');
const Formulas = invoke('GameServer/Formulas');
assert.deepEqual(snapshot.bags[line], { race: 4, slots: Inventory.capacity(4, 0), maxLoad: Math.round(Formulas.calcMaxLoad(45)) }, 'a dwarf\'s 100 slots and the CON 45 load');

// A trip's hours are the game's cold trip (ColdTrip, no Scroll of Escape
// held): from a spot's centre into its town, from every town back to the
// centre, and from town to town; every spot and every town is present.
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip'), townRows = Object.values(invoke('GameServer/World/TownRespawn').towns);
const townPoint = town => ({ locX: town.locX, locY: town.locY, locZ: town.locZ }), planHours = plan => plan.durationMs / 3600000;
assert.ok(snapshot.tripHours && snapshot.townHours, 'the snapshot carries the game\'s trip hours');
assert.deepEqual(Object.keys(snapshot.tripHours.to).sort(), Object.keys(snapshot.compositions).sort(), 'every spot has its trip into town');
for (const id of Object.keys(snapshot.compositions)) assert.deepEqual(Object.keys(snapshot.tripHours.back[id]).sort(), townRows.map(town => town.name).sort(), `spot ${id} has a way back from every town`);
{
    const cardRows = require('../data/Bots/hunt/spots.json'), centerAt = cardRows.spotFields.indexOf('center'), cardTownAt = cardRows.spotFields.indexOf('town');
    const sampled = [String(hour.best.spotId), String(cardRows.spots.find(row => row[cardTownAt] === 'Floran Village')[0]), String(cardRows.spots[cardRows.spots.length - 1][0])];
    for (const id of sampled) {
        const row = cardRows.spots.find(card => String(card[0]) === id), center = { locX: row[centerAt][0], locY: row[centerAt][1], locZ: row[centerAt][2] };
        const into = townRows.find(town => town.name === row[cardTownAt]);
        assert.equal(snapshot.tripHours.to[id], planHours(ColdTrip.townPlan({ loc: center, stats: {}, inventory: {} }, townPoint(into))), `spot ${id}: the trip into ${into.name} is ColdTrip's`);
        for (const town of townRows) assert.equal(snapshot.tripHours.back[id][town.name], planHours(ColdTrip.spotPlan({ loc: townPoint(town), stats: {} }, center)), `spot ${id}: the way back from ${town.name} is ColdTrip's`);
    }
}
// Into the town it stands in it is there already: 0 hours (Floran Village too, whose plan into itself runs through Dion).
for (const from of townRows) for (const into of townRows) {
    if (from === into) assert.equal(snapshot.townHours[from.name][into.name], 0, `${from.name} into itself: no trip`);
    else assert.equal(snapshot.townHours[from.name][into.name], planHours(ColdTrip.townPlan({ loc: townPoint(from), stats: {}, inventory: {} }, townPoint(into))), `${from.name} to ${into.name} is ColdTrip's`);
}
// A spot whose trip into town takes no hours is a hole in the game's data, not a trip: the snapshot is not built.
{
    const townPlan = ColdTrip.townPlan;
    ColdTrip.townPlan = (...args) => ({ ...townPlan(...args), durationMs: 0 });
    try { assert.throws(() => Inputs.extract({ preset: 'x50', lines: [line], levels: [level, level] }), /in no time/, 'a to-town leg of 0 hours throws'); } finally { ColdTrip.townPlan = townPlan; }
}
assert.ok(snapshot.townHours.Dion.Giran > 0 && snapshot.tripHours.to[hour.best.spotId] > 0, 'a trip takes time');
assert.ok(!('walkBack' in snapshot) && !('walkBackZero' in snapshot.fallbacks), 'one owner of a trip\'s hours: no walk back beside them');
const topBare = Table.value(String(hour.top[9].spotId), line, level, false);
assert.equal(hour.top[9].shotless.kills, topBare && topBare.kills > 0 ? topBare.kills : 0, 'the tenth spot carries its hour without shots (the zero hour where the line kills nothing bare)');
// A row with no bare reading is marked unmeasured; one measured at kills 0 or above is not.
for (const row of [hour.best, ...hour.top]) {
    const measured = Table.value(String(row.spotId), line, level, false);
    assert.equal(row.shotlessUnmeasured === true, !measured, `spot ${row.spotId}: unmeasured exactly without a bare reading`);
    if (!measured || measured.kills === 0) for (const field of Inputs.SHOTLESS_FIELDS) assert.equal(row.shotless[field], 0, `spot ${row.spotId}: the zero hour, ${field}`);
}
assert.deepEqual(snapshot.luxuryOptions[71], { npcId: 7097, town: 'Giran', crystals: [{ selfId: 1459, amount: 573 }, { selfId: 1458, amount: 2865 }] }, 'Flamberge for 573 C and 2865 D crystals together');
assert.ok(!('luxury' in snapshot) && !('upkeep' in snapshot), 'one Luxury catalogue (luxuryOptions) and no servitor upkeep in the snapshot');

// The gear ladder: a Scavenger's (the Bounty Hunter at 30) band 30-34 holds
// the gear table's D weapon rungs and the no-grade ones below, none above D,
// its best spot, its scale to the design's money; a kit's hours are read
// through kit-hours.js, not stored.
const name = id => snapshot.items[id]?.name;
const band = snapshot.gearLadder.lines[line];
assert.deepEqual(band.map(row => [row.from, row.to, row.level, row.grade]), [[30, 34, 32, 'd']], 'the band of the levels asked, read at its middle');
const weapons = band[0].rungs.weapon, club = weapons.find(id => name(id) === 'Spiked Club');
for (const wanted of ['Hand Axe', 'Tomahawk', 'Spiked Club']) assert.ok(weapons.some(id => name(id) === wanted), `${wanted} is a rung`);
assert.ok(weapons.every(id => ['D', 'NONE'].includes(snapshot.items[id].grade)), 'no rung above the band\'s grade');
assert.equal(band[0].best, String(Table.best(line, 32, true, 'income').spotId), 'the band\'s best spot');
assert.ok(band[0].scale > 0 && band[0].scale < 1, `x50 design money under today's: ${band[0].scale}`);
assert.ok(!('hour' in band[0]) && !('gear' in band[0]), 'no kit hour stored');
assert.equal(snapshot.gearLadder.slots[club], 7, 'a rung\'s own slot');

// The trade towns are the game's own (MarketTownPolicy): C and above in
// Giran, D in either D market, a no-grade lot in the starter-village market
// nearest the spot card's centre (a Talking Island spot sells there), and
// at least four of the five villages over the spots.
const villages = ['Talking Island', 'Elven Village', 'Dark Elven Village', 'Orc Village', 'Dwarven Village'];
assert.equal(snapshot.tradeTowns.higher, 'Giran');
assert.deepEqual(snapshot.tradeTowns.d, ['Gludio', 'Dion']);
assert.equal(snapshot.tradeTowns.grade[1463], 'd');
const cards = require('../data/Bots/hunt/spots.json'), townAt = cards.spotFields.indexOf('town'), minAt = cards.spotFields.indexOf('minLevel');
const island = cards.spots.find(row => row[townAt] === 'Talking Island' && row[minAt] <= 5);
assert.equal(snapshot.tradeTowns.none[String(island[0])], 'Talking Island', `${island[0]} sells in Talking Island`);
const markets = new Set(Object.values(snapshot.tradeTowns.none));
assert.ok([...markets].every(town => villages.includes(town)) && markets.size >= 4, [...markets].join(', '));

// The arrow of each bow grade, as the game's arrow stock names it.
const ArrowStock = invoke('GameServer/Inventory/ArrowStock');
assert.deepEqual(snapshot.arrowIds, { ...ArrowStock.BY_RANK });
assert.equal(snapshot.arrowIds.d, 1341, 'Bone Arrow for a D bow');
assert.equal(snapshot.items[1341]?.name, 'Bone Arrow', 'the arrows ride in items');

// A run reads the snapshot of the live game data, never the newest file. Its
// stamp holds every tree file the extract loaded: the fares, static stores,
// craft eligibility, store slots, bags, market towns, Luxury lists, raid
// safety and inputs.js itself. An edit to one refuses the old snapshot, with
// the command that builds one, in every mode that reads a snapshot.
{
    const loaded = Boot.loadedFiles();
    for (const file of ['src/GameServer/Bot/MerchantStoreConfigs.js', 'src/GameServer/Bot/Economy/CraftEligibility.js', 'src/GameServer/PrivateStoreLimits.js',
        'src/GameServer/Inventory/InventoryLimits.js', 'src/GameServer/Bot/Economy/MarketTownPolicy.js', 'src/GameServer/Bot/Economy/MarketCounters.js',
        'src/GameServer/Bot/Travel/TravelRoutes.js', 'src/GameServer/World/Generics/NpcExchangeShopLists.js', 'src/GameServer/Bot/AI/BotRaidSafety.js',
        'scripts/economy-model/inputs.js']) assert.ok(loaded.includes(file), `the stamp holds ${file}`);
    // The fares in a temp copy inside the tree, one of the snapshot's files.
    fs.mkdirSync(path.join(Boot.root, 'tmp'), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(Boot.root, 'tmp', 'economy-stamp-')), dir = path.join(scratch, 'snapshots');
    fs.mkdirSync(dir);
    const fares = path.join(scratch, 'TravelRoutes.js');
    fs.copyFileSync(path.join(Boot.root, 'src/GameServer/Bot/Travel/TravelRoutes.js'), fares);
    const files = [...loaded, path.relative(Boot.root, fares).split(path.sep).join('/')];
    const write = (name, mtime) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify({ header: { preset: 'x50', ...Boot.dataStamp(files), sourceFiles: files } }));
        fs.utimesSync(file, mtime, mtime);
        return file;
    };
    try {
        // inputs.js builds the header: the stamp of a built x1 snapshot holds
        // the files the extract read through fs, not only its modules.
        const built = childProcess.spawnSync(process.execPath, ['scripts/economy-model/inputs.js', '--preset', 'x1', '--out', path.join(scratch, 'built')], { cwd: Boot.root, encoding: 'utf8', maxBuffer: 1 << 28 });
        assert.equal(built.status, 0, built.stderr);
        const header = JSON.parse(fs.readFileSync(path.join(scratch, 'built', fs.readdirSync(path.join(scratch, 'built')).find(name => name.startsWith('inputs-x1-'))), 'utf8')).header;
        for (const file of ['config/default.ini', 'data/ExtractableItems/extractable_items.csv', 'data/Bots/hunt/gear.json', 'scripts/economy-model/inputs.js'])
            assert.ok(header.sourceFiles.includes(file), `the stamp holds ${file}`);
        assert.ok(Boot.stampMatches(header), 'a fresh header matches the live data');
        // The source gaps read data/Bots/hunt/sources.json, an input of no snapshot: no preset's stamp of one run holds it, whatever the order.
        const two = childProcess.spawnSync(process.execPath, ['scripts/economy-model/inputs.js', '--preset', 'x10,x50', '--out', path.join(scratch, 'two')], { cwd: Boot.root, encoding: 'utf8', maxBuffer: 1 << 28 });
        assert.equal(two.status, 0, two.stderr);
        const stamps = fs.readdirSync(path.join(scratch, 'two')).map(name => JSON.parse(fs.readFileSync(path.join(scratch, 'two', name), 'utf8')).header.sourceFiles);
        assert.equal(stamps.length, 2);
        for (const files of stamps) assert.ok(!files.includes('data/Bots/hunt/sources.json'), 'no stamp of the run holds the source gaps\' file');
        // Another fingerprint, or no list of source files: refused with the build command.
        const odd = (name, change) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, JSON.stringify({ header: { preset: 'x50', ...Boot.dataStamp(loaded), sourceFiles: loaded, ...change } }));
            return file;
        };
        const buildX50 = /build one: node scripts\/economy-model\/inputs\.js --preset x50/;
        odd('inputs-x50-c.json', { fingerprint: 'another' });
        assert.throws(() => Load.loadSnapshot(dir, 'x50'), buildX50, 'a header with another fingerprint: refused');
        fs.rmSync(path.join(dir, 'inputs-x50-c.json'));
        odd('inputs-x50-d.json', { sourceFiles: undefined });
        assert.throws(() => Load.loadSnapshot(dir, 'x50'), buildX50, 'a header with no sourceFiles: refused');
        fs.rmSync(path.join(dir, 'inputs-x50-d.json'));
        // The stale one is the newest file and first by name.
        const stale = write('inputs-x50-a.json', new Date(2026, 0, 2));
        fs.appendFileSync(fares, '\n// a fare edited\n');
        const live = write('inputs-x50-b.json', new Date(2026, 0, 1));
        assert.equal(Load.loadSnapshot(dir, 'x50').file, live, 'the snapshot whose stamp is the live one, not the newest file');
        fs.rmSync(live);
        const build = /build one: node scripts\/economy-model\/inputs\.js --preset x50/;
        assert.throws(() => Load.loadSnapshot(dir, 'x50'), build, 'no snapshot of the live data: refused');
        assert.throws(() => Load.loadSnapshot(dir, 'x50', stale), build, 'a stale snapshot named on the command line: refused');
        const baseline = path.join(scratch, 'baseline.json');
        fs.writeFileSync(baseline, '{}');
        const node = args => childProcess.spawnSync(process.execPath, args, { cwd: Boot.root, encoding: 'utf8' });
        for (const mode of ['today', 'plain']) {
            const run = node(['scripts/economy-model/run.js', '--preset', 'x50', '--mode', mode, '--snapshot', stale, '--fit', baseline, '--cohort', baseline]);
            assert.ok(run.status !== 0 && build.test(run.stderr), `${mode} mode refuses the stale snapshot: ${run.stderr.split('\n').find(text => /Error/.test(text))}`);
        }
        const compare = node(['scripts/economy-model/compare.js', '--preset', 'x50', '--baseline', baseline, '--snapshot', stale]);
        assert.ok(compare.status !== 0 && build.test(compare.stderr), `compare refuses the stale snapshot: ${compare.stderr.split('\n').find(text => /Error/.test(text))}`);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

// The snapshot names every fallback it took: the spots with no no-grade
// market near their centre (they get the C town).
const Policy = invoke('GameServer/Bot/Economy/MarketTownPolicy'), centreAt = cards.spotFields.indexOf('center');
const unmarketed = cards.spots.filter(row => !Policy.nearestNoGradeMarket({ locX: row[centreAt][0], locY: row[centreAt][1] })).map(row => String(row[0]));
assert.deepEqual(snapshot.fallbacks.noMarketToC, unmarketed, 'every spot with no no-grade market is named');
for (const id of unmarketed) assert.equal(snapshot.tradeTowns.none[id], snapshot.tradeTowns.higher, `spot ${id} falls back to the C town`);
console.log(`  fallbacks: no no-grade market ${unmarketed.length} spots`);

// The real cards take no fallback today, so it is taken here: the first
// card's centre has no market. The snapshot names exactly those spots, and
// they get the C town.
const noMarketCentre = cards.spots[0][centreAt], sharing = cards.spots.filter(row => row[centreAt][0] === noMarketCentre[0] && row[centreAt][1] === noMarketCentre[1]).map(row => String(row[0]));
const nearestMarket = Policy.nearestNoGradeMarket;
let taken;
try {
    Policy.nearestNoGradeMarket = spot => (spot.locX === noMarketCentre[0] && spot.locY === noMarketCentre[1] ? null : nearestMarket(spot));
    taken = Inputs.extract({ preset: 'x50', lines: [line, '2', caster], levels: [level, level] });
} finally {
    Policy.nearestNoGradeMarket = nearestMarket;
}
assert.deepEqual(taken.fallbacks.noMarketToC, sharing, 'the spots whose centre has no no-grade market are named');
for (const id of sharing) assert.equal(taken.tradeTowns.none[id], taken.tradeTowns.higher, `spot ${id} gets the C town`);
console.log(`  fallbacks taken: no market ${sharing.join(' ')}`);

// A death takes no exp at levels 1-4 (the game's rule for a character with Lucky, which every class learns at level 1), then the rule's percent of the level.
assert.deepEqual(snapshot.deathExp.slice(0, 4), [0, 0, 0, 0], 'levels 1-4 lose no exp');
assert.ok(snapshot.deathExp[4] > 0, 'level 5 loses exp');

// Paired with the model's hunting table (--hunt): the header names its file, stamp and range; each table species has
// its own per-kill yields at the preset for a killer of the level (the gremlin alone at the gremlin spot), and every
// table spot of a level has its spot yields and town there, though the game's spot table has no row for the line.
{
    const fields = ['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull'], cell = [41.5, 0.048, 11.9, 51.5, 22.5, 0.84, 29, 0, 0.17, 1];
    const file = { stamp: 'abc', range: [1, 1], fields, forms: ['bare', 'shots'], bodies: { '49|1|7/54': { classId: 49, runSpd: 121, reach: 40, point: { attack: 7, defence: 54 } } },
        spots: { '-12_43': { area: 488157, density: 10, species: { 5198: { level: 1, count: 10, production: 2400 } } } }, cells: { '49|1|7/54': { '-12_43': { 5198: [cell, cell] } } } };
    const paired = Inputs.extract({ preset: 'x50', lines: ['51'], levels: [1, 1], hunt: { name: 'hunt-1-1-abc.json', file } });
    assert.deepEqual(paired.header.huntTable, { name: 'hunt-1-1-abc.json', stamp: 'abc', range: [1, 1], spots: ['-12_43'] });
    assert.equal(paired.hours[51][1].best, null, 'the game\'s spot table has no row for the orc mystic at level 1');
    const gremlin = paired.yields['-12_43@1'];
    assert.ok(gremlin && gremlin.town, 'the table spot has its yields and town at the level');
    assert.deepEqual(Object.keys(paired.speciesYields), ['5198@1@0']);
    // The spot holds the gremlin alone: the species' yields are the spot's.
    assert.deepEqual(paired.speciesYields['5198@1@0'], { drop: gremlin.drop, spoil: gremlin.spoil });
    assert.ok(gremlin.drop[57] > 0, 'a gremlin drops adena');
    assert.equal(snapshot.header.huntTable, undefined, 'a snapshot built without --hunt pairs with no table');
}

console.log('PASS economy model inputs snapshot');
