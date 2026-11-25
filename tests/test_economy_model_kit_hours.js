'use strict';
// The economy model's kit hour is the game's own hunt hour of the kit: a body
// wearing it, its cold profile, the hunt cycle's readers on that body at the
// gear ladder's spots, read without a World or a database. It states the
// hour firing no shots and, per kind of shot the worn weapon fires, the hour
// gross of shots and the shots fired an hour at that weapon's own count per
// action, and for a bow the arrows each option spends an hour; a decision
// prices the shots.
const assert = require('node:assert/strict');
const os = require('os');

process.chdir(os.tmpdir());
const Boot = require('../scripts/economy-model/boot');
const KitHours = require('../scripts/economy-model/kit-hours');
Boot.boot('x50');

const Table = invoke('GameServer/Bot/AI/SpotValueTable'), HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile'), BotGear = invoke('GameServer/Bot/AI/BotGear');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation'), Data = invoke('GameServer/DataCache');
const ShotStock = invoke('GameServer/Inventory/ShotStock'), Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const Grades = require('../src/GameServer/Bot/AI/GearGradeRule');
const Load = require('../scripts/economy-model/load');

const SSNG = 1835, SSD = 1463, SSC = 1464, SSB = 1465, SPSD = 2510, SPSC = 2511, BSPSD = 3948, BSPSC = 3949;
// The anchor the cells are chosen at: a shot's cost from its inputs at NPC prices.
const anchor = { [SSNG]: 8, [SSD]: 7.4, [SSC]: 11.8, [SSB]: 43, [SPSD]: 16.45, [SPSC]: 29.5, [BSPSD]: 41.7, [BSPSC]: 81 };
// What the best option of an hour nets an hour: firing none, or a kind of shot at its price (the kits read
// here fire no arrows).
const best = (hour, priceOf) => Math.max(hour.none, ...hour.shots.map(shot => shot.gross - shot.units * priceOf(shot.id)));
// Bands of the gear ladder (five levels or fewer, read at the middle): D at 25-29, 30-34 and 35-39, C at 45-49, B at 57-60.
const band = (line, from, to, scale, caster) => ({ from, to, level: Math.floor((from + to) / 2), grade: Grades.gradeForLevel(from), scale, caster,
    best: String(Table.best(line, Math.floor((from + to) / 2), true, 'income')?.spotId) });
const bandsOf = (line, caster, scale = null) => [band(line, 25, 29, scale ?? 0.46, caster), band(line, 30, 34, scale ?? 0.8, caster), band(line, 35, 39, scale ?? 1, caster),
    band(line, 45, 49, scale ?? 1.3, caster), band(line, 57, 60, scale ?? 1.1, caster)];
const fighter = '46', mage = '12', archer = '9';
const ladder = scale => ({ [fighter]: bandsOf(fighter, false, scale), [mage]: bandsOf(mage, true, scale), [archer]: bandsOf(archer, false, scale) });
const snapshot = { header: { preset: 'x50' }, gearLadder: { lines: ladder(null) } };
const kitHours = KitHours.gameKitHours({ snapshot, anchor });
const bandAt = (line, level) => snapshot.gearLadder.lines[line].find(row => level >= row.from && level <= row.to);

// The kit hours read no World and no database.
const kitOf = (line, level) => {
    const classId = Table.roleClass(line, level);
    return Object.fromEntries(BotGear.planFor({ classId, level, characterId: HuntCycle.referenceId(classId, Number(line)) }).items.map(row => [row.slot, row.selfId]));
};
const firstKit = kitOf(fighter, 32);
assert.ok(kitHours.hour(fighter, 32, firstKit).shots[0].gross > 0, 'a fighter\'s own kit earns');
const loaded = Object.keys(require.cache);
assert.ok(!loaded.some(file => /[\\/]World[\\/]World\.js$/.test(file)), 'no World module');
assert.deepEqual(loaded.filter(file => /[\\/]Database[\\/]/.test(file)), [], 'no database module');

