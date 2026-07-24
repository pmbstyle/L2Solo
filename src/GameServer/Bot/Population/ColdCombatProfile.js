const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');

const PROFILE_VERSION = 3;

const WEAPON_MASK_BY_KIND = Object.freeze({
    'Weapon.Sword': 4,
    'Weapon.Blunt': 8,
    'Weapon.Knife': 16,
    'Weapon.Bow': 32,
    'Weapon.Pole': 64,
    'Weapon.Fist': 256,
    'Weapon.Dual': 512,
    'Weapon.DualFist': 1024,
    'Weapon.GreatSword': 2048,
    'Weapon.BigBlunt': 16384
});

function number(value, fallback = 0) {
    const resolved = Number(value);
    return Number.isFinite(resolved) ? resolved : fallback;
}

function classTemplate(classId) {
    return (DataCache.classTemplates || []).find((entry) => Number(entry.classId) === Number(classId)) || {};
}

function itemTemplate(selfId) {
    return (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(selfId)) || null;
}

function equippedTemplates(state = {}) {
    return Object.values(state.inventory || {})
        .filter((item) => item?.equipped)
        .map((item) => itemTemplate(item.selfId))
        .filter(Boolean);
}

function equipmentFromTemplates(items = [], spellcaster = false, fallback = {}) {
    const weapon = items.find((item) => String(item.template?.kind || '').startsWith('Weapon.'));
    const armorAt = (slot) => items.find((item) => Number(item.etc?.slot) === slot && String(item.template?.kind || '').startsWith('Armor.'));
    const armor = items.filter((item) => String(item.template?.kind || '').startsWith('Armor.'));
    const fullBody = armorAt(15);
    const torso = fullBody
        ? number(fullBody.stats?.pDef)
        : number(armorAt(10)?.stats?.pDef, spellcaster ? 15 : 31) + number(armorAt(11)?.stats?.pDef, spellcaster ? 8 : 18);

    return {
        weaponKind: weapon?.template?.kind || fallback.weaponKind || '',
        pAtk: number(weapon?.stats?.pAtk, fallback.pAtk),
        pAtkRnd: number(weapon?.stats?.pAtkRnd, fallback.pAtkRnd),
        mAtk: number(weapon?.stats?.mAtk, fallback.mAtk),
        atkSpd: number(weapon?.stats?.atkSpd, fallback.atkSpd),
        critical: number(weapon?.stats?.crit, fallback.critical),
        accur: number(weapon?.stats?.accur, fallback.accur),
        pDef: number(armorAt(0)?.stats?.pDef) + number(armorAt(6)?.stats?.pDef, 12) + torso
            + number(armorAt(9)?.stats?.pDef, 8) + number(armorAt(12)?.stats?.pDef, 7) + number(armorAt(13)?.stats?.pDef),
        mDef: number(armorAt(3)?.stats?.mDef, 13) + number(armorAt(1)?.stats?.mDef, 9)
            + number(armorAt(2)?.stats?.mDef, 9) + number(armorAt(4)?.stats?.mDef, 5) + number(armorAt(5)?.stats?.mDef, 5),
        evasion: armor.reduce((sum, item) => sum + number(item.stats?.evasion), 0),
        bonusMp: armor.reduce((sum, item) => sum + number(item.stats?.maxMp), 0),
        shieldPDef: number(armorAt(8)?.stats?.pDef),
        shieldRate: number(armorAt(8)?.stats?.shieldRate, armorAt(8) ? 20 : 0),
        armorKinds: armor.map((item) => item.template?.kind).filter(Boolean)
    };
}

function activeEffects(effects = [], timestamp = Date.now()) {
    return effects.filter((effect) => effect && effect.type !== 'debuff' && effect.toggle !== true
        && (!effect.expiresAt || number(effect.expiresAt) > timestamp));
}

function effectStats(effect = {}) {
    const structured = effect.stats || {};
    if (Object.keys(structured).length) return structured;
    const legacy = BuffCatalog.byTypeOrKey(effect.key)
        || Object.values(BuffCatalog.ALL_BUFFS || {}).find((buff) => Number(buff.id) === Number(effect.id));
    return legacy?.stats || structured;
}

