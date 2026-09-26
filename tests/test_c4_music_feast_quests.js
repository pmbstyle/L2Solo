// Lifecycle certification for the C4 music and feast chain:
// Q362 Bard's Mandolin, Q363 Sorrowful Sound of Flute, Q364 Jovial Accordion,
// Q379 Fantasy Wine and Q378 Magnificent Feast.
//
// These five share a datapack: Q379 makes the wine, Q364 makes the musical
// score, and Q378 consumes both. The chain is therefore walked end to end, with
// one character carrying a real Q379 wine and a real Q364 score into Ranspo's
// banquet rather than being handed them.
//
// Q378 is scored, not random, so all nine reward rows are driven and asserted
// exactly - item, amount and adena - and the three impossible sums are shown to
// be unreachable by construction.
const assert = require('node:assert/strict');
const { createWorld, Service, Database, DataCache, withRandom } = require('./helpers/c4QuestHarness');

const ADENA = 57;

// Q362
const SWAN = 7957;
const WOODROW = 7837;
const GALION = 7958;
const NANARIN = 7956;
const SWAN_FLUTE = 4316;
const SWAN_LETTER = 4317;
const THEME_OF_JOURNEY = 4410;

// Q363
const BARBADO = 7959;
const ADVISERS = [7595, 7458, 7057, 7594, 7058];
const CLOTHES = 4318;
const NANARIN_FLUTE = 4319;
const BLACK_BEER = 4320;
const THEME_OF_SOLITUDE = 4420;

// Q364
const SABRIN = 7060;
const XABER = 7075;
const CLOTH_CHEST = 7961;
const BEER_CHEST = 7960;
const CLOTH_KEY = 4323;
const BEER_KEY = 4324;
const STOLEN_BEER = 4321;
const STOLEN_CLOTHES = 4322;
const THEME_OF_FEAST = 4421;

// Q379 / Q378
const HARLAN = 7074;
const RANSPO = 7594;
const ENKU_CHAMPION = 291;
const ENKU_SHAMAN = 292;
const LEAF = 5893;
const STONE = 5894;
const WINE_15 = 5956;
const WINE_30 = 5957;
const WINE_60 = 5958;
const RITRON_DESSERT = 5959;
const SALAD_RECIPE = 1455;
const SAUCE_RECIPE = 1456;
const STEAK_RECIPE = 1457;

const CHARACTERS = [
    { id: 3620, level: 20 }, { id: 3621, level: 14 },
    { id: 3630, level: 20 }, { id: 3631, level: 20 }, { id: 3632, level: 14 },
    { id: 3640, level: 20 }, { id: 3641, level: 20 }, { id: 3642, level: 20 },
    { id: 3790, level: 20 }, { id: 3791, level: 19 },
    // One character per Q378 score row, plus a gate probe and the chain runner.
    ...[9, 10, 12, 17, 18, 20, 33, 34, 36].map((score) => ({ id: 37800 + score, level: 20 })),
    { id: 37700, level: 19 }, { id: 37701, level: 20 }
];

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-music-feast');
    try {
        await datapack();
        await bardsMandolin(world);
        await sorrowfulFlute(world);
        await jovialAccordion(world);
        await fantasyWine(world);
        await magnificentFeast(world);
        await fullChain(world);
        console.log('C4 Q362/Q363/Q364/Q379/Q378: restored music NPCs and wine items, every '
            + 'branch of the flute and accordion errands, the ten-part wine split, all nine '
            + 'scored feast rewards and the wine-to-banquet chain passed');
    } finally {
        await world.close();
    }
}

// The restored content must resolve through the cache the server consults.
async function datapack() {
    for (const [selfId, name] of [[7956, 'Nanarin'], [7957, 'Swan'], [7958, 'Galion'],
        [7959, 'Barbado'], [7960, 'Beer Chest'], [7961, 'Cloth Chest']]) {
        const npc = DataCache.npcs.find((entry) => entry.selfId === selfId);
        assert.ok(npc, `NPC ${selfId} resolves`);
        assert.equal(npc.template.name, name, `NPC ${selfId} is ${name}`);
        const spawns = DataCache.npcSpawns.flatMap((group) => group.spawns)
            .filter((spawn) => Number(spawn.selfId) === selfId);
        assert.equal(spawns.length, 1, `${name} has exactly one authored world spawn`);
        assert.ok(Number.isFinite(spawns[0].coords[0].locX), `${name} has a real position`);
    }
    for (const [selfId, name, stackable] of [[5893, 'Leaf of Eucalyptus', true],
        [5894, 'Stone of Chill', true], [5956, '15 Year Old Wine', true],
        [5957, '30 Year Old Wine', true], [5958, '60 Year Old Wine', true],
        [5959, "Ritron's Dessert Recipe", false]]) {
        const item = DataCache.items.find((entry) => entry.selfId === selfId);
        assert.ok(item, `item ${selfId} resolves`);
        assert.equal(item.template.name, name, `item ${selfId} is ${name}`);
        assert.equal(item.etc.stackable, stackable, `item ${selfId} stacks as the source says`);
    }
}

