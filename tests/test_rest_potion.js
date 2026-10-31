'use strict';
// T141 (docs/game-decisions.md "Potions to save rest"): a solo bot drinks a
// healing potion between fights when the rest it saves, at its own hour, is
// worth more than the bottle's NPC price; one rule hot and cold; its potion
// stock buys what the rule drinks.
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const RestPotion = invoke('GameServer/Bot/AI/RestPotion');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const T = 1_750_000_000_000;
const POTION = 1061;
const GLADIATOR = 2, SORCERER = 12;
const originalNpc = Cold.npcForSpot, originalRate = process.env.L2NODE_PROGRESSION_RATE;
useRate('x10');

// A reference bot of the class at 62, its HP and MP shares, its bottles, its
// hour and survival bottles in the stats packet (hour 0: no packet yet). No
// learned skills: a cold round would first cast its self buffs and heals, and
// the hot bot here has none; every bot rule below reads the same numbers.
function bot(classId, { hp = 1, mp = 1, bottles = 10, hour = 600000, keep = 0 } = {}) {
    const state = HuntCycle.referenceState(classId, 62);
    state.stats.coldCombat = { ...state.stats.coldCombat, skills: [] };
    const profile = Cold.profileFor(state, T, { store: false });
    state.characterId = 7000 + classId;
    state.vitals = { hp: profile.maxHp * hp, maxHp: profile.maxHp, mp: profile.maxMp * mp, maxMp: profile.maxMp };
    state.inventory[POTION] = { selfId: POTION, amount: bottles };
    state.stats = { ...state.stats, ...(hour > 0 ? { money: [hour, 1 / hour, 0, 0], stockTargets: [POTION, 0, 0, 0, 0, keep] } : {}) };
    return { state, profile };
}

// The same bot as a hot actor: its regeneration from the cold rest's owner,
// its bag as native items (the edge the rule reads).
function hotBot({ state, profile }) {
    const used = [];
    const items = Object.values(state.inventory).filter(row => row.selfId === POTION).map(row => ({
        fetchSelfId: () => row.selfId, fetchAmount: () => row.amount, fetchId: () => 500 + row.selfId }));
    const regen = (key) => (_, options) => ColdRest.coldRestRegenPerTick(state, { profile, timestamp: T, ...options })[key];
    return { used, effects: {}, fetchHp: () => state.vitals.hp, fetchMaxHp: () => state.vitals.maxHp, fetchMp: () => state.vitals.mp,
        fetchMaxMp: () => state.vitals.maxMp, fetchLevel: () => state.level, fetchClassId: () => state.stats.classId,
        state: { fetchCasts: () => false, fetchDead: () => false }, canUseSkill: () => true,
        automation: { fetchRevHpAmount: regen('hp'), fetchRevMpAmount: regen('mp') },
        backpack: { fetchItems: () => items, fetchItemFromSelfId: id => items.find(item => item.fetchSelfId() === id),
            buildItemSkill: () => ({ fetchSelfId: () => 2032 }), useItem: (_, objectId) => used.push(objectId) } };
}
const hotDrinks = (made) => {
    const actor = hotBot(made);
    const session = { decisionStats: made.state.stats };
    return RestPotion.tryBetweenFights(session, actor) && actor.used.length === 1 && session.lastCombatDecision.reason === 'rest_saved';
};

// One cold round: a mob that dies at the first swing and hurts nobody, so the
// round's gap sees the bot's HP as given.
const spot = { id: 'rest_potion', name: 'Rest potion', minLevel: 62, maxLevel: 62, avgLevel: 62, density: 3,
    rewards: { exp: 1, sp: 0, adenaMin: 0, adenaMax: 0 } };
const round = (state, timestamp = T) => Resolver.resolveSolo({ state: structuredClone(state), spot, elapsedMs: 50, timestamp, rng: () => 0.5 });
const coldDrinks = made => Number(round(made.state).debug.drunkPotions[POTION] || 0) > 0;

