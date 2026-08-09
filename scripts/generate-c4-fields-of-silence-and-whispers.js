const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const mp = [27, 44, 62, 85, 109, 135, 157, 168, 177, 183, 187, 189];
const power = [122, 279, 584, 1110, 1923, 3030, 4336, 5002, 5632, 6187, 6632, 6978];

const result = generateC4MonsterLocation({
    slug: 'c4_fields_of_silence_and_whispers',
    sourcePrefixes: ['innadril08_2323_'],
    displayName: 'Fields of Silence and Whispers',
    areaId: 'c4-fields-of-silence-and-whispers',
    mobIds: [804, 805, 806, 807, 808, 991],
    spawnRows: 243,
    respawn: 60,
    respawnByMob: { 991: 80 },
    skillRows: 24,
    dropRows: 98,
    missingItemIds: [],
    skillTemplates: [{
        selfId: 4228,
        template: { name: 'Double Dagger Attack', passive: false, spell: false, distance: 700 },
        time: { hitTime: 4000, reuse: 17000, buff: 0 },
        levels: mp.map((value, index) => ({
            level: index + 1, power: power[index], mp: value,
            hp: 0, itemId: 0, itemCount: 0
        }))
    }]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