const etc = selfId => Index.find(Data.items, selfId).etc;
const weaponOf = kit => Number(kit[7] || kit[14]) || 0;
// The game's own pass, decomposed: a reference bot wearing the kit (firing
// kind: 'none', or the kind its earning answer names), its whole cold
// profile, fresh readers on that body at the best and the ranked spots; per
// cell the reader's hour with its shot bill (the row's shots at the reader's
// price) given back, and the shots at the worn weapon's count per action
// over the count of the table's reference weapon at the level it hunted the
// spot at (item data). The cell taken nets most at price.
function gamePass(line, row, kit, kind, price) {
    Pricing.useBoard(() => null);
    const classId = Table.roleClass(line, row.level), base = HuntCycle.referenceState(classId, row.level, { line: Number(line) }), inventory = {};
    for (const [slot, selfId] of KitHours.wornKit(kit)) {
        const key = `kit-${selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId, amount, equipped: true, equippedCount: amount, equippedSlots: [...(prior?.equippedSlots || []), slot], slot };
    }
    let state = { ...base, inventory, stats: { ...base.stats, exp: Data.experience[row.level - 1] } };
    const best = Table.best(line, row.level, true, 'income');
    const deathHours = Valuation.deathHours(state, { expPerHour: best.exp || 0, walkBackHours: Load.walkBackHours(best.spotId, state) });
    if (kind === 'spiritshot' || kind === 'blessedSpiritshot') state = { ...state, stats: { ...state.stats, earning: { shotKind: kind } } };
    const numbers = KitHours.referenceNumbers(Profile.profileFor(state, 0, { store: false })), plan = ShotStock.planForState(state);
    const shots = ShotStock.shotRows(plan, kind === 'none' ? false : undefined), role = Table.roleFor(state), options = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
    const field = plan.kind === 'soulshot' ? 'soulshot' : 'spiritshot', charge = kind === 'none' ? 0 : Number(etc(weaponOf(kit))[field]) || 0;
    const costs = Hunt.consumablePrices(state), seen = new Set();
    let out = null;
    for (const spotId of [String(best.spotId), ...Table.rankedIncome(line, row.level).slice(0, 10).map(spot => String(spot.spotId))]) {
        if (seen.has(spotId)) continue;
        const reader = HuntCycle.reader(state, { deathHours, hunt: kind === 'none' ? { spotId, useShots: false } : { spotId } });
        reader.spotIds.forEach((id, index) => {
            if (seen.has(String(id))) return;
            seen.add(String(id));
            const one = reader.hourAt(numbers, index), cycle = Table.cycle(id, role, row.level, shots, options), perKill = shots ? cycle.shots : 0;
            const refLevel = perKill > 0 ? Table.referenceLevel(id, role, shots) : null, refWeapon = refLevel ? weaponOf(kitOf(line, refLevel)) : 0;
            const refCharge = refWeapon ? Number(etc(refWeapon)[field]) || 0 : 0, raw = one.kills * one.share * perKill;
            const gross = (one.income + raw * costs.shots) * row.scale, units = refCharge > 0 ? raw / refCharge * charge : 0;
            if (!out || gross - units * price > out.net) out = { spotId: String(id), gross, units, raw, refWeapon, refCharge, charge, income: one.income * row.scale, net: gross - units * price, id: plan.selfId, kills: one.kills, fight: one.fight, kph: cycle.kph, share: one.share };
        });
    }
    return out;
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} against ${expected}`);

// (1) Three lines in two bands, each in the band's reference kit: the hour
// firing none is the game's shotless hour (its readers on the rows without
// shots), and per kind the hour gross of shots less its shots at the anchor
// price is the game's decomposed pass at that price, at the same cell.
for (const line of [fighter, mage, archer]) for (const level of [32, 47]) {
    const row = bandAt(line, level), kit = kitOf(line, row.level), hour = kitHours.hour(line, level, kit);
    const bare = gamePass(line, row, kit, 'none', 0);
    near(hour.none, bare.gross, `line ${line} at ${level}: the shotless hour`);
    near(hour.noneShare.killShare, bare.kills / bare.kph, `line ${line} at ${level}: the shotless hour's kill share`);
    near(hour.noneShare.shotShare, bare.kills * bare.share / bare.kph, `line ${line} at ${level}: the shotless hour's shot share`);
    assert.deepEqual(hour.shots.map(shot => shot.kind), line === mage ? ['spiritshot', 'blessedSpiritshot'] : ['soulshot'], `line ${line}: the kinds its weapon fires`);
    for (const shot of hour.shots) {
        const game = gamePass(line, row, kit, shot.kind, anchor[shot.id]);
        assert.equal(shot.id, game.id, `line ${line} at ${level}: the ${shot.kind} of its weapon's grade`);
        near(shot.gross - shot.units * anchor[shot.id], game.net, `line ${line} at ${level}, ${shot.kind}: net at the anchor`);
        near(shot.units, game.units, `line ${line} at ${level}, ${shot.kind}: shots an hour`);
        near(shot.killShare, game.kills / game.kph, `line ${line} at ${level}, ${shot.kind}: kill share`);
        near(shot.shotShare, game.kills * game.share / game.kph, `line ${line} at ${level}, ${shot.kind}: shot share`);
    }
}
// A cell whose table row states no kills an hour (a cycle without kph)
// states no kill or shot share (null, never a share over 0); its hour is the
// same. The game's reader is built on the table as it is.
{
    const cycle = Table.cycle, reader = HuntCycle.reader;
    let building = false;
    HuntCycle.reader = (...args) => { building = true; try { return reader(...args); } finally { building = false; } };
    Table.cycle = (...args) => { const row = cycle(...args); return building || !row ? row : { ...row, kph: 0 }; };
    try {
        const kit = kitOf(fighter, bandAt(fighter, 32).level), hour = KitHours.gameKitHours({ snapshot, anchor }).hour(fighter, 32, kit), known = kitHours.hour(fighter, 32, kit);
        assert.deepEqual(hour.noneShare, { killShare: null, shotShare: null }, 'no kph: the shotless hour states no shares');
        assert.deepEqual(hour.shots.map(shot => [shot.killShare, shot.shotShare]), [[null, null]], 'no kph: the soulshot states no shares');
        near(hour.none, known.none, 'the shotless hour as with kph');
        near(hour.shots[0].gross, known.shots[0].gross, 'the soulshot hour as with kph');
    } finally {
        Table.cycle = cycle;
        HuntCycle.reader = reader;
    }
}

// Where the worn weapon fires the table's reference count, the kind the game
// fires, priced as the game's reader prices it (its shot price, times the
// band's scale), nets the game's own hour (a scale of 1 and the game's
// prices as the anchor: the same cell).
{
    const price = id => { Pricing.useBoard(() => null); return Pricing.botBuyPrice(id); }, unit = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: ladder(1) } },
        anchor: Object.fromEntries([SSD, SSC, SPSD, SPSC, BSPSD, BSPSC].map(id => [id, price(id)])) });
    for (const [line, level] of [[fighter, 32], [fighter, 47], [mage, 32]]) {
        const row = band(...[line, bandAt(line, level).from, bandAt(line, level).to, 1, line === mage]), kit = kitOf(line, row.level);
        const own = ShotStock.planForState({ ...HuntCycle.referenceState(Table.roleClass(line, row.level), row.level, { line: Number(line) }), inventory: Object.fromEntries(KitHours.wornKit(kit).map(([slot, selfId]) => [`kit-${selfId}`, { selfId, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [slot], slot }])) });
        const game = gamePass(line, row, kit, own.kind, price(own.selfId)), shot = unit.hour(line, level, kit).shots.find(entry => entry.id === own.selfId);
        assert.equal(game.charge, game.refCharge, `line ${line} at ${level}: the reference count`);
        near(shot.gross - shot.units * price(own.selfId), game.income, `line ${line} at ${level}: the game's own hour`);
    }
}

