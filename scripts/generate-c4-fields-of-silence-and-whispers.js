const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const mp = [27, 44, 62, 85, 109, 135, 157, 168, 177, 183, 187, 189];
const power = [122, 279, 584, 1110, 1923, 3030, 4336, 5002, 5632, 6187, 6632, 6978];

const result = generateC4MonsterLocation({
    slug: 'c4_fields_of_silence_and_whispers',
    sourcePrefixes: ['innadril03_2223_', 'innadril04_2224_', 'innadril08_2323_'],
    displayName: 'Fields of Silence and Whispers',
    areaId: 'c4-fields-of-silence-and-whispers',
    mobIds: [
        783, 784, 785, 786, 787, 788, 789, 790, 793,
        804, 805, 806, 807, 808, 989, 991, 1034,
        1638, 1639, 1640, 1641, 1642, 1643, 1644, 1645
    ],
    spawnRows: 957,
    respawn: 25,
    respawnByMob: {
        788: 30, 789: 30, 790: 30, 793: 30,
        804: 60, 805: 60, 806: 60, 807: 60, 808: 60,
        989: 45, 991: 80
    },
    skillRows: 103,
    dropRows: 409,
    missingItemIds: [6667],
    skillTemplates: [
        {
            selfId: 4225,
            template: { name: 'Resist Shock', passive: true, spell: false, distance: -1 },
            time: { hitTime: 0, reuse: 0, buff: 0 },
            levels: Array.from({ length: 6 }, (_, index) => ({
                level: index + 1, power: 0, mp: 0, hp: 0, itemId: 0, itemCount: 0
            }))
        },
        {
            selfId: 4228,
            template: { name: 'Double Dagger Attack', passive: false, spell: false, distance: 700 },
            time: { hitTime: 4000, reuse: 17000, buff: 0 },
            levels: mp.map((value, index) => ({
                level: index + 1, power: power[index], mp: value,
                hp: 0, itemId: 0, itemCount: 0
            }))
        }
    ]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
