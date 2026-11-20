'use strict';

// Today mode of the economy model: the fixed buyer's price, the fixed stores
// as a market a visiting main sells to and buys shots from, the fit of the
// hunting share and visits, today's arrivals, and the two tables of a
// comparison with a real run's ledger.
const assert = require('node:assert/strict');
const Today = require('../scripts/economy-model/today');
const Engine = require('../scripts/economy-model/engine');
const { judged, sharedRows, todayRows, requireSpots, footerOf } = require('../scripts/economy-model/compare');

// A store line is priced as the game prices it at the snapshot's preset (gamePrice,
// StaticMerchantPricing.botPriceFor); the fixed buyer pays it, at most 0.9 of the
// cheapest repeatable supply.
const line = { selfId: 200, gamePrice: 4000, count: 999999 };
assert.equal(Today.configuredPrice(line), 4000, 'the game\'s price');
assert.equal(Today.fixedBuyerPrice(line, Infinity), 4000, 'nobody supplies it: the game\'s price');
assert.equal(Today.fixedBuyerPrice(line, 3000), 2700, 'under the buyback share of the cheapest supply');
assert.throws(() => Today.configuredPrice({ selfId: 200, priceRate: 1 }), /gamePrice/, 'a snapshot without the game price is refused');

const snapshot = {
    header: { levels: [1, 30], rates: { adena: 50 } },
    exp: Array.from({ length: 30 }, (_, i) => i * 1000),
    hours: { 9: { 25: { classId: 7, shotId: 1463, best: { spotId: 's1', kills: 10, exp: 1000, adena: 100, shots: 20, loot: 0 } } } },
    kits: { 9: { 25: [] } },
    yields: { 's1@25': { town: 'TownA', drop: {}, spoil: {} } },
    items: {
        7000: { kind: 'Weapon.Sword', ref: 100, npcBuy: 50 },
        200: { kind: 'Other.Material', ref: 100, npcBuy: 50 },
        202: { kind: 'Other.Material', ref: 100, npcBuy: 50 },
        300: { kind: 'Other.Recipe', ref: 100, npcBuy: 50 },
        1463: { kind: 'Other.Shot', ref: 10, npcBuy: 5 }
    },
    npcOffers: { preset: { 202: [{ town: 'TownB', price: 1000 }] }, x1: {} },
    stores: [
        { town: 'TownA', storeType: Today.BUY, items: [line, { selfId: 202, gamePrice: 4000, count: 999999 }, { selfId: 300, gamePrice: 4000, count: 0 }] },
        { town: 'TownA', storeType: Today.SELL, items: [{ selfId: 1463, gamePrice: 500, count: 5000 }, { selfId: 200, gamePrice: 6000, count: 5000 }, { selfId: 7000, gamePrice: 900, count: 5000, reserve: true }] }
    ],
    recipes: [],
    fares: { TownA: { TownA: 0, TownB: 100 }, TownB: { TownA: 100, TownB: 0 } }
};

// The market: buy lines priced by the formula (a sold-out line buys nothing),
// sell lines for shots only (reserve gear apart).
const market = Today.marketOf(snapshot);
assert.deepEqual(market.buy, { TownA: { 200: 4000, 202: 900 } }, 'material 200: its line price under 0.9 of the cheapest supply; 202: 0.9 x the NPC price');
assert.deepEqual(market.sell, { TownA: { 1463: 500 } });
assert.deepEqual(market.reserve, { TownA: { 7000: 900 } }, 'a bot-only reserve line is a design seller of gear, not a shot line');