// (2) A C two-handed sword (Flamberge, 2 soulshots a shot) in the B band at
// 57-60 over the band's B kit, whose table hunted at B levels with a B sword
// (1 a shot): its shots an hour are its own count, twice what the reader's
// row counts at the cell.
{
    const row = bandAt(fighter, 58), bKit = kitOf(fighter, row.level), flamberge = Number(kitOf(fighter, 47)[14]), cKit = { ...bKit, 7: 0, 14: flamberge };
    const shot = kitHours.hour(fighter, 58, cKit).shots[0], game = gamePass(fighter, row, cKit, 'soulshot', anchor[SSC]), gradeOf = invoke('GameServer/Items/C4EnchantRules').gradeOf;
    assert.deepEqual([gradeOf(etc(flamberge)), etc(flamberge).soulshot, gradeOf(etc(game.refWeapon)), game.refCharge], ['C', 2, 'B', 1],
        'Flamberge fires 2 a shot, the table\'s B sword 1');
    assert.equal(shot.id, SSC, 'a C weapon fires C soulshots');
    near(shot.units, 2 * game.raw, 'its shots an hour: twice the row\'s');
    near(shot.gross - shot.units * anchor[SSC], game.net, 'net at the anchor');
    assert.equal(kitHours.shotScale(fighter, 58, game.spotId, flamberge), 2, 'and at that spot row');
}

// (2b) The hour against game owners the service does not compute with.
// A reference bot of the row's level wearing the kit, as the game states it.
const stateIn = (line, row, kit) => {
    const classId = Table.roleClass(line, row.level), base = HuntCycle.referenceState(classId, row.level, { line: Number(line) }), inventory = {};
    for (const [slot, selfId] of KitHours.wornKit(kit)) {
        const key = `kit-${selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId, amount, equipped: true, equippedCount: amount, equippedSlots: [...(prior?.equippedSlots || []), slot], slot };
    }
    return { ...base, inventory, stats: { ...base.stats, exp: Data.experience[row.level - 1] } };
};
// The shots a cold bot in the kit spends per action: what a fight debits from
// its stock at each charge (ColdCombatProfile.shotSupply, read by
// BackgroundResolver.spendColdShot), its bag holding plenty of the shot.
const spentPerAction = (line, row, kit) => {
    const state = stateIn(line, row, kit), plan = ShotStock.combatPlanForState(state);
    return Profile.shotSupply({ ...state, inventory: { ...state.inventory, [String(plan.selfId)]: { selfId: plan.selfId, amount: 100000 } } }, 1e9).perAction;
};
const within = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} against ${expected}`);

// (a) At a line's reference kit the shots an hour of a cell are the spot
// table's row for that spot (the row's shots, at the reference weapon's
// count, which the reference kit wears): the units the service states for
// each plain shot match the table's shots of one spot of the line's ranking.
// (A Blessed Spiritshot row is counted at its own reference weapon: not
// compared here.)
for (const line of [fighter, mage, archer]) for (const level of [32, 47]) {
    const row = bandAt(line, level), kit = kitOf(line, row.level), hour = kitHours.hour(line, level, kit), state = stateIn(line, row, kit);
    const role = Table.roleFor(state), options = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
    const spots = [String(Table.best(line, row.level, true, 'income').spotId), ...Table.rankedIncome(line, row.level).slice(0, KitHours.TOP_SPOTS).map(spot => String(spot.spotId))];
    for (const shot of hour.shots.filter(entry => entry.kind !== 'blessedSpiritshot')) {
        const rows = spots.map(spotId => Table.value(spotId, role, row.level, true, options)?.shots).filter(Number.isFinite);
        const miss = Math.min(...rows.map(value => Math.abs(shot.units - value) / Math.max(1, value)));
        assert.ok(miss <= 1e-9, `line ${line} at ${level}, ${shot.kind}: ${shot.units} shots an hour, the table's rows ${rows.join(', ')}`);
    }
}

// (b) A reference kit's net hour at the game's own prices and scale 1 is the
// hunt cycle's reader's hour of the reference state (the spot a reader hunts
// is its hunt's: HuntCycle.reader, hourAt), the best of the line's ranked
// spots. Where the worn weapon fires the count the table's reference weapons
// did at every spot, the two are equal; where it fires another count at
// some, the service charges the worn weapon's own count (as a fight spends
// it): it equals the reader's best hour with each row's shots at that count.
{
    const price = id => { Pricing.useBoard(() => null); return Pricing.botBuyPrice(id); }, unit = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: ladder(1) } },
        anchor: Object.fromEntries([SSD, SSC, SPSD, SPSC, BSPSD, BSPSC].map(id => [id, price(id)])) });
    let exact = 0;
    for (const [line, level] of [[fighter, 32], [fighter, 47], [mage, 32], [mage, 47], [archer, 32], [archer, 47]]) {
        Pricing.useBoard(() => null);
        const row = bandAt(line, level), kit = kitOf(line, row.level), state = stateIn(line, row, kit), own = ShotStock.planForState(state), best = Table.best(line, row.level, true, 'income');
        const deathHours = Valuation.deathHours(state, { expPerHour: best.exp || 0, walkBackHours: Load.walkBackHours(best.spotId, state) });
        const numbers = KitHours.referenceNumbers(Profile.profileFor(state, 0, { store: false }));
        const spots = [String(best.spotId), ...Table.rankedIncome(line, row.level).slice(0, KitHours.TOP_SPOTS).map(spot => String(spot.spotId))];
        const shot = unit.hour(line, level, kit).shots.find(entry => entry.id === own.selfId), net = shot.gross - shot.units * price(own.selfId);
        const role = Table.roleFor(state), shotRows = ShotStock.shotRows(own), count = spentPerAction(line, row, kit), options = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
        // Per spot: the reader's hour, and that hour with the row's shots
        // charged at the worn weapon's count over the row's reference weapon's.
        let game = { income: -Infinity }, charged = -Infinity, same = true;
        // The hunt reads every cell of each listed spot's reader (kit-hours'
        // referenceHunt), so the best hour ranges over those cells, not only the listed spots.
        const cells = new Map();
        for (const listed of spots) {
            const reader = HuntCycle.reader(state, { deathHours, hunt: { spotId: listed } });
            reader.spotIds.forEach((id, index) => { if (!cells.has(String(id))) cells.set(String(id), { reader, index }); });
        }
        for (const [spotId, { reader, index }] of cells) {
            const income = reader.hourAt(numbers, index).income;
            if (income > game.income) game = { income, spotId };
            const refLevel = Table.referenceLevel(spotId, role, shotRows), refCount = refLevel ? spentPerAction(line, row, kitOf(line, refLevel)) : count;
            if (refCount !== count) same = false;
            charged = Math.max(charged, income + (Table.value(spotId, role, row.level, true, options)?.shots || 0) * price(own.selfId) * (1 - count / refCount));
        }
        if (same) { exact++; within(net, game.income, 1e-9, `line ${line} at ${level}: the reader's best hour (spot ${game.spotId})`); }
        else within(net, charged, 1e-9, `line ${line} at ${level}: the worn weapon fires ${count} a shot: the reader's best hour with each row's shots at that count (the reader's own best ${game.income})`);
    }
    // Over every cell of the reader a kit more often fires another count at some, so fewer cases are exact.
    assert.ok(exact >= 2, `the reader's hour is met exactly on ${exact} of the six cases`);
    // A shot the anchor has no price for is no option of the hour.
    const unpriced = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: ladder(1) } }, anchor: {} });
    assert.deepEqual(unpriced.hour(fighter, 32, kitOf(fighter, bandAt(fighter, 32).level)).shots, [], 'no price at the anchor: the kit states no shot');
}

