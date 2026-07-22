const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const GearSkillHints = invoke('GameServer/Bot/AI/GearSkillHints');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const BotClassProgression = invoke('GameServer/Bot/BotClassProgression');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const SeedPlanner = invoke('GameServer/Bot/Population/PopulationSeedPlanner');

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

const CRAFT_SERVICE_PROFILE = { race: 4, classId: 57, sex: 0, role: 'crafter', serviceCrafter: true };
const CRAFT_SERVICE_COUNT = CraftShopService.CraftStations.length;
const CRAFT_SERVICE_INDEX_BASE = 10000;

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

function baseForIndex(index) {
    return pick(index, CLASS_POOL);
}

function profileForIndex(index, base = baseForIndex(index), seedProfile = null) {
    if (base.serviceCrafter) {
        return { level: 70, band: 'craft_service' };
    }
    if (seedProfile?.level) {
        return {
            level: Math.max(1, Number(seedProfile.level)),
            band: seedProfile.band || 'population_wave'
        };
    }
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

function awardProfileSkills(characterId, classId, level) {
    const targetLevel = Math.max(1, Number(level) || 1);
    if (targetLevel <= 1) return Promise.resolve();
    return BotClassProgression.reconcile({ characterId, classId, level: targetLevel });
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

function ensureBaseLoadout(characterId, classId, adena, level = 1) {
    return awardBaseGear(characterId, classId)
        .then(() => awardBaseSkills(characterId, classId))
        .then(() => awardProfileSkills(characterId, classId, level))
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

function ensureCharacter(username, index, base = baseForIndex(index), seedProfile = null) {
    return Database.fetchCharacters(username).then((characters) => {
        if (characters[0]) {
            const character = characters[0];
            const profile = profileForIndex(index, base, seedProfile);
            const level = base.serviceCrafter ? profile.level : Number(character.level || profile.level);
            const adena = Number(character.adena || Math.round(level * 85));
            const classId = base.serviceCrafter ? base.classId : character.classId;
            const classChanged = Number(character.classId) !== Number(classId);
            const classReady = classChanged
                ? Database.deleteSkills(character.id).then(() => Database.updateCharacterClassId(character.id, classId))
                : Promise.resolve();
            const levelReady = base.serviceCrafter
                ? classReady.then(() => Database.updateCharacterExperience(character.id, level, expForLevel(level), Math.round(level * level * 3)))
                : classReady;
            return levelReady
                .then(() => ensureBaseLoadout(character.id, classId, adena, level))
                .then(() => ({
                    character: base.serviceCrafter
                        ? { ...character, classId, level, adena, exp: expForLevel(level), sp: Math.round(level * level * 3) }
                        : { ...character, adena },
                    created: false,
                    base
                }));
        }

        const template = classInfo(base.classId);
        const levelProfile = profileForIndex(index, base, seedProfile);
        const level = levelProfile.level;
        const spot = seedProfile?.spot || targetSpot(level, index, base);
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
            return Database.updateCharacterExperience(character.id, level, character.exp, character.sp)
                .then(() => ensureBaseLoadout(character.id, base.classId, character.adena, level))
                .then(() => ({ character, created: true, base, spot, levelProfile, vitals, loc }));
        });
    });
}

function stateFor(character, index, seedMeta = {}) {
    const base = seedMeta.base || baseForIndex(index);
    const classId = Number(character.classId || base.classId);
    const levelProfile = seedMeta.levelProfile || profileForIndex(index, base, seedMeta.seedProfile);
    const level = Number(character.level || levelProfile.level);
    const spot = base.serviceCrafter ? null : seedMeta.spot || targetSpot(level, index, { ...base, classId });
    const loc = seedMeta.loc || randomNear(spot?.center || {
        locX: character.locX,
        locY: character.locY,
        locZ: character.locZ
    }, index);
    const vitals = seedMeta.vitals || vitalsFor(classInfo(base.classId), level);
    const now = Date.now();
    const shotPlan = ShotStock.planFor({ classId, rank: 'none' });

    const initial = {
        characterId: Number(character.id),
        accountName: character.username || usernameFor(index),
        name: character.name || nameFor(index),
        level,
        exp: Number(character.exp || expForLevel(level)),
        sp: Number(character.sp || Math.round(level * level * 3)),
        adena: Number(character.adena || Math.round(level * 85)),
        phase: 'cold',
        activity: base.serviceCrafter ? 'crafting' : 'hunting',
        homeRegion: 'Wandering',
        currentRegion: base.serviceCrafter ? 'Giran' : 'Wandering',
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
            build: GearSkillHints.forCharacter({ classId, level }, { role: base.role }),
            classProgressionLevel: level,
            classProgressionClassId: classId,
            generatedCold: true,
            generatedIndex: index,
            levelBand: levelProfile.band,
            populationWave: seedMeta.populationWave || null
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
    if (!base.serviceCrafter) return initial;

    const craftShop = CraftShopService.profileFor(initial);
    return {
        ...initial,
        loc: { ...craftShop.loc },
        stats: { ...initial.stats, craftStationId: craftShop.stationId, craftShop }
    };
}

function craftServiceSeedState(existingState, seedState) {
    if (existingState) {
        // Preserve lifecycle (especially an active hot actor), but never retain
        // the old Artisan/level-20 profile that predates public craft services.
        return {
            state: {
                ...existingState,
                level: seedState.level,
                exp: seedState.exp,
                sp: seedState.sp,
                activity: 'crafting',
                currentRegion: 'Giran',
                stats: { ...(existingState.stats || {}), ...(seedState.stats || {}) }
            },
            shouldSeedState: !existingState.stats?.craftShop
        };
    }
    return {
        state: seedState,
        shouldSeedState: true
    };
}

function sameLoc(left, right) {
    return ['locX', 'locY', 'locZ'].every((key) => Number(left?.[key]) === Number(right?.[key]));
}

function sameRecipeEntries(left = [], right = []) {
    const recipeIds = (entries) => (entries || []).map((entry) => Number(entry.recipeId)).filter(Number.isFinite).sort((a, b) => a - b);
    const leftIds = recipeIds(left);
    const rightIds = recipeIds(right);
    return leftIds.length === rightIds.length && leftIds.every((recipeId, index) => recipeId === rightIds[index]);
}

const GeneratedColdSeeder = {
    running: false,
    // Millisecond-based slots keep generated accounts distinct across a
    // restart; the base-36 form still fits the sixteen-character account name.
    nextPopulationIndex: Date.now(),

    awardProfileSkills,
    craftServiceSeedState,

    ensureCraftServices() {
        let created = 0;
        let seeded = 0;
        let chain = Promise.resolve();
        for (let slot = 0; slot < CRAFT_SERVICE_COUNT; slot++) {
            const index = CRAFT_SERVICE_INDEX_BASE + slot;
            const username = `bot_craft_${String(slot + 1).padStart(2, '0')}`;
            chain = chain.then(() => ensureAccount(username))
                .then(() => ensureCharacter(username, index, CRAFT_SERVICE_PROFILE))
                .then((result) => LifeState.findByCharacterId(result.character.id).then((existingState) => {
                    // The normal population seed repeats while it fills the target.
                    // Never turn an already-hot service back into a cold database
                    // row merely because that background seeding pass ran again.
                    const seedState = stateFor(result.character, index, { ...result, base: CRAFT_SERVICE_PROFILE });
                    const { state, shouldSeedState } = craftServiceSeedState(existingState, seedState);
                    // The account slot is the durable station identity.  Do not
                    // let a previously rotated craftStationId keep this service
                    // at the wrong physical stall forever.
                    const craftShop = CraftShopService.profileFor({
                        ...state,
                        stats: { ...(state.stats || {}), craftStationId: CraftShopService.stationForSlot(slot).id }
                    });
                    const needsStationRefresh = existingState?.stats?.craftStationId !== craftShop.stationId
                        || existingState?.stats?.craftShop?.stationId !== craftShop.stationId
                        || !sameLoc(existingState?.stats?.craftShop?.loc, craftShop.loc)
                        || !sameRecipeEntries(existingState?.stats?.craftShop?.entries, craftShop.entries)
                        || (existingState?.phase === 'cold' && !sameLoc(existingState?.loc, craftShop.loc));
                    const needsServiceProfile = Number(existingState?.level || 0) !== Number(state.level)
                        || Number(existingState?.stats?.classId || 0) !== Number(state.stats?.classId || 0)
                        || existingState?.activity !== 'crafting'
                        || existingState?.currentRegion !== 'Giran';
                    return CraftShopService.ensureRecipes(state.characterId, craftShop)
                        .then(() => (shouldSeedState || needsStationRefresh || needsServiceProfile
                            ? LifeState.upsertState({
                                ...state,
                                loc: state.phase === 'cold' ? { ...craftShop.loc } : state.loc,
                                stats: { ...(state.stats || {}), craftStationId: craftShop.stationId, craftShop }
                            }, 'generated_craft_service')
                            : state))
                        .then((saved) => {
                            if (saved && result.created) created += 1;
                            if (saved && shouldSeedState) seeded += 1;
                            return saved;
                        });
                }));
        }
        return chain.then(() => ({ created, seeded }));
    },

    seedPopulation() {
        const limit = Math.max(0, Number(Config.maxPlayingPopulation || 0));
        if (!limit || this.running) return Promise.resolve({ created: 0, seeded: 0, total: 0, limit });

        this.running = true;
        return Promise.resolve().then(() => {
            const plan = SeedPlanner.plan(
                SpotProfiles.ensure(),
                LifeState.allStates(limit + 100),
                limit,
                Config.initialStarterPopulation
            );
            const batch = plan.missing.slice(0, SeedPlanner.seedBatchSize(plan, Config.generatedColdBatchSize));
            let created = 0;
            let seeded = 0;
            let chain = Promise.resolve();

            batch.forEach((spot) => {
                const index = this.nextPopulationIndex++;
                const username = `bot_pop_${index.toString(36)}`.slice(0, 16);
                const seedProfile = {
                    spot,
                    level: Math.max(1, Number(spot.minLevel || 1)),
                    band: `wave_${plan.maxMobLevel}`
                };
                chain = chain.then(() => ensureAccount(username)
                    .then(() => ensureCharacter(username, index, baseForIndex(index), seedProfile))
                    .then((result) => {
                        const state = stateFor(result.character, index, {
                            ...result,
                            seedProfile,
                            populationWave: plan.maxMobLevel,
                            spot,
                            loc: result.loc || randomNear(spot.center, index)
                        });
                        return LifeState.upsertState(state, 'population_wave_seed').then((saved) => {
                            if (saved && result.created) created += 1;
                            if (saved) seeded += 1;
                            return saved;
                        });
                    }));
            });

            return chain.then(() => this.ensureCraftServices()).then((services) => ({
                created: created + services.created,
                seeded,
                total: plan.playing + seeded,
                limit,
                averageLevel: plan.averageLevel,
                maxMobLevel: plan.maxMobLevel,
                eligible: plan.eligible.length,
                remaining: Math.max(0, plan.missing.length - seeded)
            }));
        }).catch((err) => {
            utils.infoWarn('BotSeed', 'generated cold seed failed: %s', err.message);
            return { created: 0, seeded: 0, total: 0, limit, error: err.message };
        }).finally(() => {
            this.running = false;
        });
    },

    // Compatibility for callers outside PopulationService. The old target was
    // a one-shot count; the server now always follows the staged population cap.
    seedToTarget() {
        return this.seedPopulation();
    }
};

module.exports = GeneratedColdSeeder;