// A visiting main sells to its town's fixed buyer, the rest to the NPC, and
// restocks shots at the static line.
const view = Engine.viewOf(snapshot, { market });
const account = { id: 1, classId: 7, line: '9', level: 25, exp: 24000, money: 0, shots: {}, held: [], worn: {} };
const main = { ...Engine.mainOf(account, 0, view, [['20-29', 20], ['30-39', 30]]), bag: { 200: 10, 300: 1 } };
const { main: after, delta } = Today.visit(main, view, { outingHours: 0.5, firing: Today.hunter(view).firing(main) });
assert.equal(delta.flows.fixedBuyers, 40000, '10 x 4000 at the fixed buyer');
assert.equal(delta.flows.npcSales, 50, 'the recipe nobody buys here goes to the NPC');
assert.equal(delta.shotsBoughtFixed, 20, 'one hour of shots at the static line');
// The restock is the hunter's shots an hour times the outing: a worn kit
// firing half the row's shots over a 3-hour outing buys 3 x 10.
const halfShots = Today.hunter(view, () => ({ shots: { kills: 1, shots: 0.5 } }));
assert.equal(Today.visit({ ...main, bag: {}, money: 100000 }, view, { outingHours: 3, firing: halfShots.firing(main) }).delta.shotsBoughtFixed, 30, 'the hunter\'s 10 an hour x 3 hours');
assert.equal(delta.flows.fixedSellers, -20 * 500);
assert.equal(after.money, 40000 + 50 - 10000);
assert.deepEqual(after.bag, {});
// A main buys its shots in the town it stands in when that town sells them, though TownB sells them cheaper at a
// 0 fare; with no seller in its town it hops to TownB (the 0 fare still a hop) and buys there.
for (const [sell, towns, price] of [[{ TownA: { 1463: 600 }, TownB: { 1463: 500 } }, ['TownA'], 600], [{ TownB: { 1463: 500 } }, ['TownA', 'TownB'], 500]]) {
    const free = Engine.viewOf({ ...snapshot, fares: { TownA: { TownA: 0, TownB: 0 }, TownB: { TownA: 0, TownB: 0 } } }, { market: { buy: market.buy, sell } });
    const { delta: seen } = Today.visit({ ...main, bag: {}, money: 100000 }, free, { outingHours: 0.5, firing: Today.hunter(free).firing(main) });
    assert.deepEqual([seen.towns, seen.shotsBoughtFixed > 0, seen.flows.fixedSellers], [towns, true, -price * seen.shotsBoughtFixed], `shots bought in ${towns.at(-1)} at ${price}`);
}
// A beginner stack (Soulshots for Beginners charge the no-grade 1463 here) is
// never sold and counts as held of the shot it charges: the restock buys only
// what the line lacks over it. It fires the no-grade shot with the no-grade Squire's Sword in hand (no weapon fires none).
{
    const taught = { ...view, items: { ...view.items, 2369: { kind: 'Weapon.Sword', grade: 'NONE', ref: 0, npcBuy: 0 } }, shotFamilies: { grades: ['NONE'], ids: [[1463]] } };
    const starter = { ...main, weapon: 2369, bag: {}, money: 100000, shots: { 5789: 15 } };
    const firing = Today.hunter(taught).firing(starter);
    const { main: kept, delta: seen } = Today.visit(starter, taught, { outingHours: 0.5, firing });
    assert.deepEqual([firing.beginner, kept.shots[5789], seen.shotsSoldNpc, seen.unsold], [5789, 15, 0, 0], 'the beginner stack stays');
    assert.equal(seen.shotsBoughtFixed, Math.ceil(20 * Today.SHOT_LINE_HOURS) - 15, 'the restock counts the beginner shots as held');
}

// The fit: the band's realized exp over the mains' exp per hunting hour at
// the spot rows they hunt; visits per hunting main; an empty band takes its
// nearest populated band.
const bands = [['20-29', 20], ['30-39', 30]];
const baseline = { visits: { perHour: 10 }, progress: { stageBands: { '20-29': { bots: 2, expPerBotHour: 600, activityAtEnd: { hunting: 1, grouped: 1 } } } } };
const accounts = [account, { ...account, id: 2 }, { ...account, id: 3, station: true }];
const { rates, basis } = Today.fit(baseline, accounts, view, bands);
assert.equal(basis['20-29'].huntShare, 0.6);
assert.equal(basis['20-29'].activityHunting, 0.5, 'printed beside the fit, not fitted to');
assert.equal(basis['20-29'].activityGrouped, 0.5);
assert.equal(rates['20-29'].visitsPerBotHour, 5, '10 visits an hour over 2 hunting mains');
assert.deepEqual(rates['30-39'], { huntShare: 0.6, visitsPerBotHour: 5, fittedOn: '20-29' });
// A band whose mains are one party of three equal members fits its share
// over a member's exp at the row: the C4 3-member bonus 1.39, split evenly.
const trio = [1, 2, 3].map((id, self) => ({ ...account, id, party: { levels: [25, 25, 25], self } }));
assert.equal(Today.fit(baseline, trio, view, bands).basis['20-29'].huntShare, 600 / 1390, 'real exp over 1.39 x the row\'s exp');
// The design fit counts the kit once: with mains whose worn kit makes half
// the row's kills (the factor their design hunt reads) the band hunted twice
// the time for its exp; the plain fit (today mode) reads no kit.
const kitFit = Today.fit(baseline, accounts, view, bands, () => 0.5).basis['20-29'];
assert.deepEqual([kitFit.huntShare, kitFit.kitFactor], [1.2, 0.5], 'twice the plain share, the band\'s kit factor 0.5');
assert.equal(basis['20-29'].kitFactor, undefined, 'the plain fit states no kit factor');
// Today's setup fits the share over each main's exp at its worn kit, the
// factor its hunt reads: a worn kit making half the reference kit's kills
// hunted twice the time for the band's exp, and its hunter reads that half.
const shares = kills => ({ killShare: kills, shotShare: 1 });
const kitHours = { hour: (line, level, kit) => { const share = shares(Object.keys(kit).length ? 0.5 : 1); return { noneShare: share, shots: [{ kind: 'soulshot', id: 1463, ...share }] }; },
    shotScale: () => 1 };