async function bardsMandolin(world) {
    const young = await world.session(3621);
    assert.equal(await world.event(young, 362, 'start', SWAN), false, 'Q362 refuses level 14');

    let session = await world.session(3620);
    assert.deepEqual(await world.links(session, SWAN, 362), ['start'], 'Swan offers the errand');
    assert.ok(await world.event(session, 362, 'start', SWAN), 'a level 15 bard-helper may start');

    // Talking to Swan again before Woodrow must not skip a stage.
    await world.talk(session, SWAN);
    assert.equal(world.state(session, 362).getInt('cond'), 1, 'Swan does not advance his own errand');

    await world.talk(session, WOODROW);
    assert.equal(world.state(session, 362).getInt('cond'), 2, 'Woodrow names Galion');

    await world.talk(session, GALION);
    assert.equal(await world.amount(3620, SWAN_FLUTE), 1, "Galion hands over Swan's flute");
    assert.equal(world.state(session, 362).getInt('cond'), 3, 'the flute advances the errand');

    // Galion does not hand out a second flute.
    await world.talk(session, GALION);
    assert.equal(await world.amount(3620, SWAN_FLUTE), 1, 'Galion gives only one flute');

    await world.talk(session, SWAN);
    assert.equal(await world.amount(3620, SWAN_LETTER), 1, 'Swan adds his letter');
    assert.equal(world.state(session, 362).getInt('cond'), 4, 'the letter advances the errand');

    // The stage boundary survives a restart.
    session = await world.reopen(3620);
    assert.equal(world.state(session, 362).getInt('cond'), 4, 'cond 4 survived a restart');

    await world.talk(session, NANARIN);
    assert.equal(await world.amount(3620, SWAN_FLUTE), 0, 'Nanarin takes the flute');
    assert.equal(await world.amount(3620, SWAN_LETTER), 0, 'Nanarin takes the letter');
    assert.equal(world.state(session, 362).getInt('cond'), 5, 'Nanarin sends you back to Swan');

    await world.talk(session, SWAN);
    assert.equal(await world.amount(3620, ADENA), 10000, 'Swan pays exactly 10000 adena');
    assert.equal(await world.amount(3620, THEME_OF_JOURNEY), 1, 'Swan gives the Theme of Journey');
    assert.equal(world.state(session, 362).state, 'created', 'Q362 is repeatable');

    // Repeating pays again, and only once per run.
    assert.ok(await world.event(session, 362, 'start', SWAN), 'the errand can be run again');
    await world.talk(session, SWAN);
    assert.equal(await world.amount(3620, ADENA), 10000, 'a fresh run pays nothing up front');
}