try {
    Cold.npcForSpot = () => ({ level: 62, maxHp: 1, pAtk: 1, pAtkRnd: 0, pDef: 1, mDef: 1, accur: 1, evasion: 0, critical: 0, atkSpd: 253 });

    // The worked case: a level-62 Gladiator at x10: 336 HP are about half a
    // minute of its seated rest.
    const example = bot(GLADIATOR);
    const seatedPerSecond = ColdRest.coldRestRegenPerTick(example.state, { profile: example.profile, timestamp: T }).hp / 3;
    const savedHours = 336 / seatedPerSecond / 3600;
    const price = Potions.purchasePotionFor({ level: 62 }).price;
    const breakEven = price / savedHours;

    const cases = [
        ['the rest saved pays for the bottle', { hp: 0.8, hour: breakEven * 1.1 }, true],
        ['the rest saved does not pay for the bottle', { hp: 0.8, hour: breakEven * 0.9 }, false],
        ['it misses less than the bottle heals', { hp: 0.9 }, false],
        ['no packet yet: its hour is unknown', { hp: 0.8, hour: 0 }, false],
        ['the bottles left are the survival drink\'s', { hp: 0.8, bottles: 2, keep: 2 }, false],
        ['one bottle above the survival drink\'s', { hp: 0.8, bottles: 3, keep: 2 }, true],
        ['an empty bag', { hp: 0.8, bottles: 0 }, false]
    ];
    for (const [what, input, drinks] of cases) {
        assert.equal(hotDrinks(bot(GLADIATOR, input)), drinks, `hot: ${what}`);
        assert.equal(coldDrinks(bot(GLADIATOR, input)), drinks, `cold: ${what}`);
    }
    // A bot that sits for mana: its MP holds the rest, the bottle shortens nothing.
    const mana = { hp: 0.6, mp: 0.05 };
    assert.equal(hotDrinks(bot(SORCERER, mana)), false, 'hot: the MP holds the rest');
    assert.equal(coldDrinks(bot(SORCERER, mana)), false, 'cold: the MP holds the rest');
    assert.equal(hotDrinks(bot(SORCERER, { hp: 0.7, mp: 0.9 })), true, 'hot: with its MP nearly full the HP holds the rest');
    assert.equal(coldDrinks(bot(SORCERER, { hp: 0.7, mp: 0.9 })), true, 'cold: with its MP nearly full the HP holds the rest');

    // One bottle at a time: while the last one runs the bot drinks no other,
    // hot by its effect, cold by the saved end.
    const running = bot(GLADIATOR, { hp: 0.8 });
    const busy = hotBot(running);
    busy.effects.healing_potion = { key: 'healing_potion', id: 2032, type: 'buff', expiresAt: Date.now() + 10000 };
    assert.equal(RestPotion.tryBetweenFights({ decisionStats: running.state.stats }, busy), false, 'hot: the bottle runs');
    const first = round(running.state);
    const after = { ...running.state, ...first.patch, vitals: { ...first.patch.vitals, hp: running.state.vitals.hp } };
    assert.deepEqual(round(after, T + 5000).debug.drunkPotions, {}, 'cold: 5 s later the bottle still runs');
    assert.deepEqual(round(after, T + Potions.HOT_MS + 1000).debug.drunkPotions, { [POTION]: 1 }, 'cold: past its 14 s the next one');

    // The rest: a bot below its HP line sits, and hot and cold drink the same
    // bottles, one each 14 s, each of them chosen at the HP the rest has reached.
    const tired = bot(GLADIATOR, { hp: 0.3, bottles: 20 });
    const hotBottles = (() => {
        const walked = bot(GLADIATOR, { hp: 0.3, bottles: 20 });
        let bottles = 0;
        while (RestPotion.betweenFights(hotBot(walked), { stats: walked.state.stats })) {
            bottles += 1;
            walked.state.vitals.hp += 336 + seatedPerSecond * Potions.HOT_MS / 1000;
        }
        return bottles;
    })();
    const rest = round(tired.state);
    assert.equal(rest.patch.activity, 'resting', 'it sits down');
    assert.equal(rest.debug.drunkPotions[POTION], hotBottles, 'the same bottles hot and cold');
    assert(hotBottles >= 3, `a long rest takes several (${hotBottles})`);
    assert(Math.abs(rest.patch.vitals.hp - tired.state.vitals.hp - hotBottles * 336) < 2,
        `the bottles heal, beside the round's standing regeneration (${rest.patch.vitals.hp})`);
    const sitting = { ...tired.state.vitals };
    const dry = round({ ...tired.state, inventory: { ...tired.state.inventory, [POTION]: { selfId: POTION, amount: 0 } } });
    const shortened = dry.patch.stats.restUntil - rest.patch.stats.restUntil;
    assert(Math.abs(shortened - hotBottles * 336 / seatedPerSecond * 1000) < 2000,
        `the rest is shorter by the seconds the bottles saved (${shortened} ms, from ${sitting.hp} HP)`);
    assert(rest.patch.stats.restUntil - T >= hotBottles * Potions.HOT_MS, 'the rest lasts while the bottles run');

    // The potion stock (part 2): a solo hunter at a 0-death spot whose rest HP
    // holds owns the bottles the rule drinks; the survival tranche stays apart.
    const hunter = (adena) => {
        const { state, profile } = bot(GLADIATOR, { hour: 0 });
        return { ...state, adena, inventory: { ...state.inventory, [POTION]: { selfId: POTION, amount: 0 }, 57: { selfId: 57, amount: adena } },
            vitals: { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp } };
    };
    const rich = Economy.basics(hunter(1e7), { timestamp: T });
    const row = rich.bestTable, stock = rich.stock('potions');
    assert.equal(row.deaths, 0, 'the table says no deaths here');
    assert(stock.target > stock.survivalTarget, `it stocks past the survival tranche (${stock.target} over ${stock.survivalTarget})`);
    assert(stock.benefitPerUnit > 0, 'a bottle is worth the rest it saves');
    assert(stock.benefitPerUnit * rich.hourAdena > stock.unitPrice, 'more than it costs');
    const cycle = Table.cycle(rich.bestSpotId, rich.tableRole, 62, rich.hunt.useShots !== false);
    const seconds = cycle.rest * cycle.kph * 2;
    assert(stock.target * 336 / seatedPerSecond < seconds * 1.2,
        `the outing's stock saves no more than the outing's rest (${stock.target} bottles, ${seconds} s)`);
    const wish = Economy.forState(hunter(1e7), { timestamp: T }).network.queue.find(entry => entry.key === 'stock:potions');
    assert(wish?.valueHours > 0, 'the stock is a wish of its own, at 0 deaths too');
    const poor = Economy.basics(hunter(price * 3), { timestamp: T }).stock('potions');
    assert(poor.target <= stock.survivalTarget + 3, `the wallet bounds the stock (${poor.target})`);
    const walletless = Economy.basics(hunter(0), { timestamp: T }).stock('potions');
    assert.equal(walletless.target, Math.ceil(walletless.usePerHour * walletless.targetHours), 'no money, only the survival drink\'s stock');
    // The same rule: a bottle that does not pay adds nothing to the stock.
    const potion = { heal: 336, price };
    const paying = RestPotion.stockUse(hunter(0), { row: cycle, potion, hour: breakEven * 1.1, timestamp: T });
    assert(paying.use > 0 && paying.hours > 0, 'it pays: the stock wants it');
    assert.deepEqual(RestPotion.stockUse(hunter(0), { row: cycle, potion, hour: breakEven * 0.9, timestamp: T }), { use: 0, hours: 0 },
        'it does not pay: no bottles');
    const casterState = { ...bot(SORCERER).state, stats: { classId: SORCERER } };
    assert.deepEqual(RestPotion.stockUse(casterState, { row: { rest: 20, kph: 100, hpLost: 10, mpLost: 110 }, potion, hour: 1e6, timestamp: T }),
        { use: 0, hours: 0 }, 'the rest its MP holds saves no bottle');
    console.log('PASS rest potion');
} finally {
    Cold.npcForSpot = originalNpc;
    useRate(originalRate);
}
