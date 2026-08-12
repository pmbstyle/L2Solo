const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ClassProgression = invoke('GameServer/ClassProgression');
const SummonControl = invoke('GameServer/Npc/SummonControl');
const activeSkills = C4SkillRules.expandSourcedLevels(require('../../../../../data/Skills/Active/active.json'));

const ADMIN_BUFF_DURATION_MS = 20 * 60 * 1000;

const COMMON_BUFFS = [
    [1035, 4], // Mental Shield
    [1036, 2], // Magic Barrier
    [1040, 3], // Shield
    [1045, 6], // Bless the Body
    [1048, 6], // Bless the Soul
    [1204, 2]  // Wind Walk
];

const PHYSICAL_BUFFS = [
    [1062, 2], // Berserker Spirit
    [1068, 3], // Might
    [1077, 3], // Focus
    [1086, 2], // Haste
    [1240, 3], // Guidance
    [1242, 3], // Death Whisper
    [1268, 4]  // Vampiric Rage
];

const MAGE_BUFFS = [
    [1059, 3], // Empower
    [1062, 2], // Berserker Spirit
    [1078, 6], // Concentration
    [1085, 3], // Acumen
    [1303, 2]  // Wild Magic
];

const PROFILES = {
    melee: [
        ...COMMON_BUFFS,
        ...PHYSICAL_BUFFS,
        [1356, 1], // Prophecy of Fire
        [264, 1],  // Song of Earth
        [269, 1],  // Song of Hunter
        [271, 1],  // Dance of Warrior
        [274, 1],  // Dance of Fire
        [275, 1],  // Dance of Fury
        [310, 1]   // Dance of Vampire
    ],
    dagger: [
        ...COMMON_BUFFS,
        ...PHYSICAL_BUFFS,
        [1357, 1], // Prophecy of Wind
        [266, 1],  // Song of Water
        [269, 1],  // Song of Hunter
        [271, 1],  // Dance of Warrior
        [272, 1],  // Dance of Inspiration
        [274, 1],  // Dance of Fire
        [275, 1]   // Dance of Fury
    ],
    archer: [
        ...COMMON_BUFFS,
        ...PHYSICAL_BUFFS.filter(([selfId]) => selfId !== 1268),
        [1357, 1], // Prophecy of Wind
        [264, 1],  // Song of Earth
        [267, 1],  // Song of Warding
        [268, 1],  // Song of Wind
        [269, 1],  // Song of Hunter
        [271, 1],  // Dance of Warrior
        [274, 1],  // Dance of Fire
        [275, 1]   // Dance of Fury
    ],
    tank: [
        ...COMMON_BUFFS,
        [1068, 3], // Might
        [1086, 2], // Haste
        [1240, 3], // Guidance
        [1268, 4], // Vampiric Rage
        [1243, 6], // Bless Shield
        [1259, 4], // Resist Shock
        [1356, 1], // Prophecy of Fire
        [264, 1],  // Song of Earth
        [267, 1],  // Song of Warding
        [304, 1],  // Song of Vitality
        [305, 1],  // Song of Vengeance
        [271, 1],  // Dance of Warrior
        [275, 1],  // Dance of Fury
        [310, 1]   // Dance of Vampire
    ],
    mage: [
        ...COMMON_BUFFS,
        ...MAGE_BUFFS,
        [1355, 1], // Prophecy of Water
        [264, 1],  // Song of Earth
        [267, 1],  // Song of Warding
        [304, 1],  // Song of Vitality
        [349, 1],  // Song of Renewal
        [363, 1],  // Song of Meditation
        [273, 1],  // Dance of Mystic
        [276, 1],  // Dance of Concentration
        [365, 1]   // Dance of Siren
    ],
    support: [
        ...COMMON_BUFFS,
        ...MAGE_BUFFS.filter(([selfId]) => selfId !== 1303),
        [1259, 4], // Resist Shock
        [1352, 1], // Elemental Protection
        [1354, 1], // Arcane Protection
        [1355, 1], // Prophecy of Water
        [264, 1],  // Song of Earth
        [267, 1],  // Song of Warding
        [304, 1],  // Song of Vitality
        [349, 1],  // Song of Renewal
        [363, 1],  // Song of Meditation
        [276, 1]   // Dance of Concentration
    ],
    summoner: [],
    servitor: [
        ...COMMON_BUFFS,
        [1068, 3], // Might
        [1077, 3], // Focus
        [1086, 2], // Haste
        [1240, 3], // Guidance
        [1242, 3], // Death Whisper
        [1268, 4], // Vampiric Rage
        [1059, 3], // Empower
        [1085, 3], // Acumen
        [264, 1],  // Song of Earth
        [267, 1],  // Song of Warding
        [269, 1],  // Song of Hunter
        [271, 1],  // Dance of Warrior
        [274, 1],  // Dance of Fire
        [275, 1]   // Dance of Fury
    ]
};
PROFILES.summoner = [...PROFILES.mage];

const CLASS_PROFILES = Object.freeze({
    tank: new Set([4, 5, 6, 19, 20, 32, 33]),
    dagger: new Set([7, 8, 23, 35, 36]),
    archer: new Set([9, 22, 24, 37]),
    summoner: new Set([14, 28, 41]),
    mage: new Set([10, 11, 12, 13, 25, 26, 27, 38, 39, 40]),
    support: new Set([15, 16, 17, 29, 30, 42, 43, 49, 50, 51, 52])
});