async function sorrowfulFlute(world) {
    const young = await world.session(3632);
    assert.equal(await world.event(young, 363, 'start', NANARIN), false, 'Q363 refuses level 14');

    // The flute is the right answer.
    let session = await world.session(3630);
    assert.ok(await world.event(session, 363, 'start', NANARIN), 'Nanarin accepts the help');
    assert.equal(await world.event(session, 363, 'flute', NANARIN), false,
        'no prop is handed out before the townspeople are asked');

    await world.talk(session, ADVISERS[2]);
    assert.equal(world.state(session, 363).getInt('cond'), 2, 'any adviser answers');
    await world.talk(session, ADVISERS[4]);
    assert.equal(world.state(session, 363).getInt('cond'), 2, 'a second adviser adds nothing');

    assert.deepEqual((await world.links(session, NANARIN, 363)).sort(), ['beer', 'clothes', 'flute'],
        'Nanarin offers all three props');
    assert.ok(await world.event(session, 363, 'flute', NANARIN), 'Nanarin takes the flute on stage');
    assert.equal(await world.amount(3630, NANARIN_FLUTE), 1, 'the flute is handed over');
    assert.equal(world.state(session, 363).getInt('cond'), 3, 'the prop advances the errand');

    // A second prop cannot be taken.
    assert.equal(await world.event(session, 363, 'beer', NANARIN), false, 'only one prop is chosen');
    assert.equal(await world.amount(3630, BLACK_BEER), 0, 'no second prop is handed out');

    session = await world.reopen(3630);
    await world.talk(session, BARBADO);
    assert.equal(world.state(session, 363).getInt('cond'), 4, 'Barbado reports back');
    assert.equal(world.state(session, 363).getInt('success'), 1, 'the flute is recorded as a success');
    assert.equal(await world.amount(3630, NANARIN_FLUTE), 0, 'Barbado takes the prop');

    await world.talk(session, NANARIN);
    assert.equal(await world.amount(3630, THEME_OF_SOLITUDE), 1, 'a success pays the Theme of Solitude');
    assert.equal(world.state(session, 363).state, 'created', 'Q363 is repeatable');

    // The beer is the wrong answer, and pays nothing.
    const wrong = await world.session(3631);
    await world.event(wrong, 363, 'start', NANARIN);
    await world.talk(wrong, ADVISERS[0]);
    await world.event(wrong, 363, 'beer', NANARIN);
    assert.equal(await world.amount(3631, BLACK_BEER), 1, 'the beer is handed over');
    await world.talk(wrong, BARBADO);
    assert.equal(world.state(wrong, 363).getInt('success'), 0, 'the beer is recorded as a failure');
    assert.equal(await world.amount(3631, BLACK_BEER), 0, 'Barbado takes the wrong prop too');
    await world.talk(wrong, NANARIN);
    assert.equal(await world.amount(3631, THEME_OF_SOLITUDE), 0, 'a failure pays nothing');
    assert.equal(world.state(wrong, 363).state, 'created', 'a failed run is still repeatable');
}

async function jovialAccordion(world) {
    // Both chests yield, both articles are returned: the hundred adena is paid.
    let session = await world.session(3640);
    assert.ok(await world.event(session, 364, 'start', BARBADO), 'Barbado accepts the help');
    assert.equal(await world.event(session, 364, 'beer', BEER_CHEST), false,
        'a chest cannot be opened without a key');

    await world.event(session, 364, 'keys', SWAN);
    assert.equal(await world.amount(3640, CLOTH_KEY), 1, 'Swan hands over the cloth key');
    assert.equal(await world.amount(3640, BEER_KEY), 1, 'Swan hands over the beer key');
    assert.equal(world.state(session, 364).getInt('cond'), 2, 'the keys advance the errand');

    await withRandom([0.49], () => world.event(session, 364, 'beer', BEER_CHEST));
    assert.equal(await world.amount(3640, STOLEN_BEER), 1, 'the beer chest yields below its half chance');
    assert.equal(await world.amount(3640, BEER_KEY), 0, 'the key is spent');

    await withRandom([0.49], () => world.event(session, 364, 'cloth', CLOTH_CHEST));
    assert.equal(await world.amount(3640, STOLEN_CLOTHES), 1, 'the cloth chest yields too');

    // A spent key cannot open the chest again.
    await withRandom([0], () => world.event(session, 364, 'beer', BEER_CHEST));
    assert.equal(await world.amount(3640, STOLEN_BEER), 1, 'a spent key opens nothing');

    await world.talk(session, SABRIN);
    assert.equal(await world.amount(3640, STOLEN_BEER), 0, 'Sabrin takes his beer back');
    await world.talk(session, XABER);
    assert.equal(await world.amount(3640, STOLEN_CLOTHES), 0, 'Xaber takes his clothes back');
    assert.equal(world.state(session, 364).getInt('items'), 2, 'both articles are recorded');

    session = await world.reopen(3640);
    await world.talk(session, SWAN);
    assert.equal(await world.amount(3640, ADENA), 100, 'recovering both pays exactly 100 adena');
    assert.equal(world.state(session, 364).getInt('cond'), 3, 'Swan sends you to Barbado');

    await world.talk(session, BARBADO);
    assert.equal(await world.amount(3640, THEME_OF_FEAST), 1, 'Barbado pays the Theme of the Feast');
    assert.equal(world.state(session, 364).state, 'created', 'Q364 is repeatable');

    // Exactly one article recovered: the score is paid, the hundred adena is not.
    const partial = await world.session(3641);
    await world.event(partial, 364, 'start', BARBADO);
    await world.event(partial, 364, 'keys', SWAN);
    await withRandom([0.5], () => world.event(partial, 364, 'beer', BEER_CHEST));
    assert.equal(await world.amount(3641, STOLEN_BEER), 0, 'the beer chest is empty at exactly a half');
    await withRandom([0], () => world.event(partial, 364, 'cloth', CLOTH_CHEST));
    await world.talk(partial, XABER);
    await world.talk(partial, SWAN);
    assert.equal(await world.amount(3641, ADENA), 0, 'one article pays no adena');
    assert.equal(world.state(partial, 364).getInt('cond'), 3, 'one article still advances');
    await world.talk(partial, BARBADO);
    assert.equal(await world.amount(3641, THEME_OF_FEAST), 1, 'one article still earns the score');

    // Nothing recovered and no keys left: the errand simply fails.
    const failed = await world.session(3642);
    await world.event(failed, 364, 'start', BARBADO);
    await world.event(failed, 364, 'keys', SWAN);
    await withRandom([0.9], () => world.event(failed, 364, 'beer', BEER_CHEST));
    await world.talk(failed, SWAN);
    assert.equal(world.state(failed, 364).isStarted(), true, 'one key left keeps the errand alive');
    await withRandom([0.9], () => world.event(failed, 364, 'cloth', CLOTH_CHEST));
    await world.talk(failed, SWAN);
    assert.equal(world.state(failed, 364).state, 'created', 'no keys and nothing found ends the errand');
    assert.equal(await world.amount(3642, THEME_OF_FEAST), 0, 'a failed errand pays nothing');
}

