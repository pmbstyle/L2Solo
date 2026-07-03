const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

const CLASS_POOL = [
    { race: 0, classId: 0, sex: 0, role: 'dps' },
    { race: 0, classId: 10, sex: 1, role: 'mage' },
    { race: 1, classId: 18, sex: 0, role: 'dps' },
    { race: 1, classId: 25, sex: 1, role: 'mage' },
    { race: 2, classId: 31, sex: 0, role: 'dps' },
    { race: 2, classId: 38, sex: 1, role: 'mage' },
    { race: 3, classId: 44, sex: 0, role: 'dps' },
    { race: 3, classId: 49, sex: 1, role: 'buffer' },
    { race: 4, classId: 53, sex: 0, role: 'dps' }
];

const NAME_STEMS = [
    'Arin', 'Bren', 'Cail', 'Dorin', 'Elen', 'Faren', 'Garin', 'Halen',
    'Irin', 'Joren', 'Kael', 'Lorin', 'Miren', 'Noren', 'Orin', 'Pavel',
    'Quen', 'Ralen', 'Saren', 'Tarin', 'Ulric', 'Varen', 'Welyn', 'Yorin'
];

function pick(index, list) {
    return list[index % list.length];
}

function appearance(index, sex) {
    return {
        sex,
        face: index % 3,
        hair: index % 5,
        hairColor: index % 4
    };
}

function expForLevel(level) {
    const table = DataCache.experience || [];
    return Number(table[Math.max(0, Number(level || 1) - 1)] || 0);
}

function profileForIndex(index) {
    const roll = index % 20;
    if (roll < 2) return { level: 2 + (index % 2), band: 'newbie' };
    if (roll < 11) return { level: 4 + (index % 5), band: 'low' };
    if (roll < 18) return { level: 8 + (index % 5), band: 'main' };
    return { level: 13 + (index % 4), band: 'ahead' };
}

function classInfo(classId) {
    return DataCache.classTemplates.find((template) => template.classId === classId) || null;
}

function vitalsFor(template, level) {
    const base = template?.vitals || {};
    const value = Number(level || 1);
    const maxHp = Math.max(1, Math.round(Number(base.maxHp || 100) + (value - 1) * 34));
    const maxMp = Math.max(1, Math.round(Number(base.maxMp || 50) + (value - 1) * 14));
    return { hp: maxHp, maxHp, mp: maxMp, maxMp };
}

function randomNear(loc, index, radius = 900) {
    const angle = (index * 2.399963229728653) % (Math.PI * 2);
    const dist = 120 + ((index * 97) % radius);
    const locX = Math.round(Number(loc.locX || 0) + Math.cos(angle) * dist);
    const locY = Math.round(Number(loc.locY || 0) + Math.sin(angle) * dist);
    return {
        locX,
        locY,
        locZ: GeodataEngine.getHeight(locX, locY, Number(loc.locZ || 0))
    };
}

function targetSpot(level, index, base = {}) {
    const state = {
        level,
        levelBand: `${Math.max(1, level - 2)}-${level + 2}`,
        stats: {
            role: base.role || 'dps',
            classId: base.classId || null
        }
    };
    const profiles = SpotProfiles.ensure()
        .filter((spot) => spot.minLevel <= level + 3 && spot.maxLevel >= level - 3);
    const guided = LevelingRoutes.rankedSpots(profiles, state, { mode: 'solo' });
    if (guided.length > 0) {
        return guided[index % Math.min(4, guided.length)].spot;
    }

    return profiles
        .sort((a, b) => {
            const aGap = Math.abs(a.avgLevel - level);
            const bGap = Math.abs(b.avgLevel - level);
            if (aGap !== bGap) return aGap - bGap;
            return b.density - a.density;
        })[index % Math.max(1, profiles.length)] || SpotProfiles.ensure()[0] || null;
}

function usernameFor(index) {
    return `bot_scale_${String(index).padStart(4, '0')}`.slice(0, 16);
}

function nameFor(index) {
    return `${pick(index, NAME_STEMS)}${String(index).padStart(3, '0')}`.slice(0, 35);
}

function awardBaseGear(characterId, classId) {
    const items = DataCache.newbieItems.find((row) => row.classId === classId)?.items || [];
    return Database.fetchItems(characterId).then((existing) => {
        const existingIds = new Set((existing || []).map((item) => Number(item.selfId)));
        return Promise.all(items
            .filter((item) => !existingIds.has(Number(item.selfId)))
            .map((item) => {
                const template = DataCache.items.find((row) => row.selfId === item.selfId);
                return Database.setItem(characterId, {
                    ...item,
                    slot: template?.etc?.slot || 0,
                    equipped: true
                });
            }));
    });
}

function awardBaseSkills(characterId, classId) {
    const skillTree = DataCache.skillTree.find((row) => row.classId === classId);
    const skills = skillTree?.skills || [];
    const levelOne = skills.filter((skill) => skill.levels.find((level) => level.pLevel === 1));
    return Database.fetchSkills(characterId).then((existing) => {
        const existingIds = new Set((existing || []).map((skill) => Number(skill.selfId)));
        return Promise.all(levelOne
            .filter((skill) => !existingIds.has(Number(skill.selfId)))
            .map((skill) => {
                const details = DataCache.skills.find((row) => row.selfId === skill.selfId);
                if (!details) return Promise.resolve(null);
                const owned = {
                    ...skill,
                    levels: skill.levels.filter((level) => level.pLevel === 1)
                };
                return Database.setSkill({
                    ...details,
                    ...owned,
                    passive: details.passive ?? owned.passive ?? false,
                    level: 1
                }, characterId);
            }));
    });
}

