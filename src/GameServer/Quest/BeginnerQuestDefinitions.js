// Reviewed C4 beginner hunting quests (Q257, Q260, Q265, Q273, Q293).
//
// All five are repeatable village bounties that also carry the shared
// beginner-shot reward: the character-wide counter must still be 0, the grant is
// paid at most once per quest, and the Orc-mystic exclusion follows the
// reference's `isMageClass() && race != ORC`. See GameServer/Quest/BeginnerReward.
//
// Facts from the pinned MOBIUS_C4 6674a607 handlers. NPC ids are L2Solo native
// datapack ids (reference id - 23000); mob ids are reference id - 20000.
// Adena bonuses use the reference's ordinary reward mode, not its optional
// ALT_VILLAGES_REPEATABLE_QUEST_REWARD village setting.

// The hunting group grants the beginner shots only while the counter is still 0.
const beginnerBounty = receiptKey => ({
    threshold: 1, soulshots: 6000, spiritshots: 3000, orcUsesSoulshots: true, receiptKey
});
// Q273 and Q293 are race-locked to Orc and Dwarf and only ever pay soulshots.
const beginnerSoulshotsOnly = receiptKey => ({
    threshold: 1, soulshots: 6000, spiritshots: 0, receiptKey
});

module.exports = [
    // Gilbert pays for Gludio's orc and werewolf trophies.
    { id: 257, name: 'The Guard is Busy', minLevel: 6, startNpc: 7039, repeatable: true,
        startItems: [[1084, 1]], questItems: [1084, 752, 1085, 1086],
        beginnerReward: beginnerBounty('newbie_shots'),
        stages: [{ type: 'COLLECT', npc: 7039,
            prices: [[752, 10], [1085, 20], [1086, 20]],
            bonuses: [{ items: [752, 1085, 1086], at: 10, adena: 1000 }],
            drops: [
                { npc: 6, item: 752, chance: .5 }, { npc: 130, item: 752, chance: .5 },
                { npc: 131, item: 752, chance: .5 },
                { npc: 93, item: 1085, chance: .5 }, { npc: 96, item: 1085, chance: .5 },
                { npc: 98, item: 1085, chance: .5 },
                { npc: 342, item: 1086, chance: .2 }] }] },

    // Rayen pays Elves for Kaboo orc trophies.
    { id: 260, name: 'Orc Hunting', minLevel: 6, race: 1, startNpc: 7221, repeatable: true,
        questItems: [1114, 1115], beginnerReward: beginnerBounty('newbie_shots'),
        stages: [{ type: 'COLLECT', npc: 7221,
            prices: [[1114, 12], [1115, 30]],
            bonuses: [{ items: [1114, 1115], at: 10, adena: 1000 }],
            drops: [
                { npc: 468, item: 1114, chance: .5 }, { npc: 469, item: 1114, chance: .5 },
                { npc: 470, item: 1114, chance: .5 },
                { npc: 471, item: 1115, chance: .5 }, { npc: 472, item: 1115, chance: .5 },
                { npc: 473, item: 1115, chance: .5 }] }] },

    // Kristin pays Dark Elves for the shackles of escaped slaves.
    { id: 265, name: 'Bonds of Slavery', minLevel: 6, race: 2, startNpc: 7357, repeatable: true,
        questItems: [1368], beginnerReward: beginnerBounty('newbie_shots'),
        stages: [{ type: 'COLLECT', npc: 7357,
            prices: [[1368, 12]],
            bonuses: [{ items: [1368], at: 10, adena: 500 }],
            drops: [{ npc: 4, item: 1368, chance: .5 }, { npc: 5, item: 1368, chance: .6 }] }] },

    // Varkees pays Orcs for soulstones. Every kill yields one of the two stones;
    // the reference rolls black first and falls through to red.
    { id: 273, name: 'Invaders of the Holy Land', minLevel: 6, race: 3, startNpc: 7566, repeatable: true,
        questItems: [1475, 1476], beginnerReward: beginnerSoulshotsOnly('newbie_shots'),
        stages: [{ type: 'COLLECT', npc: 7566,
            prices: [[1475, 3], [1476, 10]],
            bonuses: [
                { items: [1475], at: 10, adena: 1500 },
                { items: [1475], at: 10, adena: 300, and: { items: [1476], at: 1 } }],
            drops: [
                { npc: 311, chance: 1, outcomes: [{ item: 1475, chance: .91 }, { item: 1476, chance: .09 }] },
                { npc: 312, chance: 1, outcomes: [{ item: 1475, chance: .88 }, { item: 1476, chance: .12 }] },
                { npc: 313, chance: 1, outcomes: [{ item: 1475, chance: .78 }, { item: 1476, chance: .22 }] }] }] },

    // Filaur pays Dwarves for ore; Chinchirin assembles four torn fragments into
    // one hidden vein map, which is worth far more.
    { id: 293, name: 'The Hidden Veins', minLevel: 6, race: 4, startNpc: 7535, repeatable: true,
        questItems: [1488, 1489, 1490], beginnerReward: beginnerSoulshotsOnly('newbie_shots'),
        exchanges: [{ npc: 7539, event: 'map', cond: 1, label: 'Assemble the torn map fragments.',
            takes: [[1489, 4]], gives: [[1490, 1]] }],
        stages: [{ type: 'COLLECT', npc: 7535,
            prices: [[1488, 5], [1490, 500]],
            bonuses: [
                { items: [1488], at: 10, adena: 2000 },
                { items: [1490], at: 10, adena: 2000 }],
            drops: [446, 447, 448].map(npc => ({ npc, chance: 1, outcomes: [
                { item: 1488, chance: .49 }, { item: 1489, chance: .05 }] })) }] }
];