// (c) A weapon that fires more than one shot an action (Flamberge, 2; the
// table's B sword, 1) in the B band: the shots the service states an hour per
// shot the hunt's rows count (the kills' shots at a cell: the reader's kills
// and the table's shots per kill) are the ratio of the count a fight spends
// per action with that weapon over the count with the table's reference weapon.
{
    const row = bandAt(fighter, 58), bKit = kitOf(fighter, row.level), flamberge = Number(kitOf(fighter, 47)[14]), cKit = { ...bKit, 7: 0, 14: flamberge };
    const counts = [spentPerAction(fighter, row, bKit), spentPerAction(fighter, row, cKit)];
    assert.deepEqual(counts, [1, 2], 'a fight spends one a shot with the B sword and two with Flamberge');
    const perRow = kit => {
        const game = gamePass(fighter, row, kit, 'soulshot', anchor[SSC]), hour = kitHours.hour(fighter, 58, kit).shots[0];
        const refKit = { ...kitOf(fighter, Table.referenceLevel(game.spotId, Table.roleFor(stateIn(fighter, row, kit)), true)) };
        return hour.units / game.raw / (spentPerAction(fighter, row, kit) / spentPerAction(fighter, row, refKit));
    };
    within(perRow(bKit), 1, 1e-9, 'with the B sword: the units over the rows\' shots at the count ratio');
    within(perRow(cKit), 1, 1e-9, 'with Flamberge: the units over the rows\' shots at the count ratio');
}

// (2c) A bow spends one arrow per attack, of its grade (Actor/BowResources):
// a bow kit's hour states the arrows of each option, against game owners
// the service does not compute with: the arrow ArrowStock names for the
// state's equipped bow, and the count a fight spends per action
// (ColdCombatProfile.shotSupply).
{
    const ArrowStock = require('../src/GameServer/Inventory/ArrowStock');
    const row = band(archer, 52, 52, 1, false), arch = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: { [archer]: [row] } } }, anchor });
    const kit = kitOf(archer, 52), bow = weaponOf(kit), hour = arch.hour(archer, 52, kit), shot = hour.shots.find(entry => entry.kind === 'soulshot');
    const arrowOf = worn => ArrowStock.currentId(stateIn(archer, row, worn));
    // (a) The soulshot option: one arrow per shot action, its shots an hour
    // over the count a fight spends per action with that bow.
    const count = spentPerAction(archer, row, kit);
    assert.ok(count > 1, `the archer's bow at 52 fires ${count} soulshots an action`);
    assert.equal(shot.arrows.id, arrowOf(kit), 'the arrow of the bow\'s grade');
    within(shot.arrows.units, shot.units / count, 1e-9, 'arrows an hour: the shots over the count per action');
    // (b) A sword spends no arrows: its hour states none.
    const sword = kitHours.hour(fighter, 47, kitOf(fighter, 47));
    assert.ok(!('noneArrows' in sword) && sword.shots.length && sword.shots.every(entry => !('arrows' in entry)), 'a sword kit states no arrows');
    // (c) A bow of another grade (the archer's C bow of 47) spends its own arrow;
    // the piece put on states the same hour as the kit worn with it.
    const cBow = weaponOf(kitOf(archer, 47)), slot = kit[7] ? 7 : 14, cKit = { ...kit, [slot]: cBow }, cHour = arch.hour(archer, 52, cKit);
    assert.notEqual(arrowOf(cKit), arrowOf(kit), 'a C bow and a B bow spend different arrows');
    assert.ok(cHour.shots.length && cHour.shots.every(entry => entry.arrows.id === arrowOf(cKit)) && cHour.noneArrows.id === arrowOf(cKit), 'the C bow\'s arrows');
    assert.deepEqual(arch.swaps(archer, 52, kit, [{ slot, selfId: cBow }]).swaps[0].hour, cHour, 'the C bow put on');
    assert.notEqual(bow, cBow, 'another bow');
    // (d) The hour firing none: its kills' fight seconds at the attack rate
    // of the spot's row firing soulshots (that row's shots per kill over the
    // count the table's reference bow spent per action, over its fight
    // seconds), at the cell the game's shotless pass takes.
    const game = gamePass(archer, row, kit, 'none', 0), role = Table.roleFor(stateIn(archer, row, kit)), options = { spoilSkillLevel: Rewards.spoilSkillLevel(stateIn(archer, row, kit)) };
    const fired = Table.cycle(game.spotId, role, row.level, true, options), refCount = spentPerAction(archer, row, kitOf(archer, Table.referenceLevel(game.spotId, role, true)));
    near(hour.none, game.gross, 'the shotless hour');
    assert.equal(hour.noneArrows.id, arrowOf(kit), 'the shotless hour\'s arrow');
    within(hour.noneArrows.units, game.kills * game.fight * fired.shots / refCount / fired.fight, 1e-9, `the shotless hour's arrows at spot ${game.spotId}`);
}