const set = Today.setup(snapshot, baseline, accounts, kitHours), band = Object.keys(set.basis)[0];
assert.deepEqual([set.basis[band].huntShare, set.basis[band].kitFactor], [1.2, 0.5], 'real 600 over the row\'s 1000 x the worn kit\'s 0.5');
assert.equal(set.hunter.kills(main).shots, 0.5, 'its hunt reads the same factor');

// Today's arrivals: periodic at the band's fitted rate, the first at the
// seeded share of the interval, none at a rate of 0.
assert.equal(Today.TODAY.arrivals, 'fitted periodic');
assert.equal(Today.nextArrival(main, { now: 0, rate: rates['20-29'], event: 'start', roll: 0.5 }), 0.1);
assert.equal(Today.nextArrival(main, { now: 1, rate: rates['20-29'], event: 'visit', roll: 0.5 }), 1.2)
assert.equal(Today.nextArrival(main, { now: 1, rate: rates['20-29'], event: 'level_up', pending: 1.7, roll: 0.5 }), 1.7, 'a level-up leaves the pending arrival');
assert.equal(Today.nextArrival(main, { now: 1, rate: { visitsPerBotHour: 0 }, event: 'visit', roll: 0.5 }), null);

// The comparison's two tables. Shared: exp is fitted (no verdict), a ratio
// within ±25 % passes, outside fails, a wrong sign fails, drops are judged per
// class and grade per bot-hour from 30 real units on, consumables are left
// out. Today's mechanisms: a ratio and a reason, never a verdict.
const real = {
    population: { bots: 3, botHours: 10, stageBands: { '20-29': 2, station: 1 } },
    flows: { perBotHour: { huntCold: 100, hotUnlabeled: 100, fixedBuyers: 1000, npcSales: 100, fares: -10 }, fixedBuyerShareOfFaucets: 0.4 },
    money: { growthPerHour: 0.1 },
    progress: { stageBands: { '20-29': { expPerBotHour: 500, levelUps: 40, money: { deltaPerBotHour: 50 } }, station: { money: { deltaPerBotHour: 5 } } } },
    goods: [{ class: 'material', grade: 'none', drop: 1000, hotIn: 500 }, { class: 'recipe', grade: 'none', drop: 100 }, { class: 'weapon', grade: 'd', drop: 4 },
        { class: 'potion', grade: 'none', drop: 500 }],
    recipes: { dropped: { d: 100 } },
    shots: { used: 2000 },
    visits: { perHour: 4 }
};
const model = {
    population: { bots: 3, botHours: 10, stageBands: { '20-29': 2, station: 1 } },
    flows: { perBotHour: { huntCold: 120, fixedBuyers: 300, npcSales: 130, fares: 10 }, fixedBuyerShareOfFaucets: 0.1 },
    money: { growthPerHour: -0.05 },
    progress: { stageBands: { '20-29': { expPerBotHour: 480, levelUps: 30, money: { deltaPerBotHour: -20 } } } },
    drops: { byItem: { 200: 1100, 300: 200, 1463: 9 } },
    recipes: { dropped: { d: 200 } },
    shots: { used: 2100 },
    window: { hours: 1 },
    counters: { visits: 8, onwardHops: 2 }
};
const shared = Object.fromEntries(sharedRows(real, model, snapshot.items).map(row => [row.label, row]));
assert.equal(shared['exp per bot-hour 20-29'].verdict, 'fitted');
assert.equal(shared['level-ups 20-29'].verdict, 'follows the fit', 'a consequence of the fitted exp, never a pass');
assert.equal(shared['hunt adena per bot-hour'].verdict, 'PASS');
assert.equal(shared['hunt adena per bot-hour'].ratio, 1.2);
// The real number is a range, cold to cold plus hot: the model at 120 is near the cold end,
// at 230 near the cold+hot end (200), at 140 between the ends, at 300 out.
assert.deepEqual([shared['hunt adena per bot-hour'].baseline, shared['hunt adena per bot-hour'].baselineHigh, shared['hunt adena per bot-hour'].why], [100, 200, 'cold end']);
const adenaAt = huntCold => sharedRows(real, { ...model, flows: { perBotHour: { ...model.flows.perBotHour, huntCold } } }, snapshot.items).find(row => row.label === 'hunt adena per bot-hour');
assert.deepEqual([adenaAt(230).verdict, adenaAt(230).why, adenaAt(230).ratioHigh], ['PASS', 'cold+hot end', 1.15]);
assert.deepEqual([adenaAt(140).verdict, adenaAt(140).why], ['PASS', 'between the ends']);
assert.deepEqual([adenaAt(300).verdict, adenaAt(300).why], ['FAIL', 'size']);
assert.equal(shared['dropped material/none per bot-hour'].baselineHigh, 150, 'cold 100 plus hot 50 an hour');
assert.equal(shared['dropped material/none per bot-hour'].baseline, 100, '1000 units over 10 bot-hours');
assert.equal(shared['dropped material/none per bot-hour'].verdict, 'PASS', '1100 of 1000');
assert.equal(shared['dropped recipe/none per bot-hour'], undefined, 'recipes are judged by product grade: the class row would count one miss twice');
assert.equal(shared['dropped weapon/d per bot-hour'].verdict, 'few units', '4 real units are not judged');
assert.equal(shared['dropped potion/none per bot-hour'], undefined, 'a consumable\'s cold drop nets with its use');
assert.equal(shared['recipes for d products per bot-hour'].verdict, 'FAIL');
assert.equal(shared['shots used per bot-hour'].verdict, 'PASS');
assert.equal(shared['fares per bot-hour'].why, 'sign', 'a fare that pays the bot is wrong whatever its size');
assert.equal(shared['arrivals per hunting bot-hour'].verdict, 'fitted');
assert.equal(shared['arrivals per hunting bot-hour'].baseline, 2, '4 an hour over 2 hunting bots');
assert.equal(shared['arrivals per hunting bot-hour'].model, 3, '6 arrivals (8 visits less 2 onward hops) over 2 hunting bots');
assert.equal(shared['onward hops per hunting bot-hour'].model, 1);
assert.equal(shared['onward hops per hunting bot-hour'].verdict, 'no real count', 'printed, never judged');
const today = todayRows(real, model);
assert.ok(today.length >= 5);
assert.ok(today.every(row => row.verdict === 'today' && row.why), 'a today row is never judged and always says why');
const fixed = today.find(row => row.label === 'flows.perBotHour.fixedBuyers');
assert.equal(fixed.ratio, 0.3);
assert.equal(today.find(row => row.label === 'money.growthPerHour').verdict, 'today', 'a wrong sign is not a verdict here');
assert.equal(today.find(row => row.label === 'money per bot-hour station'), undefined, 'stations are not modelled');

