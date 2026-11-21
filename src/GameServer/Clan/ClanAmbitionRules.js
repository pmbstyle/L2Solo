const NPC = Object.freeze({
    gustav: 7760, martien: 7645, fritz: 7761, lutz: 7762, kurtz: 7763, kusto: 7512,
    balthazar: 7764, rodemai: 7868, cleo: 7766, coffer: 7765
});
const MOB = Object.freeze({
    drake: 137, thunder: 243, blitz: 5178, soldier: 654, scout: 656,
    guard: 668, keymaster: 5179, slave: 5180, keeper: 5181
});
const ITEM = Object.freeze({
    recipe: 3838, mist: 3839, blitz: 3840, drake: 3841, thunder: 3842, brooch: 3843,
    crystal: 3844, broken: 3845, stone: 3846, key: 3847, first: 3866, second: 3867,
    third: 3868, scepter: 3869, seal: 3870, coin: 3871
});
const NAMES = {
    [ITEM.recipe]: "Recipe: Titan's Powerstone", [ITEM.mist]: 'Mist Drake Egg',
    [ITEM.blitz]: 'Blitz Wyrm Egg', [ITEM.drake]: 'Drake Egg', [ITEM.thunder]: 'Thunder Wyrm Egg',
    [ITEM.brooch]: 'Brooch of the Magpie', [ITEM.crystal]: 'Nebulite Crystals',
    [ITEM.broken]: "Broken Titan's Powerstone", [ITEM.stone]: "Titan's Powerstone",
    [ITEM.key]: 'Imperial Key', [ITEM.first]: "Gustav's 1st Letter", [ITEM.second]: "Gustav's 2nd Letter",
    [ITEM.third]: "Gustav's 3rd Letter", [ITEM.scepter]: 'Scepter of Judgment',
    [ITEM.seal]: 'Seal of Aspiration', [ITEM.coin]: 'Black Anvil Coin'
};
const EGGS = [ITEM.thunder, ITEM.drake, ITEM.blitz, ITEM.mist].map(id => [id, 10]);
const GOLEM = [[ITEM.stone, 10], [ITEM.crystal, 10]];
const KEYS = 6;
const KEEPER_BANISHMENT = Object.freeze({ locX: 185462, locY: 20342, locZ: -3250 });
const CORPSES = {
    fritz: { npc: NPC.fritz, give: [[ITEM.blitz, 3]], ambush: 2 },
    lutz: { npc: NPC.lutz, give: [[ITEM.blitz, 3], [ITEM.mist, 4]], ambush: 2 },
    kurtz: { npc: NPC.kurtz, give: [[ITEM.mist, 6], [ITEM.brooch, 1]] }
};

// Condition numbers follow the C4 journal. Optional exchanges keep the current condition.
const TALK = {
    start:        { npc: NPC.gustav,    from: [0],       next: 1,  give: [[ITEM.first, 1]], label: 'Accept the commission' },
    meet_martien: { npc: NPC.martien,   from: [1],       next: 2,  take: [[ITEM.first, 1]], label: 'Ask about the dragon eggs' },
    eggs:         { npc: NPC.martien,   from: [2],       next: 3,  take: EGGS, label: 'Deliver the four sets of eggs' },
    coin:         { npc: NPC.kusto,     from: [2, 3, 4],          take: [[ITEM.brooch, 1]], give: [[ITEM.coin, 1]], label: 'Return the brooch to Kusto' },
    second:       { npc: NPC.gustav,    from: [3],       next: 4,  give: [[ITEM.second, 1]], label: 'Receive the second letter' },
    meet_smith:   { npc: NPC.balthazar, from: [4],       next: 5,  take: [[ITEM.second, 1]], label: 'Ask about the golem research' },
    recipe:       { npc: NPC.balthazar, from: [5],                take: [[ITEM.coin, 1]], give: [[ITEM.recipe, 1]], label: 'Exchange the Black Anvil Coin for the recipe' },
    research:     { npc: NPC.balthazar, from: [5],       next: 6,  take: GOLEM, label: 'Deliver the research materials' },
    third:        { npc: NPC.gustav,    from: [6],       next: 7,  give: [[ITEM.third, 1]], label: 'Receive the third letter' },
    meet_rodemai: { npc: NPC.rodemai,   from: [7],       next: 8,  take: [[ITEM.third, 1]], label: 'Ask Rodemai about the scepter' },
    riddle:       { npc: NPC.cleo,      from: [8],       next: 9,  label: 'Listen to Cleo’s riddle' },
    cemetery:     { npc: NPC.rodemai,   from: [9],       next: 10, label: 'Ask Rodemai to explain the riddle' },
    coffer:       { npc: NPC.coffer,    from: [10],      next: 11, take: [[ITEM.key, KEYS]], give: [[ITEM.scepter, 1]], label: 'Use six Imperial Keys' },
    return_scepter: { npc: NPC.rodemai, from: [11],      next: 12, label: 'Tell Rodemai you recovered the scepter' },
    finish:       { npc: NPC.gustav,    from: [11, 12],  next: 13, take: [[ITEM.scepter, 1]], give: [[ITEM.seal, 1]], label: 'Hand over the Scepter of Judgment' },
    restore_seal: { npc: NPC.gustav,    from: [13],               give: [[ITEM.seal, 1]], label: 'Replace my lost Seal of Aspiration' },
    discuss:      { npc: NPC.gustav,    from: [11],      next: 12, label: 'Ask what he intends to do with the scepter' }
};
for (const [event, corpse] of Object.entries(CORPSES)) {
    TALK[event] = { npc: corpse.npc, from: [2], label: 'Search the fallen hunter' };
}
const KILL_NPCS = Object.values(MOB);
const DYNAMIC_NPCS = [MOB.blitz, MOB.keymaster, MOB.slave, NPC.coffer];
const count = (items, id) => items[id] || 0;
const has = (items, required = []) => required.every(([id, amount]) => count(items, id) >= amount);
function canTalkEvent(stage, items, event) {
    const step = Object.hasOwn(TALK, event) ? TALK[event] : null;
    if (event === 'restore_seal' && count(items, ITEM.seal)) return false;
    return Boolean(step?.from.includes(stage) && has(items, step.take));
}

module.exports = { ID: 503, NPC, MOB, ITEM, NAMES, EGGS, GOLEM, KEYS, CORPSES, TALK, KILL_NPCS,
    DYNAMIC_NPCS, KEEPER_BANISHMENT, SP_REWARD: 250000, BOT_MIN_LEVEL: 65, count, has, canTalkEvent };