// (3) A level-27 fighter: its D two-handed sword firing D soulshots against
// its no-grade weapon firing no-grade soulshots (8 a shot). At 7.4 a D shot
// (its inputs) the D weapon nets more; at 500 (the game's x50 price) firing D
// shots nets less, and the main fires none with it then.
{
    const dKit = kitOf(fighter, 27), plain = kitOf(fighter, 19), hand = kit => (kit[14] ? 14 : 7), ngKit = { ...dKit, 7: 0, 14: 0, [hand(plain)]: plain[hand(plain)] };
    const d = kitHours.hour(fighter, 27, dKit), ng = kitHours.hour(fighter, 27, ngKit);
    assert.deepEqual([d.shots[0].id, ng.shots[0].id], [SSD, SSNG], 'D and no-grade soulshots');
    const ngShots = ng.shots[0].gross - ng.shots[0].units * 8, ngNet = best(ng, () => 8), dShots = price => d.shots[0].gross - d.shots[0].units * price;
    assert.ok(ngShots > ng.none && ngNet === ngShots, 'the no-grade weapon fires its shots');
    assert.ok(dShots(7.4) > ngNet, `at 7.4: ${dShots(7.4)} against ${ngNet}`);
    assert.ok(dShots(500) < ngNet, `at 500: ${dShots(500)} against ${ngNet}`);
    assert.ok(d.none > dShots(500), 'at 500 it fires none');
}

// (4) A caster (line 12 at 47 in its Paradia staff): the hunt's count of each
// kind of shot is the hour's.
{
    const hour = kitHours.hour(mage, 47, kitOf(mage, 47));
    // The hunt's count of each kind is the hour's: at the kind's cell the
    // row's shots times the weapon's scale (the blessed row's own reference
    // count for Blessed Spiritshots) are the units the hour states.
    const row = bandAt(mage, 47), kit = kitOf(mage, row.level), weapon = weaponOf(kit);
    for (const shot of hour.shots) {
        const game = gamePass(mage, row, kit, shot.kind, anchor[shot.id]);
        near(game.raw * kitHours.shotScale(mage, 47, game.spotId, weapon, shot.kind === 'blessedSpiritshot'), shot.units, `${shot.kind}: the hunt's count at the cell`);
    }
}

// (5) A kit's hour carries no shot price: the worn hour of a swap read is the
// hour read alone.
{
    const read = kitHours.swaps(fighter, 47, kitOf(fighter, 47), [{ slot: 6, selfId: kitOf(fighter, 44)[6] }]);
    assert.deepEqual(kitHours.hour(fighter, 47, kitOf(fighter, 47)), read.hour, 'the same hour');
}

// (6) A main of line 46 at 46 in the kit of 39 still earns.
const late = kitOf(fighter, 39);
assert.ok(kitHours.hour(fighter, 46, late).none > 0, 'the kit of 39 at 46 earns');

// (7) A full armour takes off chest and legs; a two-handed weapon the shield.
const reference = kitOf(fighter, 47), fullPlate = 356, shield = 625;
assert.equal(Number(reference[14]) > 0, true, 'the fighter\'s kit of 47 holds a two-handed weapon');
const { 10: chest, 11: legs, ...bare } = reference;
assert.ok(chest && legs, 'and a chest and legs');
assert.deepEqual(kitHours.hour(fighter, 47, { ...reference, 15: fullPlate }), kitHours.hour(fighter, 47, { ...bare, 15: fullPlate }), 'chest and legs under a full armour');
assert.deepEqual(kitHours.hour(fighter, 47, { ...reference, 8: shield }), kitHours.hour(fighter, 47, reference), 'a shield beside a two-handed weapon');
// Bare hands fire no shots.
assert.deepEqual(kitHours.hour(fighter, 47, { ...reference, 14: 0 }).shots, [], 'no weapon, no shots');

// (8) swaps reads the kit with each piece put on as hour() reads that kit:
// another weapon (the shield comes off under a two-handed one), a chest of
// another armour kind, a helmet into an empty slot (valued against the kit
// without one), an earring into the second ear, and the piece already worn.
const mixed = { ...kitOf(fighter, 44), 6: 0 }, pieces = [{ slot: 7, selfId: kitOf(fighter, 19)[7] }, { slot: 8, selfId: kitOf(fighter, 19)[8] },
    { slot: 10, selfId: kitOf(mage, 44)[10] }, { slot: 6, selfId: kitOf(fighter, 47)[6] }, { slot: 2, selfId: kitOf(fighter, 19)[1] }, { slot: 14, selfId: mixed[14] }];