function sourceClassId(actor) {
    const classId = Number(actor?.fetchClassId?.() ?? actor?.classId);
    if (!Number.isInteger(classId) || classId < 0) return null;
    return Number(ClassProgression.getThirdClass(classId)?.parentClassId ?? classId);
}

function profileForActor(actor) {
    const classId = sourceClassId(actor);
    if (classId !== null) {
        const matched = Object.entries(CLASS_PROFILES).find(([, classes]) => classes.has(classId));
        if (matched) return matched[0];
    }
    return actor?.isSpellcaster?.() ? 'mage' : 'melee';
}

function skillData(selfId, level) {
    const source = activeSkills.find((skill) => Number(skill.selfId) === Number(selfId));
    if (!source) return null;

    const levelData = source.levels.find((row) => Number(row.level) === Number(level));
    if (!levelData) return null;

    return {
        selfId: source.selfId,
        name: source.template.name,
        passive: source.template.passive,
        spell: source.template.spell,
        distance: source.template.distance,
        buff: source.time.buff,
        ...levelData
    };
}

function effectFromSkill(skill, expiresAt) {
    const semantic = C4SkillRules.resolve(skill);
    return {
        key: semantic.effect || C4SkillRules.normalizeKey(skill.name),
        id: skill.selfId,
        level: skill.level,
        name: skill.name,
        type: semantic.effectType || 'buff',
        category: semantic.effectTrait || semantic.trait || semantic.effect || 'buff',
        stackFamily: semantic.stackFamily,
        stackOrder: semantic.stackOrder,
        stats: semantic.stats || {},
        dispellable: semantic.dispellable !== false,
        expiresAt
    };
}

function refreshActor(session, actor, Generics = invoke(path.actor)) {
    Generics.calculateStats(session, actor);
    actor.statusUpdateVitals(actor);
    session.dataSendToMe(ServerResponse.userInfo(actor));
    session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(actor));
    session.dataSendToMe(ServerResponse.shortBuffStatusUpdate.fromActor(actor));

    try {
        invoke('GameServer/Bot/AI/PartyCompanionService').updateActorEffects(session);
    } catch (err) {
        utils.infoWarn('Admin', 'party effect refresh failed: %s', err.message);
    }
}

function refreshSummon(session, summon) {
    session.dataSendToMe?.(ServerResponse.partySpelled.fromActor(summon, 1));
    session.dataSendToMe?.(ServerResponse.petStatusUpdate(summon));
    session.dataSendToMeAndOthers?.(ServerResponse.npcInfo(summon), summon);
}

function applyProfile(session, actor, profile, options = {}) {
    const entries = PROFILES[profile];
    if (!actor || !entries) return [];

    const expiresAt = Number(options.expiresAt) || Date.now() + ADMIN_BUFF_DURATION_MS;
    if (!actor.activeBuffs) actor.activeBuffs = {};

    const applied = entries.map(([selfId, level]) => {
        const skill = skillData(selfId, level);
        if (!skill) {
            utils.infoWarn('Admin', 'full buff skill %s level %s is missing from active skills', selfId, level);
            return null;
        }

        const effect = EffectStore.apply(actor, effectFromSkill(skill, expiresAt));
        if (!effect) return null;

        actor.activeBuffs[effect.key] = expiresAt;
        if (options.scheduleExpiry !== false) {
            EffectTicker.scheduleExpiry(session, actor, effect);
        }
        return effect;
    }).filter(Boolean);

    if (options.refresh !== false) {
        refreshActor(session, actor, options.Generics);
    }
    return applied;
}

function applyFullBuff(session, actor, options = {}) {
    const profile = profileForActor(actor);
    const expiresAt = Number(options.expiresAt) || Date.now() + ADMIN_BUFF_DURATION_MS;
    const applied = applyProfile(session, actor, profile, { ...options, expiresAt });
    const summon = SummonControl.activeSummon(actor);
    const summonApplied = summon
        ? applyProfile(session, summon, 'servitor', { ...options, expiresAt, refresh: false })
        : [];

    if (summon && options.refresh !== false) refreshSummon(session, summon);
    return { profile, applied, summon, summonApplied };
}

function adminFullBuff(session) {
    const actor = session?.actor;
    if (!actor) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return [];
    }

    const result = applyFullBuff(session, actor);
    const summonText = result.summonApplied.length ? ` + servitor ${result.summonApplied.length}` : '';
    session.dataSendToMe(ServerResponse.speak(actor, {
        kind: 0,
        text: `Admin: ${result.profile} full buff applied (${result.applied.length}${summonText} effects, 20 minutes).`
    }));
    return result.applied;
}

adminFullBuff.ADMIN_BUFF_DURATION_MS = ADMIN_BUFF_DURATION_MS;
adminFullBuff.PROFILES = PROFILES;
adminFullBuff.profileForActor = profileForActor;
adminFullBuff.sourceClassId = sourceClassId;
adminFullBuff.skillData = skillData;
adminFullBuff.effectFromSkill = effectFromSkill;
adminFullBuff.applyProfile = applyProfile;
adminFullBuff.applyFullBuff = applyFullBuff;
adminFullBuff.refreshSummon = refreshSummon;

module.exports = adminFullBuff;