function ensureAdena(characterId, amount) {
    return Database.fetchItems(characterId).then((existing) => {
        const adena = (existing || []).find((item) => Number(item.selfId) === 57);
        if (adena) return null;
        return Database.setItem(characterId, {
            selfId: 57,
            name: 'Adena',
            amount
        });
    });
}

function ensureBaseLoadout(characterId, classId, adena) {
    return awardBaseGear(characterId, classId)
        .then(() => awardBaseSkills(characterId, classId))
        .then(() => ensureAdena(characterId, adena))
        .then(() => ShotStock.ensureCharacterStock(characterId, {
            classId,
            targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT
        }));
}

function ensureAccount(username) {
    return Database.fetchUserPassword(username).then((rows) => {
        if (rows[0]) return false;
        return Database.createAccount(username, 'botpass').then(() => true);
    });
}

function ensureCharacter(username, index) {
    return Database.fetchCharacters(username).then((characters) => {
        if (characters[0]) {
            const character = characters[0];
            const level = Number(character.level || profileForIndex(index).level);
            const adena = Number(character.adena || Math.round(level * 85));
            return ensureBaseLoadout(character.id, character.classId, adena)
                .then(() => ({ character: { ...character, adena }, created: false }));
        }

        const base = pick(index, CLASS_POOL);
        const template = classInfo(base.classId);
        const levelProfile = profileForIndex(index);
        const level = levelProfile.level;
        const spot = targetSpot(level, index, base);
        const loc = randomNear(spot?.center || { locX: 0, locY: 0, locZ: 0 }, index);
        const vitals = vitalsFor(template, level);
        const charData = {
            name: nameFor(index),
            race: base.race,
            classId: base.classId,
            ...appearance(index, base.sex),
            ...vitals,
            ...loc
        };

        return Database.createCharacter(username, charData).then((packet) => {
            const character = {
                id: Number(packet.insertId),
                username,
                ...charData,
                level,
                exp: expForLevel(level),
                sp: Math.round(level * level * 3),
                adena: Math.round(level * 85)
            };
            return ensureBaseLoadout(character.id, base.classId, character.adena)
                .then(() => ({ character, created: true, base, spot, levelProfile, vitals, loc }));
        });
    });
}

function stateFor(character, index, seedMeta = {}) {
    const base = seedMeta.base || pick(index, CLASS_POOL);
    const classId = Number(character.classId || base.classId);
    const level = Number(character.level || profileForIndex(index).level);
    const spot = seedMeta.spot || targetSpot(level, index, { ...base, classId });
    const loc = seedMeta.loc || randomNear(spot?.center || {
        locX: character.locX,
        locY: character.locY,
        locZ: character.locZ
    }, index);
    const vitals = seedMeta.vitals || vitalsFor(classInfo(base.classId), level);
    const now = Date.now();
    const shotPlan = ShotStock.planFor({ classId, rank: 'none' });

    return {
        characterId: Number(character.id),
        accountName: character.username || usernameFor(index),
        name: character.name || nameFor(index),
        level,
        exp: Number(character.exp || expForLevel(level)),
        sp: Number(character.sp || Math.round(level * level * 3)),
        adena: Number(character.adena || Math.round(level * 85)),
        phase: 'cold',
        activity: 'hunting',
        homeRegion: 'Wandering',
        currentRegion: 'Wandering',
        spotId: spot?.id || null,
        loc,
        vitals,
        levelBand: `${Math.max(1, level - 2)}-${level + 2}`,
        timing: {
            activityStartedAt: now,
            nextResolveAt: now + 30000 + ((index * 7919) % 90000),
            lastResolvedAt: null,
            lastHotAt: null
        },
        party: { partyId: null, role: base.role, leaderId: null },
        stats: {
            role: base.role,
            classId,
            route: spot?.route || null,
            generatedCold: true,
            generatedIndex: index,
            levelBand: profileForIndex(index).band
        },
        inventory: {
            57: {
                selfId: 57,
                name: 'Adena',
                amount: Number(character.adena || Math.round(level * 85))
            },
            [shotPlan.selfId]: {
                selfId: shotPlan.selfId,
                name: shotPlan.name,
                amount: ShotStock.DEFAULT_TARGET_AMOUNT
            }
        }
    };
}

const GeneratedColdSeeder = {
    running: false,

    seedToTarget(target = Config.generatedColdTarget) {
        const desired = Math.max(0, Number(target || 0));
        if (!desired || this.running) return Promise.resolve({ created: 0, desired, total: 0 });

        this.running = true;
        return LifeState.levelHistogram().then((histogram) => {
            const total = Number(histogram.total || 0);
            const needed = Math.max(0, desired - total);
            const batch = Math.min(needed, Config.generatedColdBatchSize);
            if (batch <= 0) return { created: 0, desired, total };

            let created = 0;
            let seeded = 0;
            let chain = Promise.resolve();
            const startIndex = total + 1;

            for (let offset = 0; offset < batch; offset++) {
                const index = startIndex + offset;
                chain = chain.then(() => {
                    const username = usernameFor(index);
                    return ensureAccount(username)
                        .then(() => ensureCharacter(username, index))
                        .then((result) => {
                            const state = stateFor(result.character, index, result);
                            return LifeState.upsertState(state, 'generated_seed').then((saved) => {
                                if (saved && result.created) created += 1;
                                if (saved) seeded += 1;
                                return saved;
                            });
                        });
                });
            }

            return chain.then(() => ({ created, seeded, desired, total: total + seeded }));
        }).catch((err) => {
            utils.infoWarn('BotSeed', 'generated cold seed failed: %s', err.message);
            return { created: 0, seeded: 0, desired, total: 0, error: err.message };
        }).finally(() => {
            this.running = false;
        });
    }
};

module.exports = GeneratedColdSeeder;
