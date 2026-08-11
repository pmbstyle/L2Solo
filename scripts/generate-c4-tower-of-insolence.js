const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_tower_of_insolence',
    sourcePrefixes: ['aden28_2318_', 'aden29_2318_', 'aden34_2318_', 'aden35_2318_', 'aden36_2318_', 'aden37_2318_', 'aden38_2318_', 'aden39_2318_', 'aden40_2318_', 'aden41_2318_'],
    displayName: 'Tower of Insolence', areaId: 'c4-tower-of-insolence',
    mobIds: [812,813,815,816,817,818,819,820,821,822,823,824,825,826,827,828,829,830,831,977,980,983,1061,1062,1064,1065,1066,1067,1069,1070,1072,1075,1078,1081],
    spawnRows: 424, respawn: 230,
    respawnByMob: {812:165,813:165,815:165,816:180,817:180,818:165,819:165,820:180,821:165,822:180,823:210,824:190,825:190,826:210,827:210,828:249,829:249,830:249,831:250,977:200,980:220,983:300,1061:190,1067:250,1069:230,1070:250,1072:250,1075:200,1078:300,1081:300},
    skillRows: 242, dropRows: 473,
    missingItemIds: [4927, 4958, 4975, 4980, 4982, 4984, 4985, 4990, 5000, 5001, 5005]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