const read = kitHours.swaps(fighter, 46, mixed, pieces);
assert.deepEqual(read.hour, kitHours.hour(fighter, 46, mixed), 'the worn kit');
pieces.forEach(({ slot, selfId }, at) => {
    const next = Object.fromEntries([...KitHours.wornKit(mixed).filter(([worn]) => !KitHours.slotsConflict(slot, worn)), [slot, selfId]]);
    assert.deepEqual(read.swaps[at].hour, kitHours.hour(fighter, 46, next), `${selfId} in slot ${slot}`);
});
assert.equal(read.swaps[5].hour, read.hour, 'the piece worn: the worn kit\'s hour');

// (9) A level-30 fighter in a no-grade weapon and shield and D armour values
// the D two-handed sword by what it adds to that kit, not to the grade's
// entry kit (all no-grade), each firing what nets most at the anchor prices.
{
    const entry = kitOf(fighter, 19), dKit = kitOf(fighter, 30), worn = { ...dKit, 14: 0, 7: entry[7], 8: entry[8] }, sword = [{ slot: 14, selfId: dKit[14] }];
    const net = hour => best(hour, id => anchor[id]);
    const gain = kit => { const out = kitHours.swaps(fighter, 30, kit, sword); return net(out.swaps[0].hour) - net(out.hour); };
    const own = gain(worn), atEntry = gain(entry);
    assert.ok(own > 0 && atEntry > 0 && Math.abs(own - atEntry) > 0.03 * atEntry, `over its kit ${own}, over the entry kit ${atEntry}`);
}

// (10) A robe wearer at 39 (the Knowledge robes of its kit) loses its hour
// to a heavy breastplate: its robe passives end with the robe, though the
// plate's P.Def alone would suggest a gain.
{
    const robes = kitOf(mage, 39), read = kitHours.swaps(mage, 39, robes, [{ slot: 10, selfId: 58 }]), priceOf = id => anchor[id];
    const gain = best(read.swaps[0].hour, priceOf) - best(read.hour, priceOf);
    assert.ok(gain < 0, `the plate on robes: ${gain} an hour`);
}

// (11) A piece above the band's grade: no hour stated, alone or put on.
assert.equal(kitHours.hour(fighter, 32, { ...firstKit, 15: fullPlate }), null, 'a C full armour in the D band');
assert.equal(kitHours.hour(fighter, 32, { ...firstKit, 9: 999999 }), null, 'an item without a template');
assert.equal(kitHours.swaps(fighter, 32, firstKit, [{ slot: 15, selfId: fullPlate }]).swaps[0].hour, null, 'put on over a D kit');
assert.deepEqual(kitHours.swaps(fighter, 32, { ...firstKit, 15: fullPlate }, [{ slot: 6, selfId: firstKit[6] }]).swaps.map(swap => swap.hour), [null], 'over a kit not stated');

// The worn kit's hunt over the reference kit's per form, by kind of shot: a
// lower-grade weapon fires another id of the same kind; a form either hour
// does not state the shares of has no factor.
{
    const share = (killShare, shotShare) => ({ killShare, shotShare });
    const worn = { none: 1, noneShare: share(0.4, 0.3), shots: [{ id: 2509, kind: 'spiritshot', ...share(0.5, 0.6) }, { id: 3947, kind: 'blessedSpiritshot', ...share(0.9, 0.9) }] };
    const reference = { none: 1, noneShare: share(0.8, 0.6), shots: [{ id: 2510, kind: 'spiritshot', ...share(1, 1.2) }, { id: 3948, kind: 'blessedSpiritshot', ...share(null, null) }] };
    assert.deepEqual(KitHours.huntFactors(worn, reference), { bare: { kills: 0.5, shots: 0.5 }, shots: { kills: 0.5, shots: 0.5 }, blessed: null },
        'each form the worn share over the reference\'s, matched by kind; the reference states no blessed shares: none');
    assert.deepEqual(KitHours.huntFactors(null, reference), { bare: null, shots: null, blessed: null }, 'no worn hour: no factor');
    assert.equal(KitHours.huntFactors(worn, { ...reference, noneShare: share(0, 0) }).bare, null, 'a reference share of 0: no factor');
}

// (12) The anchor is required.
assert.throws(() => KitHours.gameKitHours({ snapshot }), /anchor .* required/);

// (13) A band's best spot must be the live one.
const wrongBest = { ...snapshot, gearLadder: { lines: { ...snapshot.gearLadder.lines, [fighter]: snapshot.gearLadder.lines[fighter].map(row => ({ ...row, best: '1' })) } } };
assert.throws(() => KitHours.gameKitHours({ snapshot: wrongBest, anchor }).hour(fighter, 32, firstKit), new RegExp(`line ${fighter} band 1 .*best spot 1 in the snapshot`));