function statValues(profile, stat, timestamp) {
    const effectValues = activeEffects(profile.effects, timestamp).map((effect) => number(effectStats(effect)?.[stat], NaN));
    const passiveValues = (profile.skills || [])
        .filter((skill) => skill.passive)
        .map((skill) => C4SkillRules.resolve({ selfId: skill.selfId, level: skill.level }))
        .filter((semantic) => passiveRequirementsMatch(profile, semantic.requires))
        .map((semantic) => number(semantic.stats?.[stat], NaN));
    return [...effectValues, ...passiveValues].filter(Number.isFinite);
}

function passiveRequirementsMatch(profile, requires = {}) {
    if (!requires) return true;
    const weaponMask = WEAPON_MASK_BY_KIND[profile.equipment?.weaponKind] || 0;
    if (requires.weaponsAllowed && (number(requires.weaponsAllowed) & weaponMask) === 0) return false;
    if (requires.weaponKinds && !requires.weaponKinds.includes(profile.equipment?.weaponKind)) return false;
    if (requires.armorKind && !(profile.equipment?.armorKinds || []).includes(requires.armorKind)) return false;
    if (requires.shield && number(profile.equipment?.shieldPDef) <= 0) return false;
    return true;
}

function add(profile, stat, timestamp) {
    return statValues(profile, stat, timestamp).reduce((sum, value) => sum + value, 0);
}

function multiplier(profile, stat, timestamp) {
    return statValues(profile, stat, timestamp).reduce((total, value) => total * value, 1);
}

function effectiveBase(profile, stat, timestamp) {
    return Math.max(1, Math.round((number(profile.base?.[stat.toLowerCase()], 1) + add(profile, stat, timestamp))
        * multiplier(profile, `${stat}Mul`, timestamp)));
}

function skillSnapshot(skill) {
    return {
        selfId: number(skill.fetchSelfId?.()),
        level: number(skill.fetchLevel?.(), 1),
        passive: skill.fetchPassive?.() === true,
        spell: skill.fetchSpell?.() === true,
        power: number(skill.fetchPower?.()),
        mp: number(skill.fetchConsumedMp?.()),
        hp: number(skill.fetchConsumedHp?.()),
        hitTime: number(skill.fetchHitTime?.()),
        reuse: number(skill.fetchReuseTime?.()),
        buffTime: number(skill.fetchBuffTime?.())
    };
}

function skillsFromTree(classId, level) {
    const tree = (DataCache.skillTree || []).find((entry) => Number(entry.classId) === Number(classId));
    return (tree?.skills || []).map((entry) => {
        const learned = (entry.levels || []).filter((row) => number(row.pLevel) <= level).at(-1);
        if (!learned) return null;
        const skill = (DataCache.skills || []).find((candidate) => Number(candidate.selfId) === Number(entry.selfId));
        const definition = (skill?.levels || []).find((row) => number(row.level) === number(learned.level))
            || (skill?.levels || []).filter((row) => number(row.level) <= number(learned.level)).at(-1) || {};
        return {
            selfId: number(entry.selfId), level: number(learned.level, 1), passive: skill?.template?.passive === true,
            spell: definition.spell === true, power: number(definition.power), mp: number(definition.mp), hp: number(definition.hp),
            hitTime: number(definition.hitTime), reuse: number(definition.reuse), buffTime: number(definition.buff)
        };
    }).filter(Boolean);
}

function skillSnapshotsFromRecords(records = []) {
    return records.map((record) => {
        const selfId = number(record.selfId);
        const requestedLevel = number(record.level, 1);
        const skill = (DataCache.skills || []).find((candidate) => Number(candidate.selfId) === selfId);
        if (!skill) return null;
        const definition = (skill.levels || []).find((row) => number(row.level) === requestedLevel)
            || (skill.levels || []).filter((row) => number(row.level) <= requestedLevel).at(-1);
        if (!definition) return null;
        return {
            selfId,
            level: number(definition.level, requestedLevel),
            passive: record.passive === true || skill.template?.passive === true,
            spell: definition.spell === true,
            power: number(definition.power),
            mp: number(definition.mp),
            hp: number(definition.hp),
            hitTime: number(definition.hitTime),
            reuse: number(definition.reuse),
            buffTime: number(definition.buff)
        };
    }).filter(Boolean);
}