// The cohort's copies of the ledger's station prefix and merchant activity are the ledger's own.
const Cohort = require('../scripts/economy-model/cohort');
const LedgerRules = require('../scripts/economy/ledger-rules');
assert.equal(LedgerRules.stageBandOf({ accountName: `${Cohort.STATION_ACCOUNT_PREFIX}1`, level: 30 }), 'station', 'the ledger counts the cohort\'s prefix as a station');
assert.notEqual(LedgerRules.stageBandOf({ accountName: `${Cohort.STATION_ACCOUNT_PREFIX.slice(0, -1)}`, level: 30 }), 'station', 'and no shorter prefix');
assert.equal(LedgerRules.population([{ activity: Cohort.MERCHANT_ACTIVITY }]).merchants, 1, 'the ledger counts the cohort\'s merchant activity as a merchant');

// The cohort carries, from the save, the active background party a bot is in:
// its members' start levels and the bot's place among them; a dissolved party
// and a party of one member the save holds as a bot carry none.
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'party-save-')), file = path.join(folder, 'database.sqlite');
const save = new DatabaseSync(file);
save.exec(`CREATE TABLE characters (id INTEGER PRIMARY KEY, classId INTEGER);
    CREATE TABLE bot_life_state (characterId INTEGER PRIMARY KEY, accountName TEXT, level INTEGER, exp INTEGER, activity TEXT, spotId TEXT, statsJson TEXT);
    CREATE TABLE items (characterId INTEGER, selfId INTEGER, amount INTEGER, equipped INTEGER, slot INTEGER);
    CREATE TABLE warehouse_items (characterId INTEGER, selfId INTEGER, amount INTEGER);
    CREATE TABLE bot_personas (characterId INTEGER PRIMARY KEY, primaryDrive TEXT, traitsJson TEXT);
    CREATE TABLE bot_background_parties (partyId TEXT, memberIdsJson TEXT, status TEXT);`);
