'use strict';
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
const path = require('node:path');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Rates = invoke('GameServer/ProgressionRates');
const Formulas = invoke('GameServer/Formulas');
const Drops = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const original = { npcs: Data.npcs, rewards: Data.npcRewards, items: Data.items,
    rate: process.env.L2NODE_PROGRESSION_RATE, roll: Rates.rewardGroupRoll };
const lower = 990181, higher = 990182, itemId = 990183;
const mob = (selfId, level, name) => ({ selfId, template: { level, name, kind: 'Monster' } });
const reward = selfId => ({ selfId, rewards: [
    { overall: 70, items: [{ selfId: 57, chance: 100, min: 100, max: 100 }] },
    { overall: 100, items: [{ selfId: itemId, chance: 100, min: 10, max: 10 }] }
], spoils: [{ overall: 100, items: [{ selfId: itemId, chance: 100, min: 1, max: 1 }] }] });
const spot = (id, entries) => ({ id, avgLevel: 99, npcEntries: entries });
const blue = spot('S', [{ selfId: lower, count: 3 }]);
const near = spot('T', [{ selfId: higher, count: 1 }]);
const mixed = spot('mixed', [...blue.npcEntries, ...near.npcEntries]);
const close = (a, b, message) => assert(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${message}: ${a} != ${b}`);
try {
    Data.npcs = [...Data.npcs, mob(lower, 18, 'Exact Low Mob'), mob(higher, 30, 'Exact High Mob')];
    Data.npcRewards = [...Data.npcRewards, reward(lower), reward(higher)];
    Data.items = [...Data.items, { selfId: itemId, template: { price: 4, kind: 'Other.Material' } }];
    useRate('x1');
    close(Rewards.value(blue, 26).adena, 70, 'no drop penalty through eight levels');
    close(Rewards.value(blue, 27).adena, 70 * .91 / 3, 'the NPC level, not avgLevel 99, activates gap-nine penalty');
    close(Rewards.value(blue, 33).adena, 70 * .37 / 3, 'gap-fifteen native Adena');
    close(Rewards.value(blue, 33).drop, 20 * .37 / 3, 'gap-fifteen native normal drop');
    assert.equal(Rewards.value(blue, 33).spoil, 0, 'no learned Spoil means no spoil income');
    const landing = Formulas.spoilSuccessChance({ skillId: 254, skillLevel: 1, attackerLevel: 33, targetLevel: 18 });
    close(Rewards.value(blue, 33, { spoilSkillLevel: 1 }).spoil, 2 * .37 / 3 * landing,
        'spoil includes both the reward penalty and native skill landing');
    const lo = Rewards.value(blue, 33), hi = Rewards.value(near, 33), mix = Rewards.value(mixed, 33);
    for (const key of ['adena', 'drop', 'spoil']) close(mix[key], (lo[key] * 3 + hi[key]) / 4,
        'each NPC gets its own penalty before spawn-weighted aggregation');

    useRate('x50');
    const highRate = Rewards.value(blue, 33, { spoilSkillLevel: 1 });
    close(highRate.adena, .7 * .37 / 3 * 3500, 'high-rate Adena chance divides by drop rate, amount retains base rate');
    close(highRate.drop, 1000, 'normal drop chance saturates while base-rate quantity survives Deep Blue');
    close(highRate.spoil, 2 * (50 * .37 / 3) * landing, 'spoil quantity uses its penalized rate');
    assert.notEqual(highRate.drop, lo.drop * 50, 'an x1 reward curve cannot predict saturated high-rate loot');

    // Same combat measurements, now backed by concrete native rewards. The table
    // ends at the deep-blue gap where drops fall to 30% (user 10-29): level 27 on an 18 spot.
    const at = 18 + Rates.DEEP_BLUE_LEVEL_GAP;
    const tableRate = Rewards.value(blue, at, { spoilSkillLevel: 1 });
    useRate('x1');
    const tableLow = Rewards.value(blue, at);
    useRate('x50');
    Table.useFile(path.join(__dirname, 'fixtures/spot_table.json'));
    Table.useSpots([blue, near]);
    const row = Table.value('S', 'dps', at);
    close(row.adena, row.kills * tableRate.adena, 'table keeps measured throughput but exact per-kill Adena');
    close(row.loot, row.kills * tableRate.drop, 'dps cannot receive spoil');
    const trained = Table.value('S', 'spoiler', at, true, { spoilSkillLevel: 1 });
    const untrained = Table.value('S', 'spoiler', at, true, { spoilSkillLevel: 0 });
    close(trained.spoilLoot, trained.kills * tableRate.spoil, 'table respects learned skill rank');
    assert.equal(untrained.spoilLoot, 0, 'skill rank is part of the table memo key');
    const nativeValue = Rewards.value;
    let forecasts = 0;
    try {
        Rewards.value = (...args) => { forecasts++; return nativeValue(...args); };
        Table.useFile(path.join(__dirname, 'fixtures/spot_table.json'));
        Table.rankedIncome('dps', at, { shots: 0, potions: 0 }, -100, true);
        const firstForecasts = forecasts;
        assert(firstForecasts > 0, 'the first price ranking builds native unpriced forecasts');
        Table.rankedIncome('dps', at, { shots: 1, potions: 0 }, -100, true);
        assert.equal(forecasts, firstForecasts,
            'a price-only ranking reuses unpriced spot forecasts rather than rebuilding rewards');
    } finally { Rewards.value = nativeValue; }
    const Income = invoke('GameServer/Bot/Population/PartyIncomeComparison');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const savedMatch = Match.spotMatchup, savedCosts = Hunt.consumablePrices;
    try {
        Match.spotMatchup = () => ({ eligible: true });
        Hunt.consumablePrices = () => ({ shots: 0, potions: 0 });
        const spoiler = { characterId: 990190, level: 20, spotId: 'S', stats: { classId: 54, role: 'spoiler',
            coldCombat: { skills: [{ selfId: 254, level: 1 }] } } };
        const fighter = { characterId: 990191, level: at, spotId: 'S', stats: { classId: 0, role: 'dps' } };
        const prepared = Income.prepare([spoiler, fighter], { spots: [blue, near],
            party: { spotId: 'S', cohesion: 1 }, timestamp: 1791656778971 });
        const personal = prepared.rows.get(spoiler.characterId);
        const partyYield = Rewards.value(blue, at, { spoilSkillLevel: 1, spoilerLevel: 20 });
        close(personal.income, personal.kills * ((partyYield.adena + partyYield.drop) / 2 + partyYield.spoil),
            'party spoil uses the older killer penalty and the actual spoiler skill, retaining personal spoil');
        const secondSpoiler = { ...spoiler, characterId: 990192 };
        const two = Income.prepare([spoiler, secondSpoiler, fighter], { spots: [blue, near],
            party: { spotId: 'S', cohesion: 1 }, timestamp: 1791656778971 });
        const second = two.rows.get(secondSpoiler.characterId);
        close(second.income, second.kills * (partyYield.adena + partyYield.drop) / 3,
            'only the first native party spoiler receives spoil; two spoilers do not duplicate income');
    } finally { Match.spotMatchup = savedMatch; Hunt.consumablePrices = savedCosts; }
    useRate('x1');
    close(Table.value('S', 'dps', at).loot, row.kills * tableLow.drop, 'rate change invalidates table value memo');
    useRate('x50');
    Table.rankedIncome('dps', at, { shots: 0, potions: 0 }, -100, true);
    useRate('x1');
    Table.best('dps', at);
    const reranked = Table.rankedIncome('dps', at, { shots: 0, potions: 0 }, -100, true).find(row => row.spotId === 'S');
    close(reranked.loot, reranked.kills * tableLow.drop,
        'a best-row review after a rate change cannot retain an older priced or unpriced ranking');
    useRate('x50');

    let calls = 0;
    Rates.rewardGroupRoll = (...args) => { calls++; return original.roll(...args); };
    const warm = Rewards.value(blue, 33, { spoilSkillLevel: 1 });
    const firstCalls = calls;
    warm.drop = -1;
    for (let i = 0; i < 1000; i++) assert(Rewards.value(blue, 33, { spoilSkillLevel: 1 }).drop > 0);
    assert.equal(calls, firstCalls, 'warm values do not inspect reward groups again');
    const alternate = spot('same-npc-another-camp', blue.npcEntries);
    Rewards.value(alternate, 33, { spoilSkillLevel: 1 });
    assert.equal(calls, firstCalls, 'NPC penalty cells are shared across camps');
    Rates.rewardGroupRoll = original.roll;

    // Compare forecasts to independent native reward rolls, including high-rate
    // category selection and spoil landing. No combat simulator enters planning.
    let seed = 123456;
    const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (const rate of ['x1', 'x10', 'x50']) {
        useRate(rate);
        for (const gap of [8, 9, 15]) {
            const level = 18 + gap, expected = Rewards.value(blue, level, { spoilSkillLevel: 1 });
            const sum = { adena: 0, drop: 0, spoil: 0 }, trials = 30000;
            for (let i = 0; i < trials; i++) {
                const gained = Drops.rollRewardsForFight({ spot: blue, killerLevel: level, npcSelfId: lower, rng });
                sum.adena += gained.adena; sum.drop += Hunt.lootValue(gained.items);
                if (Formulas.calcSpoilSuccess({ skillId: 254, skillLevel: 1, attackerLevel: level, targetLevel: 18 }, rng))
                    sum.spoil += Hunt.lootValue(Drops.rollSpoilForFight({ spot: blue, killerLevel: level, npcSelfId: lower, rng }));
            }
            for (const key of Object.keys(sum)) assert(Math.abs(sum[key] / trials - expected[key])
                <= Math.max(.03, expected[key] * .045), `native ${rate} gap ${gap} ${key} differs from exact expectation`);
        }
    }
    // Replacing datapack arrays must invalidate both prepared groups and values.
    useRate('x1');
    const before = Rewards.value(blue, 26).drop;
    const tableBefore = Table.value('S', 'dps', 26).loot;
    Data.items = Data.items.map(item => item.selfId === itemId ? { ...item, template: { ...item.template, price: 8 } } : item);
    close(Rewards.value(blue, 26).drop, before * 2, 'catalog revision invalidates reward prices');
    close(Table.value('S', 'dps', 26).loot, tableBefore * 2, 'catalog revision also invalidates outer table memo');
    Table.useFile(); Table.useSpots([]);
    // T43 table: '-2_3' (level 9, NPCs 328/385/386 as the gone '-8_6') has a mage no-shot row.
    const authored = Table.value('-2_3', 'mage', 18, false);
    assert(authored?.loot > 0 && authored.rewardSource === 'npc_rewards',
        'standalone lookup has concrete NPC reward data in the compact catalog');
    let actual = [spot('-2_3', [{ selfId: lower, count: 1 }])];
    Table.useSpots(() => actual);
    const overridden = Table.value('-2_3', 'mage', 18, false);
    close(overridden.loot, overridden.kills * Rewards.value(actual[0], 18).drop,
        'actual period NPCs override the authored fallback');
    actual = [spot('-2_3', [{ selfId: higher, count: 1 }])];
    const replaced = Table.value('-2_3', 'mage', 18, false);
    close(replaced.loot, replaced.kills * Rewards.value(actual[0], 18).drop,
        'replacing a same-size period catalog invalidates the outer money memo');
    const alias = spot('native-id-alias', [{ selfId: 5038, count: 1 }]);
    const namedAlias = { ...alias, npcNames: [Data.npcs.find(npc => npc.selfId === 5038).template.name] };
    const aliasValue = Rewards.value(alias, 40), namedValue = Rewards.value(namedAlias, 40);
    assert(namedValue.drop > 0, 'native Cat\'s Eye Bandit alias has a concrete reward');
    for (const key of ['adena', 'drop', 'spoil']) close(aliasValue[key], namedValue[key],
        'compact NPC catalog preserves the native name mapping when spawn and reward IDs differ');
    console.log('PASS exact NPC rewards: gap 8/9/15, x1/x10/x50, mixed mobs, learned spoil, native-roll parity and shared bounded caches');
} finally {
    Data.npcs = original.npcs; Data.npcRewards = original.rewards; Data.items = original.items;
    Rates.rewardGroupRoll = original.roll;
    useRate(original.rate);
    Table.useFile(); Table.useSpots([]);
}