function legacySnapshot(state = {}, records = [], timestamp = Date.now()) {
    const existing = state.stats?.coldCombat || {};
    return {
        ...existing,
        version: PROFILE_VERSION,
        skillSource: 'database',
        capturedAt: number(existing.capturedAt, timestamp),
        classId: number(existing.classId, number(state.stats?.classId, number(state.classId))),
        effects: existing.effects || [],
        skills: skillSnapshotsFromRecords(records)
    };
}

function capture(actor, timestamp = Date.now()) {
    const backpack = actor.backpack;
    const equipment = {
        weaponKind: backpack?.fetchTotalWeaponKind?.() || '',
        pAtk: number(backpack?.fetchTotalWeaponPAtk?.(), number(actor.fetchPAtk?.())),
        pAtkRnd: number(backpack?.fetchTotalWeaponPAtkRnd?.()),
        mAtk: number(backpack?.fetchTotalWeaponMAtk?.(), number(actor.fetchMAtk?.())),
        atkSpd: number(backpack?.fetchTotalWeaponAtkSpd?.(), number(actor.fetchAtkSpd?.())),
        critical: number(backpack?.fetchTotalWeaponCritical?.(), number(actor.fetchCritical?.())),
        accur: number(backpack?.fetchTotalWeaponAccur?.(), number(actor.fetchAccur?.())),
        pDef: number(backpack?.fetchTotalArmorPDef?.(actor.isSpellcaster?.()), number(actor.fetchPDef?.())),
        mDef: number(backpack?.fetchTotalArmorMDef?.(), number(actor.fetchMDef?.())),
        evasion: number(backpack?.fetchTotalArmorEvasion?.()),
        bonusMp: number(backpack?.fetchTotalArmorBonusMp?.()),
        shieldPDef: number(backpack?.fetchTotalShieldPDef?.()),
        shieldRate: number(backpack?.fetchTotalShieldRate?.()),
        armorKinds: (backpack?.fetchEquippedArmors?.() || []).map((item) => item.fetchKind?.()).filter(Boolean)
    };
    return {
        version: PROFILE_VERSION,
        skillSource: 'hot',
        capturedAt: timestamp,
        classId: number(actor.fetchClassId?.()),
        base: {
            str: number(actor.fetchStr?.(), 1), dex: number(actor.fetchDex?.(), 1), con: number(actor.fetchCon?.(), 1),
            int: number(actor.fetchInt?.(), 1), wit: number(actor.fetchWit?.(), 1), men: number(actor.fetchMen?.(), 1),
            pAtk: number(actor.fetchPAtk?.()), mAtk: number(actor.fetchMAtk?.()), pDef: number(actor.fetchPDef?.()),
            mDef: number(actor.fetchMDef?.()), accur: number(actor.fetchAccur?.()), evasion: number(actor.fetchEvasion?.()),
            critical: number(actor.fetchCritical?.()), atkSpd: number(actor.fetchAtkSpd?.()), castSpd: number(actor.fetchCastSpd?.())
        },
        equipment,
        effects: EffectStore.list(actor).filter((effect) => effect.type !== 'debuff' && effect.toggle !== true)
            .map((effect) => ({ ...effect, stats: { ...(effect.stats || {}) } })),
        skills: (actor.skillset?.fetchSkills?.() || []).map(skillSnapshot)
    };
}

function needsDatabaseBackfill(snapshot = {}) {
    return snapshot?.skillSource !== 'hot'
        && (snapshot?.skillSource !== 'database' || number(snapshot?.version) < PROFILE_VERSION);
}

