'use strict';
const assert = require('node:assert/strict');
require('../src/Global'); invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const saved = { value: Table.value, best: Table.best, hunt: Hunt.huntIncome, incomeRow: Hunt.incomeRow };
let stacks = 10, load = 0, rowPresent = true, spotPresent = true, potions = 2, income = 100000;
// Bag filler no sale takes (a weightless quest item): it stays in the bag the kit's outing starts with.
const kept = amount => ({ selfId: 687, amount, stackable: false, kind: 'Other.Quest' });
// The stock is sized for the hours to a full bag whatever the bot's past visits: a visit history
// left in a saved row (the old visit interval) is read by nothing.
const fixture = { characterId: 91819, level: 30, phase: 'hot', activity: 'hunting',
    stats: { classId: 1 }, party: { partyId: 1 }, vitals: { hp: 1000, mp: 1000 }, loc: {},
    inventory: { 1: kept(39),
        1061: { selfId: 1061, amount: 1, stackable: true } } };
Hunt.huntIncome = () => ({ spotId: spotPresent ? 'stack-fixture' : null, perHour: income, expPerHour: 1000000 });
const row = withShots => ({ exp: withShots ? 1e6 : 5e5, shots: 1000, potions, deaths: .1, stacks, load });
Table.value = (id, role, level, withShots) => rowPresent ? row(withShots) : null;
// ShotStock.usePolicy weighs the best row with shots against the best without.
Table.best = (role, level, withShots) => row(withShots);
// A bot on no spot uses the row its hour is priced on (EquipmentIncomeRoute.spotUseOf).
Hunt.incomeRow = () => ({ ...row(true), spotId: 'stack-fixture', useShots: true });
const target = (state = fixture) => Economy.basics(state, { spots: [] }).stock('potions').targetHours;
try {
    assert.equal(target(), 3.9, '80 slots - 40 physical slots with an existing kit - the scroll the visit buys, 10 new slots/h -> 3.9h');
    const emptyPotion = { ...fixture, inventory: { 1: kept(40) } };
    assert.equal(target(emptyPotion), 3.8, 'an absent positive-use potion reserves its refill slot');
    const filledPotion = { ...emptyPotion, inventory: { ...emptyPotion.inventory,
        1061: { selfId: 1061, amount: 8, stackable: true } } };
    assert.equal(target(filledPotion), target(emptyPotion), 'creating the purchased potion stack cannot lower its target');
    const emptyKit = { ...fixture, inventory: { 1: kept(39),
        126: { selfId: 126, amount: 1, equipped: true, equippedCount: 1, slot: 7, stackable: false } } };
    const emptyStock = Economy.basics(emptyKit, { spots: [] });
    assert(emptyStock.stock('shots').usePerHour > 0);
    assert.equal(target(emptyKit), 3.7, 'both absent positive-use kit stacks reserve a slot');
    const filledKit = { ...emptyKit, inventory: { ...emptyKit.inventory,
        1463: { selfId: 1463, amount: emptyStock.stock('shots').target, stackable: true },
        1061: { selfId: 1061, amount: emptyStock.stock('potions').target, stackable: true } } };
    assert.equal(target(filledKit), 3.7, 'the existing full kit keeps the exact physical free-slot formula');
    assert.equal(Economy.basics(filledKit, { spots: [] }).stock('shots').target, emptyStock.stock('shots').target);
    assert.equal(Economy.basics(filledKit, { spots: [] }).stock('potions').target, emptyStock.stock('potions').target);
    assert.equal(target({ ...fixture, inventory: {} }), 7.8, 'an otherwise empty bag reserves only the used potion and the scroll');
    income = 1;
    assert.equal(Economy.basics(emptyKit, { spots: [] }).stock('shots').usePerHour, 0);
    assert.equal(target(emptyKit), 3.8, 'unprofitable shots reserve no slot; the used potion still reserves one');
    income = 100000; potions = 0;
    assert.equal(target({ ...fixture, inventory: {} }), 7.9, 'zero-use kit reserves no slots; the scroll still takes one');
    potions = 2;
    assert.equal(target({ ...fixture, inventory: { 1: kept(80) } }), 0,
        'zero free room: no hours to a full bag, the kit holds its line (old: clamped to half an hour)');
    assert.equal(Economy.basics({ ...fixture, inventory: { 1: kept(80) } }, { spots: [] }).stock('potions').target, 2,
        'the line: one hour of use');
    // No new slots an hour: the first weight step bounds the hours. maxLoad 109232.7 (class 1, level 30):
    // 54616 below the step; the bot with no weapon fires no shots: (54616 - 5, a bottle's room, - 120, the scroll's) /
    // (2 bottles x 5 x 1.1) = 4953.7 h; with its sword, 1000 Soulshot D (mass 3) an hour weigh too.
    stacks = 0; assert.equal(target(), 4953.7, 'no new slots -> the stock\'s own weight bounds the hours (old: 24 h cap)');
    assert.equal(target(emptyKit), 16, 'the shots\' weight: (54616 - 3 - 5 - 120 - its 1500 sword) / (3300 + 11) = 16.04 h');
    stacks = null; assert.equal(target(), 1, 'a row without a bag forecast holds the line (old: the learned 24 h)');
    stacks = 10; rowPresent = false; assert.equal(target(), 3.9, 'missing best-spot row: the row the use is priced on forecasts the bag');
    rowPresent = true; spotPresent = false; assert.equal(target(), 3.9, 'no best spot: the priced row forecasts the bag');
    spotPresent = true; stacks = 1000; assert.equal(target(), 0, '40 free slots at 1000 new slots/h: under a tenth of an hour');
    stacks = 10;
    for (const visitEvery of [[22, 4], [22, 1], [22, 24], undefined]) {
        assert.equal(target({ ...fixture, stats: { ...fixture.stats, visitEvery } }), 3.9, `a past visit interval ${visitEvery} has no effect`);
    }
    assert.equal(target({ ...fixture, stats: { classId: 53, visitEvery: [22, 24] } }), 5.9, 'native dwarf class uses100-slot bag');
    assert.equal(target({ ...fixture, inventory: { 1864: { selfId: 1864, amount: 40, stackable: true, kind: 'Other.Quest' } } }), 7.7,
        'a kept stack occupies one slot and its absent potion reserves one');
    assert.equal(target({ ...fixture, inventory: { 1864: { selfId: 1864, amount: 40, stackable: true } } }), 7.8,
        'a party member\'s loot leaves with its sale: the outing after it has the full bag less the planned potion and scroll');
    assert.equal(target({ ...fixture, stats: { classId: 1 }, inventory: {} }), 7.8,
        'an empty bag sizes the kit for its full bag (old: a bot without history stocked 2 h)');
    assert.equal(target({ ...fixture, stats: { classId: 1, visitEvery: [22, 1] }, inventory: {} }), 7.8,
        'a bot that visited every hour stocks the same full bag (old: 1 h)');
    // The drop's weight: 20000 load an hour fills the 54491 left beside the bottles in
    // 54491 / (20000 + 11) = 2.72 h, before the 7.8 h the slots allow.
    load = 20000;
    assert.equal(target({ ...fixture, inventory: {} }), 2.7, 'a heavy drop shortens the hours to the first weight step');
    const heavy = Economy.basics({ ...fixture, inventory: {} }, { spots: [] }).stock('potions');
    assert.equal(heavy.target, 6, 'ceil(2 x 2.7 x 1.1)');
    assert(heavy.target * 5 + 2.7 * 20000 < 54616, 'the stock and the drop until the visit stay under the first weight step');
    // A heavy kept item leaves less load to fill: 10 Short Swords (16000) no sale takes.
    assert.equal(target({ ...fixture, inventory: { 1: { selfId: 1, amount: 10, stackable: false, kind: 'Other.Quest' } } }), 1.9,
        'what the bag keeps weighs on the hours: (54616 - 16000 - 5 - 120) / 20011');
    load = 0;
    const solo = { ...fixture, party: null, inventory: { 1: { selfId: 1, amount: 19, stackable: false },
        1061: { selfId: 1061, amount: 1, stackable: true } } };
    assert.equal(target(solo), 3.8, 'solo loot: the outing after the sale ends at the 40-slot sale threshold, '
        + 'the bag it leaves holds the potion and the scroll: 38 free / 10 slots per hour');
    for (const visitEvery of [[22, 8], [22, 1]]) {
        assert.equal(target({ ...solo, stats: { ...solo.stats, visitEvery } }), 3.8, `solo: a past interval ${visitEvery} has no effect`);
    }
    assert.equal(target({ ...solo, phase: 'cold' }), target(solo), 'hot and cold use the identical stock horizon');
    assert.equal(target({ ...solo, partyId: 2 }), 7.8, 'standalone party membership retains the full-bag bound');
    // 829e4442 removed the generated-bot sale level cutoff: a level 9 bot
    // sells like any other, so its executable bag sale bounds the outing too.
    assert.equal(target({ ...solo, stats: { ...solo.stats, generatedCold: true }, level: 9 }), target({ ...solo, level: 9 }),
        'a low-level generated bot forecasts the same executable sale');
    assert.equal(target({ ...solo, level: 9 }), 3.7, 'the level 9 bag sale still bounds the outing (its Lesser Healing Potion plans a slot)');
    // The last visit tried these goods and could not place them: they stay in the bag and, as in the
    // trip rule's half bag, count nothing; the new loot fills the 40 slots less the planned scroll
    // (old: 6 h on the whole bag while the sale retry held, so the target read the board).
    const tried = { items: Object.keys(solo.inventory).map(Number), buyers: null };
    assert.equal(target({ ...solo, stats: { ...solo.stats, marketSellSeen: tried } }), 3.9,
        'the goods the last visit could not place do not fill the half bag: (40 - the scroll) / 10 slots per hour');
    const protectedLoot = { ...solo, inventory: { 1864: { selfId: 1864, amount: 1, stackable: true } },
        stats: { ...solo.stats, equipmentPlan: { status: 'active', strategy: 'craft', materials: [{ selfId: 1864, amount: 1 }] } } };
    assert.equal(target(protectedLoot), 3.7, 'reserved craft input cannot justify an early sale, and the solo bot still '
        + 'turns back at its 40-slot half bag: 40 - the kept stack - the planned potion and scroll (old: 7.8 on the whole bag)');
    assert.equal(target({ ...solo, inventory: { 1864: { selfId: 1864, amount: 1, stackable: true } } }), 3.8,
        'free material leaves with the sale; the planned potion and scroll occupy two of 40 sale slots');
    const ownKitOnly = { ...solo, inventory: { 126: { selfId: 126, amount: 1, equipped: true,
        equippedCount: 1, slot: 7, stackable: false }, 1463: { selfId: 1463, amount: 1000000, stackable: true },
        1061: { selfId: 1061, amount: 1000000, stackable: true } } };
    assert.equal(target(ownKitOnly), 3.6, 'own usable consumable surplus never shortens its own forecast: '
        + '40 half-bag slots - sword, shots, potion, scroll (old: 7.7 on the whole bag)');
    stacks = 0;
    // A bag at the sale threshold goes to town now; its kit is for the outing after the sale, which fills
    // no slots with zero new slots/hour: the stock's own weight bounds it (the swords leave with the sale).
    assert.equal(target({ ...solo, inventory: { 1: { selfId: 1, amount: 39, stackable: false },
        1061: solo.inventory[1061] } }), 4953.7, 'a bag at the sale threshold plans the outing after the sale');
    rowPresent = true; stacks = 10;
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    // The sale list reads the kit's targets once (the build's rates over the
    // bag). A forecast re-entering the sale list would read them a second time.
    const beforeKept = Economy.keptTargets; let keptCalls = 0;
    Economy.keptTargets = (...args) => { keptCalls++; return beforeKept(...args); };
    try { Disposition.saleCandidates(solo, { unlimited: true }); assert.equal(keptCalls, 1,
        'ordinary sale prepares the economics once; forecast presence never recursively calls it'); }
    finally { Economy.keptTargets = beforeKept; }
    // Fractional table rates are forecasts, but funded purchase tranches must
    // reach the same physical stock without fractional or duplicate units.
    // A level-30 bot's death costs its exp (EconomicValuation.deathHours; a
    // table row's deaths carry no respawn wait since T126, so a bot with no
    // exp to lose and no walk back has a free death and no survival utility).
    // The bag's 79 free slots at 158, 79, 39.5 and 19.75 new slots an hour: .5, 1, 2 and 4 hours.
    potions = 2.25;
    const level30Exp = invoke('GameServer/DataCache').experience[29];
    for (const phase of ['hot', 'cold']) for (const hours of [.5, 1, 2, 4]) {
        stacks = 79 / hours;
        for (const held of [0, 1, 2, 3, 8, 10]) {
            const state = { ...fixture, phase, stats: { ...fixture.stats, exp: level30Exp },
                inventory: { 1061: { selfId: 1061, amount: held, stackable: true } } };
            const stock = Economy.basics(state, { spots: [] }).stock('potions');
            assert.equal(stock.usePerHour, 2.25, 'native fractional table forecast reaches the stock rule');
            const purchase = stock.survivalMissing + stock.missing;
            assert(Number.isSafeInteger(purchase), `${phase}: whole potion purchase with ${held} held`);
            // A full bag's use plus the reserve: ceil(2.25 x hours x 1.1) = 2, 3, 5, 10.
            const expected = Math.max(0, Math.max(3, { .5: 2, 1: 3, 2: 5, 4: 10 }[hours]) - held);
            assert.equal(purchase, expected, `${phase}: fill the greater of the bag's stock and survival stock once`);
            assert.equal(stock.survivalTarget, Math.min(3, stock.target));
            assert.equal(stock.needed, held < stock.survivalTarget);
            assert.equal(stock.benefitHours, stock.missing * stock.benefitPerUnit,
                'only missing optional potion units receive wish utility');
            assert(stock.benefitPerUnit > 0, 'survival-only units retain finite travel utility');
        }
    }
    console.log('test_stock_bag_fill_interval: ok');
} finally { Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.hunt; Hunt.incomeRow = saved.incomeRow; }