// (14) The cell is chosen at the anchor price: at x1 a line 23 body at level 27
// fires fewer shots at a spot that nets more once the shot costs its price.
// Last: it boots x1.
{
    // A line whose cheapest-shot cell is not its best cell at free shots (lines 8 and 46 at 27 once were; its cells move with the table).
    const line = '23', level = 27, x1 = { header: { preset: 'x1' }, gearLadder: { lines: {} } };
    Boot.boot('x1');
    x1.gearLadder.lines[line] = [band(line, 25, 29, 1, false)];
    const classId = Table.roleClass(line, level);
    const kit = Object.fromEntries(BotGear.planFor({ classId, level, characterId: HuntCycle.referenceId(classId, Number(line)) }).items.map(row => [row.slot, row.selfId]));
    const priced = KitHours.gameKitHours({ snapshot: x1, anchor }).hour(line, level, kit).shots[0];
    const free = KitHours.gameKitHours({ snapshot: x1, anchor: Object.fromEntries(Object.keys(anchor).map(id => [id, 0])) }).hour(line, level, kit).shots[0];
    assert.ok(priced.units < free.units && priced.gross < free.gross, 'priced shots choose a cell that fires fewer shots');
}
// A worn kit's hunt at one spot row over the level's reference kit's (spotFactors):
// per form the game's own hunt cycle reader at that row, kills an hour, kills
// times fight share (the shots fired) and kills times deaths, the worn kit's over
// the reference's. A caster's shots form names the plain spiritshot as the model
// does: unnamed, the game picks the blessed one when its store price pays.
const gameRow = (line, level, kit, spotId, form) => {
    Pricing.useBoard(() => null);
    try {
        const classId = Table.roleClass(line, level), base = HuntCycle.referenceState(classId, level, { line: Number(line) }), inventory = {};
        for (const [slot, selfId] of KitHours.wornKit(kit)) {
            const key = `kit-${selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
            inventory[key] = { selfId, amount, equipped: true, equippedCount: amount, equippedSlots: [...(prior?.equippedSlots || []), slot], slot };
        }
        const plain = ShotStock.planForState(base, { blessed: false })?.kind, shotKind = form === 'blessed' ? 'blessedSpiritshot' : form === 'shots' && plain === 'spiritshot' ? plain : null;
        const state = { ...base, inventory, stats: { ...base.stats, exp: Data.experience[level - 1], ...(shotKind ? { earning: { shotKind } } : {}) } };
        const numbers = KitHours.referenceNumbers(Profile.profileFor(state, 0, { store: false }));
        const reader = HuntCycle.reader(state, { deathHours: 0, hourAdena: 1, hunt: form === 'bare' ? { spotId, useShots: false } : { spotId } });
        const one = reader.hourAt(numbers, reader.spotIds.map(String).indexOf(String(spotId)));
        return { kills: one.kills, fired: one.kills * one.share, deaths: one.kills * one.deaths };
    } finally { Pricing.useBoard(null); }
};
const gameFactor = (line, level, kit, spotId, form) => {
    const worn = gameRow(line, level, kit, spotId, form), ref = gameRow(line, level, kitOf(line, level), spotId, form);
    return { kills: worn.kills / ref.kills, shots: worn.fired / ref.fired, deaths: ref.deaths > 0 ? worn.deaths / ref.deaths : 1 };
};
const sameFactor = (actual, expected, message) => { for (const field of ['kills', 'shots', 'deaths']) near(actual[field], expected[field], `${message}: ${field}`); };
// The reference kit reads 1 at every row and form.
for (const [line, level, spotId] of [[fighter, 32, '30_-30:f2'], [mage, 32, '4_25'], [mage, 39, '17_21']]) {
    const spot = kitHours.spotFactors(line, level, kitOf(line, level), spotId);
    for (const form of ['bare', 'shots', 'blessed']) sameFactor(spot[form], { kills: 1, shots: 1, deaths: 1 }, `line ${line} at ${level}: the reference kit's ${form} factor at ${spotId}`);
}
// A stronger kit (a higher rung of the grade) kills more at an uncapped row, as the game's reader reads
// that row; at a capped row (the table's cap at or below the kill rate: the spawns bound the kills)
// the reference's kills are the cap and the stronger kit's the same.
{
    const strong = kitOf(mage, 39), spot = kitHours.spotFactors(mage, 32, strong, '4_25');
    assert.ok(spot.shots.kills > 1.05, `a stronger kit kills more at an uncapped row: ${spot.shots.kills}`);
    for (const form of ['bare', 'shots', 'blessed']) sameFactor(spot[form], gameFactor(mage, 32, strong, '4_25', form), `the stronger kit's ${form} factor`);
    const cycle = Table.cycle;
    try {
        Table.cycle = (...args) => { const row = cycle(...args); return row && { ...row, cap: row.kph * 0.9 }; };
        const capped = KitHours.gameKitHours({ snapshot, anchor }).spotFactors(mage, 32, strong, '4_25');
        for (const form of ['bare', 'shots', 'blessed']) near(capped[form].kills, 1, `the stronger kit's ${form} kills at a capped row`);
    } finally { Table.cycle = cycle; }
}
// A weaker kit's factor differs from row to row (a long fight costs it more), as the game's reader's does.
{
    const weak = { 7: kitOf(mage, 39)[7] ?? kitOf(mage, 39)[14] }, at = ['-8_28', '-6_33'].map(spotId => kitHours.spotFactors(mage, 39, weak, spotId));
    assert.ok(Math.abs(at[0].shots.kills - at[1].shots.kills) > 0.1, `one kit reads different factors at two rows: ${at[0].shots.kills} and ${at[1].shots.kills}`);
    ['-8_28', '-6_33'].forEach((spotId, i) => sameFactor(at[i].shots, gameFactor(mage, 39, weak, spotId, 'shots'), `the weak kit at ${spotId}`));
    // Where the reference dies the weak kit's deaths are the game's load ratio times its kills, not its kills factor
    // (the row is one the reference dies at; 17_21, -7_32 and 16_24 once were, its deaths move with the table).
    const row = Table.cycle('-8_28', Table.roleFor(HuntCycle.referenceState(Table.roleClass(mage, 39), 39, { line: Number(mage) })), 39, true, {});
    assert.ok(row.deaths > 0, 'the reference dies at the row');
    assert.ok(at[0].shots.deaths > at[0].shots.kills * 2, `the weak kit dies more than its kills factor says: ${at[0].shots.deaths} against ${at[0].shots.kills}`);
}
// A row with no table row at the level, or a piece above the level's grade, reads 1 and is counted.
{
    const run = KitHours.gameKitHours({ snapshot, anchor }), unit = { kills: 1, shots: 1, deaths: 1 };
    const noRow = run.spotFactors(fighter, 32, kitOf(fighter, 39), 'no-such-spot'), above = run.spotFactors(fighter, 32, kitOf(fighter, 47), '30_-30:f2');
    for (const form of ['bare', 'shots', 'blessed']) { assert.deepEqual(noRow[form], unit); assert.deepEqual(above[form], unit); }
    // A kit with no weapon fires no shot where the reference does: those forms read 1 and are counted.
    const bare = Object.fromEntries(Object.entries(kitOf(fighter, 32)).filter(([slot]) => slot !== '7' && slot !== '14')), before = run.stats.spotUnstated;
    const noWeapon = run.spotFactors(fighter, 32, bare, '30_-30:f2');
    assert.deepEqual(noWeapon.shots, unit);
    assert.equal(run.stats.spotUnstated, before + 1, 'a form only the reference fires is counted');
    run.stats.spotUnstated = before;
    assert.equal(run.stats.spotUnstated, 2, 'each unstated read is counted');
    assert.equal(run.spotFactors(fighter, 32, kitOf(fighter, 39), 'no-such-spot'), noRow);
    assert.equal(run.stats.spotUnstated, 2, 'a held read is not counted again');
}
// A fresh world's main wears its class's character-creation kit (the game's
// starter rows) from level 1. At every spot row with shots of levels 1-19 its
// charged forms state: a read is unstated only where the hunt cycle's
// shotless reader holds no row for the spot (the bare form), and there the
// line's reference kit is unstated too.
{
    const Starter = require('../src/GameServer/Knowledge/StarterItemCatalog');
    const run = KitHours.gameKitHours({ snapshot, anchor }), spotIds = Load.spotCards().spots.map(row => String(row[0]));
    const holds = (state, hunt) => HuntCycle.reader(state, { deathHours: 0, hourAdena: 1, hunt }).spotIds.map(String).includes(hunt.spotId);
    const unstated = (line, level, kit, spotId) => { const before = run.stats.spotUnstated; run.spotFactors(line, level, kit, spotId); return run.stats.spotUnstated > before; };
    // A human fighter line (Gladiator), the human mystic's Sorcerer and the orc fighter's Destroyer.
    for (const line of ['2', mage, fighter]) {
        const classId = Table.roleClass(line, 1), counts = { reads: 0, creation: 0, reference: 0 };
        const creation = Object.fromEntries(Starter.starterRows(Data.newbieItems, classId, Data.items).filter(row => row.equipped).map(row => [row.slot, row.selfId]));
        for (let level = 1; level <= 19; level++) {
            const state = HuntCycle.referenceState(classId, level, { line: Number(line) });
            let stated = 0;
            for (const spotId of spotIds) {
                const row = Table.value(spotId, line, level, true);
                if (!(row && row.kills > 0)) continue;
                counts.reads++;
                Pricing.useBoard(() => null);
                let charged, bare;
                try { charged = holds(state, { spotId }); bare = holds(state, { spotId, useShots: false }); } finally { Pricing.useBoard(null); }
                assert.ok(charged, `line ${line} at ${level}: the charged reader holds ${spotId}`);
                const own = unstated(line, level, creation, spotId), ref = unstated(line, level, kitOf(line, level), spotId);
                assert.equal(own, !bare, `line ${line} at ${level}, ${spotId}: the creation kit's read is unstated exactly where the shotless reader holds no row`);
                assert.equal(own, ref, `line ${line} at ${level}, ${spotId}: the creation kit and the reference kit are unstated at the same reads`);
                counts.creation += own; counts.reference += ref; stated += !own;
            }
            assert.ok(stated > 0, `line ${line} at ${level}: a read states every form, so the creation kit fires the reference's charged forms`);
        }
        assert.ok(counts.reads > 0 && counts.creation === counts.reference, `line ${line}: ${counts.creation} of ${counts.reads} reads unstated, the reference kit's ${counts.reference}`);
    }
}
// The model's readers stand on no board while they run and leave the game's
// board source as it was: a board the game's pricing finds after the model
// ran is the one it finds before.
{
    const Afk = invoke('GameServer/AfkTrade/AfkTradeService'), boardIndex = Afk.boardIndex;
    try {
        Pricing.useBoard(() => null);
        const npc = Pricing.botBuyPrice(SSD), cheaper = Math.floor(npc / 2);
        assert.ok(npc > 1 && cheaper > 0 && cheaper < npc, 'the shot has an NPC price to undercut');
        // A board whose one ask for the shot (a shop's row) stands below the NPC price.
        Afk.boardIndex = () => ({ first: (id, side, options) => { const row = { kind: 'shop', count: 5, price: cheaper }; return Number(id) === SSD && options.accept(row) ? row : null; } });
        Pricing.useBoard(null);
        assert.equal(Pricing.botBuyPrice(SSD), cheaper, 'before the model: the game prices the shot at the board ask');
        const run = KitHours.gameKitHours({ snapshot, anchor });
        assert.equal(Pricing.botBuyPrice(SSD), cheaper, 'after the model is built: the game prices the shot at the board ask');
        run.hour(fighter, 32, kitOf(fighter, bandAt(fighter, 32).level));
        assert.equal(Pricing.botBuyPrice(SSD), cheaper, 'after the model read an hour: the game prices the shot at the board ask');
    } finally {
        Afk.boardIndex = boardIndex;
        Pricing.useBoard(null);
    }
}
console.log('PASS economy model kit hours');