function profileFor(state = {}, timestamp = Date.now()) {
    const saved = state.stats?.coldCombat;
    const classId = number(saved?.classId, number(state.stats?.classId, number(state.classId)));
    const template = classTemplate(classId);
    const level = Math.max(1, number(state.level, 1));
    const spellcaster = [10, 25, 38, 49].includes(Formulas.getParentClassId(classId));
    const equipped = equippedTemplates(state);
    const legacyEquipment = equipmentFromTemplates(equipped, spellcaster, template.stats || {});
    const profile = {
        version: 1,
        capturedAt: number(saved?.capturedAt, timestamp),
        classId,
        base: { ...(template.base || {}), ...(template.stats || {}), ...(saved?.base || {}) },
        // Inventory is authoritative for a cold bot too: a completed market
        // purchase or craft must alter its next fight without waiting for a
        // hot materialisation. The hot snapshot fills only legacy states that
        // have no persisted equipped items yet.
        equipment: equipped.length
            ? { ...(saved?.equipment || {}), ...legacyEquipment }
            : { ...legacyEquipment, ...(saved?.equipment || {}) },
        effects: saved?.effects || [],
        skills: Array.isArray(saved?.skills) && saved.skills.length ? saved.skills : skillsFromTree(classId, level)
    };
    const equipment = profile.equipment;
    const str = effectiveBase(profile, 'STR', timestamp);
    const dex = effectiveBase(profile, 'DEX', timestamp);
    const con = effectiveBase(profile, 'CON', timestamp);
    const int = effectiveBase(profile, 'INT', timestamp);
    const wit = effectiveBase(profile, 'WIT', timestamp);
    const men = effectiveBase(profile, 'MEN', timestamp);
    const classTransfer = level < 20 ? 0 : level < 40 ? 1 : 2;
    const maxHp = (Formulas.calcHp(level, classId, con) * multiplier(profile, 'maxHpMul', timestamp)) + add(profile, 'maxHpAdd', timestamp);
    const maxMp = ((Formulas.calcMp(level, spellcaster ? 1 : 0, classTransfer, men) + number(equipment.bonusMp))
        * multiplier(profile, 'maxMpMul', timestamp)) + add(profile, 'maxMpAdd', timestamp);
    const pAtk = Math.round(Formulas.calcPAtk(level, str, number(equipment.pAtk, number(profile.base.pAtk)))
        * multiplier(profile, 'pAtkMul', timestamp)) + add(profile, 'pAtkAdd', timestamp);
    const mAtk = Math.round(Formulas.calcMAtk(level, int, number(equipment.mAtk, number(profile.base.mAtk)))
        * multiplier(profile, 'mAtkMul', timestamp)) + add(profile, 'mAtkAdd', timestamp);
    const pDef = Math.round(Formulas.calcPDef(level, number(equipment.pDef, number(profile.base.pDef)))
        * multiplier(profile, 'pDefMul', timestamp)) + add(profile, 'pDefAdd', timestamp);
    const mDef = Math.round(Formulas.calcMDef(level, men, number(equipment.mDef, number(profile.base.mDef)))
        * multiplier(profile, 'mDefMul', timestamp)) + add(profile, 'mDefAdd', timestamp);
    const accur = Formulas.calcAccur(level, dex, number(equipment.accur, number(profile.base.accur))) + add(profile, 'pAccuracyCombatAdd', timestamp);
    const evasion = Math.round((Formulas.calcEvasion(level, dex, number(equipment.evasion, number(profile.base.evasion)))
        + add(profile, 'pEvasionRateAdd', timestamp)) * multiplier(profile, 'pEvasionMul', timestamp));
    const critical = (Formulas.calcCritical(dex, number(equipment.critical, number(profile.base.critical)))
        * multiplier(profile, 'pCritRateMul', timestamp)) + add(profile, 'pCritRateAdd', timestamp);
    const atkSpd = Math.round(Formulas.calcAtkSpd(dex, number(equipment.atkSpd, number(profile.base.atkSpd)))
        * multiplier(profile, 'pAtkSpdMul', timestamp));
    const castSpd = Math.round(Formulas.calcCastSpd(wit) * multiplier(profile, 'castSpdMul', timestamp));
    return {
        ...profile, level, maxHp: Math.max(1, maxHp), maxMp: Math.max(1, maxMp), pAtk: Math.max(1, pAtk), mAtk: Math.max(1, mAtk),
        pDef: Math.max(1, pDef), mDef: Math.max(1, mDef), accur: Math.max(1, accur), evasion: Math.max(0, evasion),
        critical: Math.max(0, critical), atkSpd: Math.max(1, atkSpd), castSpd: Math.max(1, castSpd),
        weaponMask: (WEAPON_MASK_BY_KIND[equipment.weaponKind] || 0) | (number(equipment.shieldPDef) > 0 ? 1048576 : 0)
    };
}