async function fantasyWine(world) {
    const young = await world.session(3791);
    assert.equal(await world.event(young, 379, 'start', HARLAN), false, 'Q379 refuses level 19');

    const session = await world.session(3790);
    assert.ok(await world.event(session, 379, 'start', HARLAN), 'Harlan accepts a level 20 gatherer');

    // Both ingredients drop on every kill and stop at their own totals.
    for (let i = 0; i < 80; i++) await world.kill(session, ENKU_CHAMPION);
    assert.equal(await world.amount(3790, LEAF), 80, 'eighty leaves are collected');
    await world.kill(session, ENKU_CHAMPION);
    assert.equal(await world.amount(3790, LEAF), 80, 'the leaf count stops at eighty');

    for (let i = 0; i < 100; i++) await world.kill(session, ENKU_SHAMAN);
    assert.equal(await world.amount(3790, STONE), 100, 'a hundred stones are collected');
    await world.kill(session, ENKU_SHAMAN);
    assert.equal(await world.amount(3790, STONE), 100, 'the stone count stops at a hundred');
    assert.equal(world.state(session, 379).getInt('cond'), 2, 'both totals advance the quest');

    // The reference rolls getRandom(10): under 3, under 9, otherwise.
    await withRandom([0.29], () => world.talk(session, HARLAN));
    assert.equal(await world.amount(3790, WINE_15), 1, 'a roll under three tenths pours the 15 year wine');
    assert.equal(await world.amount(3790, LEAF), 0, 'the leaves are consumed');
    assert.equal(await world.amount(3790, STONE), 0, 'the stones are consumed');
    assert.equal(world.state(session, 379).state, 'created', 'Q379 is repeatable');

    for (const [roll, wine, label] of [[0.31, WINE_30, '30 year'], [0.91, WINE_60, '60 year']]) {
        let run = await world.session(3790);
        assert.ok(await world.event(run, 379, 'start', HARLAN), `${label}: the gathering can be retaken`);
        await Service.giveItem(run, LEAF, 80);
        await Service.giveItem(run, STONE, 100);
        run = await world.session(3790);
        await withRandom([roll], () => world.talk(run, HARLAN));
        assert.equal(await world.amount(3790, wine), 1, `a roll of ${roll} pours the ${label} wine`);
        assert.equal(await world.amount(3790, LEAF), 0, `${label}: the leaves are consumed`);
    }
}