// Spot-less bots start on the spot the save names for them (a travel's, else a stay's), a bot on a spot keeps it.
const spots = { 1: [null, '{"travel":{"spotId":"X"},"stay":{"spotId":"Y"}}'], 2: [null, '{"stay":{"spotId":"Y"}}'],
    3: ['Z', '{"travel":{"spotId":"X"}}'], 4: [null, '{"travel":{}}'], 5: [null, null], 6: [null, null] };
// Bot 6's class (99) has no line in the snapshot: it is counted as having none and becomes a station.
for (const [id, level] of [[1, 20], [2, 24], [3, 30], [4, 30], [5, 41], [6, 35]]) {
    save.prepare('INSERT INTO characters VALUES (?, ?)').run(id, id === 6 ? 99 : 7);
    save.prepare('INSERT INTO bot_life_state VALUES (?, ?, ?, 0, ?, ?, ?)').run(id, `bot_${id}`, level, 'hunting', ...spots[id]);
}
save.prepare('INSERT INTO bot_background_parties VALUES (?, ?, ?)').run('a', '[1,2,99]', 'active');
save.prepare('INSERT INTO bot_background_parties VALUES (?, ?, ?)').run('b', '[3,4]', 'dissolved');
save.prepare('INSERT INTO bot_background_parties VALUES (?, ?, ?)').run('c', '[5,98]', 'active');
save.close();
const cohort = Cohort.fromSave(file, { hours: { 9: { 20: { classId: 7 } } }, items: {}, twins: {}, recipes: [] });
fs.rmSync(folder, { recursive: true });
assert.deepEqual(cohort.accounts.map(account => account.party), [{ levels: [20, 24], self: 0 }, { levels: [20, 24], self: 1 }, null, null, null, null]);
assert.deepEqual(cohort.accounts.map(account => account.spot), ['X', 'Y', 'Z', null, null, null], 'the save\'s own spot, else its travel\'s, else its stay\'s');
assert.equal(cohort.lines.noLine, 1, 'the main whose class has no line is counted');
assert.equal(cohort.accounts[5].station, true, 'and becomes a station');
assert.equal(cohort.accounts.filter(account => account.station).length, 1, 'no other main does');

const verdict = (baseline, model, baselineHigh) => judged({ baseline, model, baselineHigh }, 'relative').verdict;
assert.equal(verdict(-100, -88), 'PASS', 'a negative flow within the tolerance passes');
assert.equal(verdict(-100, -130), 'FAIL', 'a negative flow too far fails');
assert.equal(verdict(-100, 88), 'FAIL', 'the wrong sign fails');
assert.equal(verdict(100, 130, 110), 'PASS', 'within the tolerance of the upper end of a range');
assert.equal(verdict(100, 140, 110), 'FAIL', 'beyond it');

// A comparison needs the snapshot's rows for the baseline's own save: a snapshot
// with none, or with another save's, is refused with the way to build one.
const start = { inputs: { start: { db: '/saves/a/database.sqlite' } } };
assert.throws(() => requireSpots({ header: {} }, start, []), /no spot rows.*inputs\.js --preset <preset> --spots \/saves\/a\/database\.sqlite/);
assert.throws(() => requireSpots({ spotHours: { source: '/saves/b/database.sqlite', rows: {} } }, start, []), /another save \(\/saves\/b/);
// A snapshot of that save built before the save named a main's spot (no entry
// for it) is refused too; an entry of null (its line fights nothing there), a
// station's spot and a level above the snapshot's are not asked for.
const named = { header: { levels: [1, 30] }, spotHours: { source: '/saves/a/database.sqlite', rows: { 9: { 25: { s1: null } } } } };
const holding = spot => ({ station: false, line: '9', level: 25, spot });
assert.equal(requireSpots(named, start, [holding('s1'), holding(null), { ...holding('s2'), station: true }, { ...holding('s2'), level: 31 }]), '/saves/a/database.sqlite');
assert.throws(() => requireSpots(named, start, [holding('s1'), holding('s2')]), /lack 1 spots the save names.*--spots \/saves\/a\/database\.sqlite/);

console.log('economy model today mode: ok');

// The footer names the run the compare ran against, not one fixed baseline's minutes and preset.
const footer = footerOf({ window: { hours: 0.5 } }, 'x10').join('\n');
assert.ok(footer.includes('30-minute x10 run') && !footer.includes('25-minute'), 'the footer prints the baseline\'s minutes and preset');
