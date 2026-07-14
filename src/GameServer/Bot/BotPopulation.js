const STARTER_REGIONS = [
    {
        code: 'ti',
        name: 'Talking Island',
        spawnClassId: 0,
        locals: [
            { name: 'Aldren', race: 0, classId: 0, sex: 0 },
            { name: 'Brinna', race: 0, classId: 0, sex: 1 },
            { name: 'Cedric', race: 0, classId: 0, sex: 0 },
            { name: 'Darian', race: 0, classId: 0, sex: 0 },
            { name: 'Elena', race: 0, classId: 10, sex: 1 },
            { name: 'Merek', race: 0, classId: 10, sex: 0 },
            { name: 'Rona', race: 0, classId: 0, sex: 1 },
            { name: 'Serra', race: 0, classId: 10, sex: 1 }
        ],
        visitors: [
            { name: 'Tovin', race: 4, classId: 53, sex: 0 },
            { name: 'Elandor', race: 1, classId: 18, sex: 0 }
        ],
        apprentices: [
            { name: 'Nolan', race: 0, classId: 0, sex: 0 },
            { name: 'Mina', race: 0, classId: 0, sex: 1 },
            { name: 'Perrin', race: 0, classId: 10, sex: 0 }
        ]
    },
    {
        code: 'elf',
        name: 'Elven Village',
        spawnClassId: 18,
        locals: [
            { name: 'Aelwyn', race: 1, classId: 18, sex: 1 },
            { name: 'Faelar', race: 1, classId: 18, sex: 0 },
            { name: 'Ilyana', race: 1, classId: 25, sex: 1 },
            { name: 'Liora', race: 1, classId: 25, sex: 1 },
            { name: 'Meriel', race: 1, classId: 18, sex: 1 },
            { name: 'Naeris', race: 1, classId: 25, sex: 0 },
            { name: 'Saelen', race: 1, classId: 18, sex: 0 },
            { name: 'Velion', race: 1, classId: 18, sex: 0 }
        ],
        visitors: [
            { name: 'Borik', race: 4, classId: 53, sex: 0 },
            { name: 'Rowan', race: 0, classId: 0, sex: 0 }
        ],
        apprentices: [
            { name: 'Eirlys', race: 1, classId: 18, sex: 1 },
            { name: 'Thalion', race: 1, classId: 18, sex: 0 },
            { name: 'Syla', race: 1, classId: 25, sex: 1 }
        ]
    },
    {
        code: 'de',
        name: 'Dark Elven Village',
        spawnClassId: 31,
        locals: [
            { name: 'Draven', race: 2, classId: 31, sex: 0 },
            { name: 'Ilyra', race: 2, classId: 38, sex: 1 },
            { name: 'Kaelith', race: 2, classId: 31, sex: 0 },
            { name: 'Lethar', race: 2, classId: 31, sex: 0 },
            { name: 'Morwen', race: 2, classId: 38, sex: 1 },
            { name: 'Nyssa', race: 2, classId: 38, sex: 1 },
            { name: 'Raelis', race: 2, classId: 31, sex: 1 },
            { name: 'Vorn', race: 2, classId: 31, sex: 0 }
        ],
        visitors: [
            { name: 'Korrin', race: 4, classId: 53, sex: 0 },
            { name: 'Selwyn', race: 1, classId: 18, sex: 1 }
        ],
        apprentices: [
            { name: 'Velyra', race: 2, classId: 31, sex: 1 },
            { name: 'Kaelis', race: 2, classId: 31, sex: 0 },
            { name: 'Sindra', race: 2, classId: 38, sex: 1 }
        ]
    },
    {
        code: 'orc',
        name: 'Orc Village',
        spawnClassId: 44,
        locals: [
            { name: 'Brugar', race: 3, classId: 44, sex: 0 },
            { name: 'Dargul', race: 3, classId: 44, sex: 0 },
            { name: 'Groma', race: 3, classId: 49, sex: 1 },
            { name: 'Harka', race: 3, classId: 44, sex: 1 },
            { name: 'Kasha', race: 3, classId: 49, sex: 1 },
            { name: 'Mogar', race: 3, classId: 44, sex: 0 },
            { name: 'Ogra', race: 3, classId: 44, sex: 1 },
            { name: 'Urta', race: 3, classId: 49, sex: 0 }
        ],
        visitors: [
            { name: 'Hedin', race: 4, classId: 53, sex: 0 },
            { name: 'Calder', race: 0, classId: 0, sex: 0 }
        ],
        apprentices: [
            { name: 'Rugor', race: 3, classId: 44, sex: 0 },
            { name: 'Varka', race: 3, classId: 49, sex: 1 },
            { name: 'Targu', race: 3, classId: 44, sex: 0 }
        ]
    },
    {
        code: 'dwarf',
        name: 'Dwarven Village',
        spawnClassId: 53,
        locals: [
            { name: 'Bordin', race: 4, classId: 53, sex: 0 },
            { name: 'Dagna', race: 4, classId: 53, sex: 1 },
            { name: 'Gerta', race: 4, classId: 53, sex: 1 },
            { name: 'Hilda', race: 4, classId: 53, sex: 1 },
            { name: 'Kurgan', race: 4, classId: 53, sex: 0 },
            { name: 'Milla', race: 4, classId: 53, sex: 1 },
            { name: 'Norik', race: 4, classId: 53, sex: 0 },
            { name: 'Toma', race: 4, classId: 53, sex: 0 }
        ],
        visitors: [
            { name: 'Jalen', race: 0, classId: 0, sex: 0 },
            { name: 'Aerin', race: 1, classId: 25, sex: 1 }
        ],
        apprentices: [
            { name: 'Berta', race: 4, classId: 53, sex: 1 },
            { name: 'Keld', race: 4, classId: 53, sex: 0 },
            { name: 'Tirga', race: 4, classId: 53, sex: 1 }
        ]
    }
];

const PkProfiles = invoke('GameServer/Bot/AI/PkProfiles');

function appearance(seed, sex) {
    return {
        sex,
        face: seed % 3,
        hair: seed % 5,
        hairColor: seed % 4
    };
}

function botRecord(region, data, index, visitor) {
    return {
        ...data,
        ...appearance(index, data.sex),
        username: `bot_${region.code}_${String(index + 1).padStart(2, '0')}`,
        homeRegion: region.name,
        spawnClassId: visitor ? region.spawnClassId : data.classId,
        visitor: !!visitor,
        newbieAnchor: !!data.newbieAnchor,
        plan: 'hunting'
    };
}

const BotPopulation = {
    buildStarterBots() {
        const bots = [];

        STARTER_REGIONS.forEach((region) => {
            region.locals.forEach((data, index) => {
                bots.push(botRecord(region, data, index, false));
            });

            region.visitors.forEach((data, index) => {
                bots.push(botRecord(region, data, region.locals.length + index, true));
            });

            (region.apprentices || []).forEach((data, index) => {
                bots.push(botRecord(
                    region,
                    { ...data, newbieAnchor: true },
                    region.locals.length + region.visitors.length + index,
                    false
                ));
            });
        });

        PkProfiles.materializeBots().forEach((profileData, index) => {
            const bot = profileData;
            bots.push({ ...profileData, ...appearance(100 + index, bot.sex) });
        });

        return bots;
    },

    summarize(bots) {
        return STARTER_REGIONS
            .map((region) => `${region.name}: ${bots.filter((bot) => bot.homeRegion === region.name).length}`)
            .join(', ');
    },

    pkEncounters(random = Math.random) {
        return PkProfiles.materializeBots(random);
    }
};

module.exports = BotPopulation;