// Every score Ranspo can reach, and the three sums he cannot.
async function magnificentFeast(world) {
    const WINE_FOR = { 1: [WINE_15, 'wine15'], 2: [WINE_30, 'wine30'], 4: [WINE_60, 'wine60'] };
    const FOOD_FOR = { 8: [SALAD_RECIPE, 'salad'], 16: [SAUCE_RECIPE, 'sauce'], 32: [STEAK_RECIPE, 'steak'] };
    const EXPECTED = {
        9: [847, 1, 5700], 10: [846, 2, 0], 12: [909, 1, 25400],
        17: [846, 2, 1200], 18: [879, 1, 6900], 20: [890, 2, 8500],
        33: [879, 1, 8100], 34: [910, 1, 0], 36: [848, 1, 2200]
    };

    const young = await world.session(37700);
    assert.equal(await world.event(young, 378, 'start', RANSPO), false, 'Q378 refuses level 19');

    for (const [wineScore, [wineItem, wineEvent]] of Object.entries(WINE_FOR)) {
        for (const [foodScore, [foodItem, foodEvent]] of Object.entries(FOOD_FOR)) {
            const score = Number(wineScore) + Number(foodScore);
            const id = 37800 + score;
            const session = await world.session(id);
            await Service.giveItem(session, wineItem, 1);
            await Service.giveItem(session, THEME_OF_FEAST, 1);
            await Service.giveItem(session, foodItem, 1);
            await Service.giveItem(session, RITRON_DESSERT, 1);
            const stocked = await world.session(id);

            assert.ok(await world.event(stocked, 378, 'start', RANSPO), `score ${score}: Ranspo accepts`);
            assert.ok(await world.event(stocked, 378, wineEvent, RANSPO), `score ${score}: the wine is poured`);
            assert.equal(await world.amount(id, wineItem), 0, `score ${score}: the wine is consumed`);
            assert.equal(world.state(stocked, 378).getInt('score'), Number(wineScore),
                `score ${score}: the wine contributes ${wineScore}`);

            assert.ok(await world.event(stocked, 378, 'score', RANSPO), `score ${score}: the music is handed over`);
            assert.equal(await world.amount(id, THEME_OF_FEAST), 0, `score ${score}: the score is consumed`);
            assert.equal(world.state(stocked, 378).getInt('score'), Number(wineScore),
                `score ${score}: the musical score contributes nothing`);

            assert.ok(await world.event(stocked, 378, foodEvent, RANSPO), `score ${score}: the food is chosen`);
            assert.equal(await world.amount(id, foodItem), 0, `score ${score}: the recipe is consumed`);
            assert.equal(world.state(stocked, 378).getInt('score'), score,
                `score ${score}: the total is exactly ${score}`);

            await world.talk(stocked, RANSPO);
            const [item, amount, adena] = EXPECTED[score];
            assert.equal(await world.amount(id, item), amount,
                `score ${score}: pays ${amount} of item ${item}`);
            assert.equal(await world.amount(id, ADENA), adena, `score ${score}: pays ${adena} adena`);
            assert.equal(await world.amount(id, RITRON_DESSERT), 0, `score ${score}: the dessert is consumed`);
            assert.equal(world.state(stocked, 378).state, 'created', `score ${score}: Q378 is repeatable`);
        }
    }

    // Only those nine sums exist: 1/2/4 plus 8/16/32 can never reach 11, 19 or 35.
    const reachable = new Set(Object.keys(EXPECTED).map(Number));
    for (const impossible of [11, 19, 35]) {
        assert.equal(reachable.has(impossible), false, `no menu can total ${impossible}`);
    }
}

// Q379 pours the wine and Q364 writes the score; Q378 consumes what they made.
async function fullChain(world) {
    const id = 37701;
    let session = await world.session(id);

    await world.event(session, 379, 'start', HARLAN);
    await Service.giveItem(session, LEAF, 80);
    await Service.giveItem(session, STONE, 100);
    session = await world.session(id);
    await withRandom([0.91], () => world.talk(session, HARLAN));
    assert.equal(await world.amount(id, WINE_60), 1, 'Q379 produced the 60 year wine');

    await world.event(session, 364, 'start', BARBADO);
    await world.event(session, 364, 'keys', SWAN);
    await withRandom([0], () => world.event(session, 364, 'beer', BEER_CHEST));
    await world.talk(session, SABRIN);
    await world.talk(session, SWAN);
    await world.talk(session, BARBADO);
    assert.equal(await world.amount(id, THEME_OF_FEAST), 1, 'Q364 produced the Theme of the Feast');

    await Service.giveItem(session, STEAK_RECIPE, 1);
    await Service.giveItem(session, RITRON_DESSERT, 1);
    session = await world.session(id);

    await world.event(session, 378, 'start', RANSPO);
    await world.event(session, 378, 'wine60', RANSPO);
    await world.event(session, 378, 'score', RANSPO);
    await world.event(session, 378, 'steak', RANSPO);
    assert.equal(world.state(session, 378).getInt('score'), 36, 'the chain reaches the top score');

    const adenaBefore = await world.amount(id, ADENA);
    await world.talk(session, RANSPO);
    assert.equal(await world.amount(id, 848), 1, 'the banquet pays the Enchanted Earring');
    assert.equal(await world.amount(id, ADENA), adenaBefore + 2200, 'and exactly 2200 adena');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
