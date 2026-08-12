const activeSkills = require('../../../../../data/Skills/Active/active.json');

const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

const ADMIN_BUFF_DURATION_MS = 20 * 60 * 1000;

const COMMON_BUFFS = [
    [1035, 4], // Mental Shield
    [1036, 2], // Magic Barrier
    [1040, 3], // Shield
    [1045, 4], // Bless the Body
    [1048, 4], // Bless the Soul
    [1204, 2]  // Wind Walk
];

const PROFILES = {
    melee: [
        ...COMMON_BUFFS,
        [1044, 3], // Regeneration
        [1062, 2], // Berserker Spirit
        [1068, 3], // Might
        [1077, 3], // Focus
        [1086, 2], // Haste
        [1240, 3], // Guidance
        [1242, 3], // Death Whisper
        [1268, 4]  // Vampiric Rage
    ],
    mage: [
        ...COMMON_BUFFS,
        [1059, 3], // Empower
        [1062, 2], // Berserker Spirit
        [1078, 6], // Concentration
        [1085, 3], // Acumen
        [1303, 2]  // Wild Magic
    ]
};

function profileForActor(actor) {
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

function adminFullBuff(session) {
    const actor = session?.actor;
    if (!actor) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return [];
    }

    const profile = profileForActor(actor);
    const applied = applyProfile(session, actor, profile);
    session.dataSendToMe(ServerResponse.speak(actor, {
        kind: 0,
        text: `Admin: ${profile === 'mage' ? 'Mage' : 'Fighter'} full buff applied (${applied.length} effects, 20 minutes).`
    }));
    return applied;
}

adminFullBuff.ADMIN_BUFF_DURATION_MS = ADMIN_BUFF_DURATION_MS;
adminFullBuff.PROFILES = PROFILES;
adminFullBuff.profileForActor = profileForActor;
adminFullBuff.skillData = skillData;
adminFullBuff.effectFromSkill = effectFromSkill;
adminFullBuff.applyProfile = applyProfile;

module.exports = adminFullBuff;