function offensiveSkills(profile) {
    const allowed = new Set([C4SkillRules.DAMAGE, C4SkillRules.DAMAGE_EFFECT, C4SkillRules.DEATH_LINK, C4SkillRules.DRAIN, C4SkillRules.BLOW, C4SkillRules.AGGRO_DAMAGE]);
    return (profile.skills || []).filter((skill) => {
        if (skill.passive) return false;
        const semantic = C4SkillRules.resolve(skill);
        const required = number(semantic.requires?.weaponsAllowed);
        return semantic.target === 'enemy' && allowed.has(semantic.skillType) && !semantic.notUsedInC4
            && (!required || (required & profile.weaponMask) !== 0);
    });
}

function npcForSpot(spot = {}, rng = Math.random, options = {}) {
    const entries = Array.isArray(spot.npcEntries) && spot.npcEntries.length ? spot.npcEntries : (spot.npcSelfIds || []).map((selfId) => ({ selfId, count: 1 }));
    const pickEntry = (candidates) => {
        const total = candidates.reduce((sum, entry) => sum + Math.max(1, number(entry.count, 1)), 0);
        let needle = rng() * total;
        return candidates.find((entry) => {
            needle -= Math.max(1, number(entry.count, 1));
            return needle <= 0;
        }) || candidates[0];
    };
    const preferredNpcId = number(options.preferredNpcId);
    const preferred = preferredNpcId > 0
        ? entries.find((entry) => number(entry.selfId) === preferredNpcId)
        : null;
    // A direct-drop plan travels to the intended monster, but it is still a
    // real hunting ground. Nearby aggressive mobs can engage first instead of
    // making the bot immune to the rest of the encounter table.
    const aggressive = preferred
        ? entries.filter((entry) => number(entry.selfId) !== preferredNpcId
            && (DataCache.npcs || []).find((npc) => number(npc.selfId) === number(entry.selfId))?.template?.hostile === true)
        : [];
    const interruptionChance = Math.max(0, Math.min(1, number(options.aggressiveInterruptionChance, 0.25)));
    const selected = preferred && (!aggressive.length || rng() >= interruptionChance)
        ? preferred
        : pickEntry(aggressive.length ? aggressive : entries);
    const npc = (DataCache.npcs || []).find((entry) => Number(entry.selfId) === Number(selected?.selfId));
    if (!npc) return null;
    return {
        selfId: number(npc.selfId), level: number(npc.template?.level, number(spot.avgLevel, 1)),
        maxHp: Math.max(1, number(npc.vitals?.maxHp, spot.mob?.hp)), pAtk: Math.max(1, number(npc.stats?.pAtk, spot.mob?.damage)),
        pAtkRnd: number(npc.stats?.pAtkRnd), pDef: Math.max(1, number(npc.stats?.pDef, 1)), mDef: Math.max(1, number(npc.stats?.mDef, 1)),
        accur: Math.max(1, number(npc.stats?.accur, 1)), evasion: Math.max(0, number(npc.stats?.evasion)),
        critical: Math.max(0, number(npc.stats?.crit)), atkSpd: Math.max(1, number(npc.stats?.atkSpd, 253)),
        mAtk: Math.max(1, number(npc.stats?.mAtk)), castSpd: Math.max(1, number(npc.stats?.castSpd, 333))
    };
}

module.exports = { PROFILE_VERSION, capture, legacySnapshot, needsDatabaseBackfill, profileFor, offensiveSkills, npcForSpot, skillSnapshotsFromRecords };
