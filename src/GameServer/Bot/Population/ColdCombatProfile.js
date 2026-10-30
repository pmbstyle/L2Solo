const ClassProgression = invoke('GameServer/ClassProgression');
const SkillRankIndex = require('../../Skills/SkillRankIndex');
const { fnv1a32 } = require('../Fnv1a');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const CombatantView = invoke('GameServer/Combat/CombatantView');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const { skillTreeEntries, learnedTreeRow, treeSkillLevel } = require('./ColdSkillTree');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const SkillRequirements = invoke('GameServer/Skills/SkillRequirements');
const WeaponMask = invoke('GameServer/Skills/WeaponMask');
const NpcTraits = invoke('GameServer/Npc/NpcTraits');
const GameTime = invoke('GameServer/World/GameTime');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4ArmorSets = invoke('GameServer/Items/C4ArmorSets');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const BotPullEstimate = invoke('GameServer/Bot/AI/BotPullEstimate');
const NpcCombatChoice = invoke('GameServer/Npc/NpcCombatChoice');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const RAID_MINIONS = require('../../../../data/Npcs/Minions/c4_raid_bosses.json');
const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const HennaRules = invoke('GameServer/Henna/HennaRules');
const C4WeaponSA = invoke('GameServer/Items/C4WeaponSA');

// Rebuild persisted kits that could have been overwritten by an older resolve.
const PROFILE_VERSION = 7;
const BASE_STATS = ['STR', 'DEX', 'CON', 'INT', 'WIT', 'MEN'];
const npcCombatCache = new WeakMap();


function number(value, fallback = 0) {
    const resolved = Number(value);
    return Number.isFinite(resolved) ? resolved : fallback;
}

function classTemplate(classId) {
    return ClassProgression.firstClassRow(DataCache.classTemplates || [], classId) || {};
}

function itemTemplate(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

// A prepared worn row depends only on game data (template, enchant, slot,
// object id), so it is kept across builds and bots: reviews compare many bags
// that keep most worn items and value the same shop templates. Bounded, the
// oldest row goes first; a data reload (items, enchant or item-skill rules)
// clears it. Combat/passive/buff calculations still run for every build.
const EQUIPMENT_PREPARATION_LIMIT = 512;
const preparedRows = { rows: new Map(), items: null, statBonus: null, effectForItem: null };

function copyEquipmentEffect(effect) {
    if (!effect) return effect;
    const copy = { ...effect };
    if (effect.stats) copy.stats = { ...effect.stats };
    if (Array.isArray(effect.conditionalStats)) copy.conditionalStats = effect.conditionalStats
        .map(entry => ({ ...entry, stats: { ...entry.stats } }));
    return copy;
}

function preparedEquipment(template, selfId, objectId, enchant, slot) {
    const rules = invoke('GameServer/Items/C4EnchantRules');
    const effects = invoke('GameServer/Items/C4EquipmentItemSkills');
    const memo = preparedRows;
    if (memo.items !== DataCache.items || memo.statBonus !== rules.statBonus || memo.effectForItem !== effects.effectForItem) {
        memo.rows.clear();
        memo.items = DataCache.items; memo.statBonus = rules.statBonus; memo.effectForItem = effects.effectForItem;
    }
    const key = `${selfId}:${slot}:${enchant}:${objectId}`;
    const held = memo.rows.get(key);
    let prepared = held?.template === template ? held.row : null;
    if (!prepared) {
        const adapter = { fetchSelfId: () => selfId, fetchId: () => objectId,
            fetchEnchantLevel: () => enchant, fetchRank: () => template.etc?.rank,
            fetchKind: () => template.template?.kind, fetchSlot: () => slot,
            isWeapon: () => String(template.template?.kind || '').startsWith('Weapon.'),
            isArmor: () => String(template.template?.kind || '').startsWith('Armor.') };
        const stats = { ...template.stats };
        for (const stat of ['pAtk', 'mAtk', 'pDef', 'mDef']) stats[stat] = number(stats[stat]) + rules.statBonus(adapter, stat);
        prepared = { ...template, stats, etc: { ...(template.etc || {}), slot }, equipmentEffect: effects.effectForItem(adapter) };
        if (!held && memo.rows.size >= EQUIPMENT_PREPARATION_LIMIT) memo.rows.delete(memo.rows.keys().next().value);
        memo.rows.set(key, { template, row: prepared });
    }
    // These rows are shared and stay private to profile construction. Only
    // the effect enters a profile, and kitEffects gives it an independent copy.
    return prepared;
}

// worn (optional): receives each worn row's preparedEquipment arguments
// { template, selfId, objectId, enchant, slot }.
function equippedTemplates(state = {}, worn = null) {
    return Object.values(state.inventory || {})
        .flatMap((item) => {
            // Unequipped rows always produced no slots. Do not resolve their
            // templates on every hypothetical gear/skill profile calculation.
            if (!item?.equipped) return [];
            const template = itemTemplate(item?.selfId);
            if (!template) return [];
            const amount = Math.max(0, number(item.amount, item?.equipped ? 1 : 0));
            const explicitSlots = item?.equipped && Array.isArray(item.equippedSlots)
                ? [...new Set(item.equippedSlots.map(Number).filter((slot) => slot > 0))].slice(0, amount)
                : [];
            const slots = explicitSlots.length
                ? explicitSlots
                : item?.equipped && amount > 0
                    ? (() => {
                        const slot = number(item.slot, number(template.etc?.slot));
                        const pair = [1, 2].includes(slot) ? [1, 2] : [4, 5].includes(slot) ? [4, 5] : [slot];
                        return pair.slice(0, Math.min(amount, pair.length));
                    })()
                    : [];
            return slots.map((slot) => {
                const instance = item.instances?.find(row => row.equipped && number(row.slot) === slot);
                const enchant = number(instance?.enchant, number(item.enchant));
                const selfId = number(item.selfId), objectId = number(instance?.id, selfId);
                worn?.push({ template, selfId, objectId, enchant, slot });
                return preparedEquipment(template, selfId, objectId, enchant, slot);
            });
        })
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
        weaponKind: WeaponMask.weaponType(weapon?.template?.kind || fallback.weaponKind || '', weapon?.etc?.slot),
        // The MP of one bow shot (user 10-29: bots pay it as players do).
        bowMp: weapon?.template?.kind === 'Weapon.Bow' ? C4WeaponSA.expectedBowMp(weapon.selfId, weapon.etc?.mp) : 0,
        attackReuseDelay: number(weapon?.stats?.reuseDelay, 1500),
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
        armorKinds: armor.map((item) => item.template?.kind).filter(Boolean),
        setKind: SkillRequirements.wornSetKind(fullBody?.template?.kind, armorAt(10)?.template?.kind, armorAt(11)?.template?.kind)
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

// Passives follow the hot rule (SkillRequirements). A cold fight is judged
// once, at its start: the bot at full HP (HP-threshold passives off), not
// moving or seated, night from the game clock at `timestamp`.
function statSources(profile, timestamp, options = {}) {
    const equipment = profile.equipment || {};
    const gear = {
        weaponKind: equipment.weaponKind || '',
        armorKinds: equipment.armorKinds || [],
        setKind: equipment.setKind || '',
        shield: number(equipment.shieldPDef) > 0
    };
    // options.seated: a rest's sources (ColdRest); a fight's stand.
    const situation = {
        hp: 1, maxHp: 1, moving: false, walking: false, seated: options.seated === true,
        get night() { return options.night ?? GameTime.isNight(timestamp); }
    };
    const sources = activeEffects(profile.effects, timestamp).map(effectStats);
    for (const skill of profile.skills || []) {
        if (!skill.passive) continue;
        const semantic = C4SkillRules.resolveCached({ selfId: skill.selfId, level: skill.level });
        sources.push(...SkillRequirements.passiveStats(semantic, gear, situation));
    }
    return sources;
}

// The stat sources of one profile across the hits of a fight. Of the inputs
// of statSources only the effects still active and the night move with the
// hit's time, so held (the caller's last answer, kept on its fighter) stands
// while the profile and its effects list are the same objects, the night is
// the same and the time lies between its build and the first effect expiry
// after it. Returns held or a new { profile, effects, night, from, until, sources }.
function fightSources(profile, timestamp, held = null) {
    const night = GameTime.isNight(timestamp);
    if (held !== null && held.profile === profile && held.effects === profile.effects && held.night === night
        && timestamp >= held.from && timestamp < held.until) return held;
    let until = Infinity;
    for (const effect of profile.effects || []) {
        const end = number(effect?.expiresAt);
        if (end > timestamp && end < until) until = end;
    }
    return { profile, effects: profile.effects, night, from: timestamp, until, sources: statSources(profile, timestamp) };
}

function statValues(profile, stat, timestamp, sources = statSources(profile, timestamp)) {
    return sources.map((stats) => number(stats?.[stat], NaN)).filter(Number.isFinite);
}

function add(profile, stat, timestamp, sources) {
    return statValues(profile, stat, timestamp, sources).reduce((sum, value) => sum + value, 0);
}

function multiplier(profile, stat, timestamp, sources) {
    return statValues(profile, stat, timestamp, sources).reduce((total, value) => total * value, 1);
}

function npcPassiveStatValues(actor, stat) {
    return (actor?.fetchPassiveSkills?.() || [])
        .filter((skill) => skill?.fetchPassive?.() === true)
        .map((skill) => skill.fetchSemantic?.() || C4SkillRules.resolve({
            selfId: skill.fetchSelfId?.(),
            name: skill.fetchName?.(),
            level: skill.fetchLevel?.()
        }))
        .map((semantic) => number(semantic?.stats?.[stat], NaN))
        .filter(Number.isFinite);
}

function npcPassiveMultiplier(actor, stat) {
    return npcPassiveStatValues(actor, stat).reduce((total, value) => total * value, 1);
}

function npcPassiveAdd(actor, stat) {
    return npcPassiveStatValues(actor, stat).reduce((total, value) => total + value, 0);
}

function adjustedNpcStat(base, actor, stat) {
    return Math.max(1, Math.round(
        (number(base) * npcPassiveMultiplier(actor, `${stat}Mul`))
        + npcPassiveAdd(actor, `${stat}Add`)
    ));
}

function npcCombatStats(npc) {
    if (!npc || typeof npc !== 'object') return null;
    const cached = npcCombatCache.get(npc);
    if (cached) return cached;

    let passiveSkills = null;
    const actor = {
        fetchSelfId: () => number(npc.selfId),
        fetchMaxHp: () => number(npc.vitals?.maxHp, 1),
        fetchHp: () => number(npc.vitals?.maxHp, 1),
        fetchPassiveSkills() {
            if (!passiveSkills) passiveSkills = NpcSkills.passiveSkillsFor(actor);
            return passiveSkills;
        }
    };
    const level = Math.max(1, number(npc.template?.level, 1));
    const dex = number(npc.base?.dex, 1);
    const weapon = itemTemplate(npc.equipment?.weapon);
    const shield = Number(npc.equipment?.shield) ? itemTemplate(npc.equipment.shield) : null;
    const vulnerabilities = {};
    [
        'bowWpnVuln', 'bluntWpnVuln', 'daggerWpnVuln',
        'fireVuln', 'waterVuln', 'windVuln', 'earthVuln', 'holyVuln', 'darkVuln'
    ].forEach((stat) => {
        vulnerabilities[stat] = npcPassiveMultiplier(actor, stat);
    });

    const result = {
        selfId: number(npc.selfId),
        level,
        maxHp: adjustedNpcStat(npc.vitals?.maxHp, actor, 'maxHp'),
        pAtk: adjustedNpcStat(npc.stats?.pAtk, actor, 'pAtk'),
        mAtk: adjustedNpcStat(npc.stats?.mAtk, actor, 'mAtk'),
        pDef: adjustedNpcStat(npc.stats?.pDef, actor, 'pDef'),
        mDef: adjustedNpcStat(npc.stats?.mDef, actor, 'mDef'),
        basePDef: number(npc.stats?.pDef, 1),
        baseMDef: number(npc.stats?.mDef, 1),
        atkSpd: adjustedNpcStat(npc.stats?.atkSpd, actor, 'pAtkSpd'),
        castSpd: adjustedNpcStat(npc.stats?.castSpd, actor, 'castSpd'),
        accur: Math.max(1, Formulas.calcAccur(level, dex, number(npc.stats?.accur))
            + npcPassiveAdd(actor, 'pAccuracyCombatAdd')),
        evasion: Math.max(0, Formulas.calcEvasion(level, dex, number(npc.stats?.evasion))
            + npcPassiveAdd(actor, 'pEvasionRateAdd')),
        pAtkRnd: number(npc.stats?.pAtkRnd),
        critical: Math.max(0, number(npc.stats?.crit)),
        // The hot Npc's numbers a hit and its skill choice read
        // (CombatantView, NpcCombatChoice): MP, DEX, magic critical, shield,
        // AI type and attack radius.
        maxMp: Math.max(0, number(npc.vitals?.maxMp)),
        dex,
        // A hot Npc has no backpack: its magic critical reads no weapon.
        mCritRate: Formulas.magicCriticalRate({ wit: number(npc.base?.wit), weapon: false }),
        shieldPDef: number(shield?.stats?.pDef ?? shield?.pDef),
        shieldRate: shield || number(shield?.stats?.pDef) > 0 ? Formulas.DEFAULT_SHIELD_RATE : 0,
        aiType: NpcCombatChoice.aiTypeOfModel(npc),
        atkRadius: number(npc.stats?.atkRadius),
        // The speed it closes in at (openingMs).
        runSpd: number(npc.speed?.run),
        weaponKind: String(weapon?.template?.kind || ''),
        race: String(npc.traits?.race || '').toLowerCase(),
        undead: NpcTraits.isUndead(npc.traits),
        vulnerabilities,
        rewardExp: Math.max(0, Formulas.calcAcquiredExp(level, number(npc.rewards?.exp))),
        rewardSp: Math.max(0, number(npc.rewards?.sp))
    };
    npcCombatCache.set(npc, result);
    return result;
}

function skillDefinition(selfId, level) {
    const skill = ItemTemplateIndex.findRequired(DataCache.skills || [], selfId);
    if (!skill) return null;
    const definition = SkillRankIndex.findFiniteOrLastEligible(skill.levels || [], level)
        || null;
    return definition ? { ...skill.template, ...skill.time, ...definition } : null;
}

function summonFields(definition = {}) {
    return {
        itemId: number(definition.itemId),
        itemCount: number(definition.itemCount),
        itemIdOT: number(definition.itemIdOT),
        itemCountOT: number(definition.itemCountOT),
        itemConsumeSteps: number(definition.itemConsumeSteps),
        npcId: number(definition.npcId),
        totalLifeTime: number(definition.totalLifeTime),
        timeLostIdle: number(definition.timeLostIdle),
        timeLostActive: number(definition.timeLostActive),
        isCubic: definition.isCubic === true
    };
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
        buffTime: number(skill.fetchBuffTime?.()),
        itemId: number(skill.fetchItemConsumeId?.()),
        itemCount: number(skill.fetchItemConsumeCount?.()),
        itemIdOT: number(skill.fetchOngoingItemConsumeId?.()),
        itemCountOT: number(skill.fetchOngoingItemConsumeCount?.()),
        itemConsumeSteps: number(skill.fetchOngoingItemConsumeSteps?.()),
        npcId: number(skill.fetchSummonNpcId?.()),
        totalLifeTime: number(skill.fetchSummonTotalLifeTime?.()),
        timeLostIdle: number(skill.fetchSummonTimeLostIdle?.()),
        timeLostActive: number(skill.fetchSummonTimeLostActive?.()),
        isCubic: skill.fetchSummonIsCubic?.() === true
    };
}

function skillsFromTree(classId, level) {
    return skillTreeEntries(classId).map((entry) => {
        const learned = learnedTreeRow(entry, level);
        if (!learned) return null;
        const skill = ItemTemplateIndex.findRequired(DataCache.skills || [], entry.selfId);
        const definition = skillDefinition(entry.selfId, learned.level) || {};
        return {
            selfId: number(entry.selfId), level: number(learned.level, 1), passive: skill?.template?.passive === true,
            spell: definition.spell === true, power: number(definition.power), mp: number(definition.mp), hp: number(definition.hp),
            hitTime: number(definition.hitTime), reuse: number(definition.reuse), buffTime: number(definition.buff),
            ...summonFields(definition)
        };
    }).filter(Boolean);
}

function skillSnapshotsFromRecords(records = []) {
    return records.map((record) => {
        const selfId = number(record.selfId);
        const requestedLevel = number(record.level, 1);
        const skill = ItemTemplateIndex.findNumericRowRequired(DataCache.skills || [], selfId);
        if (!skill) return null;
        const definition = skillDefinition(selfId, requestedLevel);
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
            buffTime: number(definition.buff),
            ...summonFields(definition)
        };
    }).filter(Boolean);
}

// A cold state's current class: the one main publishes (stats.classId, set on
// every transfer, hot or cold), before the class its saved kit was captured
// with; a class-only estimate carries just the kit's or the state's.
function classIdOf(state = {}) {
    return number(state.stats?.classId, number(state.stats?.coldCombat?.classId, number(state.classId)));
}

function legacySnapshot(state = {}, records = [], timestamp = Date.now()) {
    const existing = state.stats?.coldCombat || {};
    return {
        ...existing,
        version: PROFILE_VERSION,
        skillSource: 'database',
        capturedAt: number(existing.capturedAt, timestamp),
        classId: classIdOf(state),
        effects: existing.effects || [],
        skills: skillSnapshotsFromRecords(records)
    };
}

function skillRecordsFromTree(classId, level) {
    return skillTreeEntries(classId).map((entry) => {
        const learned = learnedTreeRow(entry, level);
        if (!learned) return null;
        const skill = ItemTemplateIndex.findRequired(DataCache.skills || [], entry.selfId);
        const definition = SkillRankIndex.findFiniteOrLastEligible(skill?.levels || [], learned.level);
        if (!skill || !definition) return null;
        return {
            selfId: number(entry.selfId),
            name: skill.template?.name || skill.name || `Skill ${entry.selfId}`,
            passive: skill.template?.passive === true,
            level: number(definition.level, number(learned.level, 1))
        };
    }).filter(Boolean);
}

function treeSnapshot(state = {}, timestamp = Date.now()) {
    const existing = state.stats?.coldCombat || {};
    const classId = number(state.stats?.classId, number(state.classId));
    // Learning at a lower level after a death must not erase previously
    // learned skills or lower their ranks (including Expertise).
    const authoritative = existing.skillSource === 'database' || existing.skillSource === 'hot';
    // Eligibility is not learning. Legacy tree kits are hydrated from the
    // learned rows before startup readiness; a projector cannot pay for ranks.
    const skills = authoritative ? existing.skills || [] : [];
    return {
        ...existing,
        version: PROFILE_VERSION,
        skillSource: authoritative ? existing.skillSource : 'unresolved',
        capturedAt: timestamp,
        classId,
        effects: existing.effects || [],
        skills: [...skills]
    };
}

// The servitor goes with the bot into cold combat, which keeps it between
// fights (BackgroundResolver.persistedSummon). Item pets (actor.pet) are not
// cold summons. Remaining life is counted at the idle loss rate, as cold does.
function summonSnapshot(actor, timestamp) {
    const summon = actor.summon;
    if (!summon || summon.isDead?.() === true || summon.state?.fetchDead?.() === true) return null;
    const skillId = number(summon.fetchSummonSkillId?.());
    if (!skillId) return null;
    // startLifetime set both from the skill; a servitor without a lifetime
    // gets cold's default 20 minutes (BackgroundResolver.startColdSummon).
    const remaining = Number(summon.summonTimeRemaining);
    const idleLoss = Number(summon.summonTimeLostIdle);
    return {
        active: true,
        skillId,
        hp: number(summon.fetchHp?.()),
        expiresAt: Number.isFinite(remaining) && idleLoss > 0
            ? timestamp + Math.max(0, remaining) * 1000 / idleLoss
            : timestamp + 1200000
    };
}

function capture(actor, timestamp = Date.now()) {
    const backpack = actor.backpack;
    const armors = backpack?.fetchEquippedArmors?.() || [];
    const armorKindAt = (slot) => armors.find((item) => Number(item.fetchSlot?.()) === slot)?.fetchKind?.();
    const equipment = {
        weaponKind: WeaponMask.weaponType(backpack?.fetchTotalWeaponKind?.() || '', backpack?.fetchEquippedWeapon?.()?.fetchSlot?.()),
        bowMp: backpack?.fetchTotalWeaponKind?.() === 'Weapon.Bow' ? C4WeaponSA.expectedBowMp(
            backpack.fetchEquippedWeapon?.()?.fetchSelfId?.(), backpack.fetchEquippedWeapon?.()?.fetchConsumedMp?.()) : 0,
        attackReuseDelay: backpack?.fetchEquippedWeapon?.()?.fetchAttackReuseDelay?.() ?? 1500,
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
        armorKinds: armors.map((item) => item.fetchKind?.()).filter(Boolean),
        setKind: SkillRequirements.wornSetKind(armorKindAt(15), armorKindAt(10), armorKindAt(11))
    };
    return {
        version: PROFILE_VERSION,
        skillSource: 'hot',
        capturedAt: timestamp,
        cp: number(actor.fetchCp?.()),
        cpAt: timestamp,
        cooldowns: Object.fromEntries([...(actor.skillReuseUntil || [])].filter(([, until]) => until > timestamp)),
        summon: summonSnapshot(actor, timestamp),
        charges: number(actor.fetchCharges?.()),
        chargeExpiresAt: Number(actor.chargeExpiresAt) > timestamp ? Number(actor.chargeExpiresAt) : null,
        classId: number(actor.fetchClassId?.()),
        henna: { ...(actor.hennaStats || {}) },
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

function hasInventory(state) {
    return !!state.inventory && typeof state.inventory === 'object';
}

// Equipment effects are kit, not buffs: item effects and armour sets (from
// the worn parts with an inventory, else the saved captured ones, gatherKit).
function capturedEquipmentEffect(effect) {
    return effect.category === 'equipment_item_skill' || effect.category === C4ArmorSets.CATEGORY;
}
// The bot's buffs: its saved effects that are not equipment ones, active or
// not (the reader filters by its clock).
function buffEffects(state) {
    return (state.stats?.coldCombat?.effects || []).filter(effect => !capturedEquipmentEffect(effect));
}
// A state without inventory: its saved captured set effects (kit, no clock).
function savedSetEffects(state) {
    return hasInventory(state) ? []
        : (state.stats?.coldCombat?.effects || []).filter(effect => effect.category === C4ArmorSets.CATEGORY);
}

// The skills a cold profile carries, readable without building the profile.
// An empty saved kit is still empty. Only class-only hypothetical estimates
// (without a character owner) may use the eligibility tree.
function skillsFor(state = {}, classId = classIdOf(state),
    level = Math.max(1, number(state.level, 1))) {
    const saved = state.stats?.coldCombat;
    return Array.isArray(saved?.skills) && saved.skillSource !== 'tree' && saved.skillSource !== 'unresolved' ? saved.skills
        : state.characterId || saved ? [] : skillsFromTree(classId, level);
}

// The kit profile store, one per thread (the module loads once in each, no
// message between threads). A bot's fighter numbers follow its kit
// (kitEvents: class, level, worn gear, hennas, skills, the hot capture),
// never its buffs or the clock: profileFor returns the stored profile while
// the state's kit hash is the stored one and builds it once (no buffs, day)
// when it moved. characterId -> { own, preparation }, each slot null or
// { kit, kitPart, profile, terms }: own is the bot, preparation its future state of
// gear preparation (WishProviders, options.preparation). The stored profile is
// shared, read-only: a reader spreads it into its own object to change it.
// Buffs and night apply only in fightProfile. At most ownerLimit() bots; the
// oldest inserted is dropped, a rebuilt one re-inserted. A state without a
// positive characterId, or a what-if with options.store false (another kit
// under the bot's real id), builds without reading or writing the store.
const kitProfiles = new Map();
function ownerLimit() {
    return Math.ceil(1.25 * Math.max(256, Number(PopulationConfig.maxPlayingPopulation) || 0));
}
function kitEntry(state, timestamp, options) {
    const owner = Number(state.characterId);
    if (!(owner > 0) || options.store === false) return buildKit(state, timestamp, 0);
    const kit = buildHash((options.kitHashes || kitEvents(state)).join('|')), slot = options.preparation === true ? 'preparation' : 'own';
    let entry = kitProfiles.get(owner);
    const hit = entry?.[slot]?.kit === kit;
    Diagnostics.count('combat_profile', 'kit', hit ? 'hit' : 'miss');
    if (hit) return entry[slot];
    const built = buildKit(state, timestamp, kit);
    if (entry) kitProfiles.delete(owner);
    else entry = { own: null, preparation: null };
    entry[slot] = built;
    kitProfiles.set(owner, entry);
    if (kitProfiles.size > ownerLimit()) kitProfiles.delete(kitProfiles.keys().next().value);
    return built;
}

// The bot's unbuffed day profile, kept per kit. options: store (false: a
// what-if state), preparation (true: the preparation slot), kitHashes (the
// state's kitEvents when the caller already holds them); the timestamp
// does not change the result.
function profileFor(state = {}, timestamp = Date.now(), options = {}) {
    return kitEntry(state, timestamp, options).profile;
}

// The profile a fight reads: the numbers pass over the stored kit part plus
// the bot's current buffs (the saved effects that are not equipment ones,
// active at timestamp) and the night of timestamp; cp from the clock. A new
// object per call: the fight may write into it.
function fightProfile(state = {}, timestamp = Date.now(), options = {}) {
    const kitPart = kitEntry(state, timestamp, options).kitPart;
    const effects = [...buffEffects(state), ...kitPart.effects];
    const profile = profileNumbers(kitPart, effects, timestamp, {});
    profile.cp = currentCp(state, profile, timestamp);
    return profile;
}

// The saved kit of a bot that fights before any capture: the kit fields
// capture writes, from its kit profile (copies: the stored one is shared),
// the henna totals its base already counts (gatherKit adds only the delta),
// and its cp at timestamp. The fight writes effects, cooldowns, charges and
// the summon over it.
function seedSnapshot(state = {}, timestamp = Date.now()) {
    const { kitPart, profile } = kitEntry(state, timestamp, {});
    return {
        ...structuredClone({ version: profile.version, capturedAt: profile.capturedAt, classId: profile.classId,
            base: profile.base, henna: kitPart.henna, equipment: profile.equipment, skills: profile.skills }),
        cp: currentCp(state, profile, timestamp), cpAt: timestamp
    };
}

// A seed saved before 2e3af7fa0: a base with the hennas of that moment and
// no henna totals, which gatherKit would count again. The copy without that
// base (gatherKit rebuilds it from the class template with the current
// hennas), or null when the snapshot is not such a seed.
function oldSeedRepair(snapshot) {
    if (!snapshot?.base || snapshot.henna) return null;
    const kit = { ...snapshot };
    delete kit.base;
    return kit;
}

// The saved CP plus its regeneration since saved.cpAt at the profile's rate.
function currentCp(state = {}, profile = {}, timestamp = Date.now()) {
    const saved = state.stats?.coldCombat;
    return Number.isFinite(saved?.cp) ? Math.min(profile.maxCp, Math.max(0, saved.cp)
        + Math.floor(Math.max(0, timestamp - number(saved.cpAt, timestamp)) / Formulas.REGEN_TICK_MS) * profile.cpRegen) : profile.maxCp;
}

// Kit profile builds for the live read (combat_profile:build:all and its ms);
// a fight reads the totals around itself (buildCount, buildMs). Counted only
// while diagnostics are on. combat_profile:build:<site> names who asked: the
// site set around the call (withBuildSite: matchup, fight; candidateProfiles
// sets gain; the innermost wins), else other.
let builds = 0, buildTime = 0, buildSite = null;
function buildKit(state, timestamp, kit) {
    if (!Diagnostics.active()) return kitSlot(state, timestamp, kit);
    const startedAt = performance.now();
    const slot = kitSlot(state, timestamp, kit);
    const ms = performance.now() - startedAt;
    builds += 1;
    buildTime += ms;
    Diagnostics.count('combat_profile', 'build', 'all');
    Diagnostics.count('combat_profile', 'build', buildSite || 'other');
    Diagnostics.duration('combat_profile:build', ms);
    return slot;
}
function withBuildSite(site, work) {
    if (!Diagnostics.active()) return work();
    const outer = buildSite;
    buildSite = site;
    try { return work(); }
    finally { buildSite = outer; }
}
function buildCount() { return builds; }
function buildMs() { return buildTime; }

// terms: the formula terms of the kit numbers (powerTerms), read by the
// what-if of a candidate (candidateProfiles).
function kitSlot(state, timestamp, kit) {
    const kitPart = gatherKit(state, timestamp);
    const { profile, terms } = numbersPass(kitPart, kitPart.effects, timestamp, { night: false });
    return { kit, kitPart, profile, terms };
}

// The gather part of a profile: class template, worn gear, the kit effects
// (armour sets and item effects of the worn gear), skills, the base stats
// with the henna delta, the henna totals (henna). No buff, no clock.
function gatherKit(state, timestamp) {
    const saved = state.stats?.coldCombat;
    const classId = classIdOf(state);
    const template = classTemplate(classId);
    const level = Math.max(1, number(state.level, 1));
    const spellcaster = [10, 13, 14, 25, 26, 28, 38, 39, 40, 41, 49].includes(Formulas.getParentClassId(classId))
        || [10, 13, 14, 25, 26, 28, 38, 39, 40, 41, 49].includes(classId);
    const worn = [];
    const equipped = equippedTemplates(state, worn);
    const kitPart = {
        version: 1,
        capturedAt: number(saved?.capturedAt, timestamp),
        classId,
        // A bot's id (null for a player): its future second class's kit
        // (BotRoles.kitClassId), such as a future summoner's pet.
        characterId: BotRoles.botCharacterId(state),
        base: { ...(template.base || {}), ...(template.stats || {}), ...(saved?.base || {}) },
        equipment: kitEquipment(equipmentFromTemplates(equipped, spellcaster, template.stats || {}), equipped.length, saved?.equipment),
        // Set bonuses follow the current worn parts, including hypothetical swaps;
        // a state without inventory keeps its captured ones.
        effects: kitEffects(state, equipped),
        skills: skillsFor(state, classId, level),
        level, race: number(template.template?.race), spellcaster,
        // The worn rows (equippedTemplates) and the class gear fallback, for
        // the what-if of a candidate (candidateProfiles).
        worn, classStats: template.stats || {}
    };
    const henna = kitPart.henna = hennaTotals(state.stats?.hennas);
    // Captured base stats (hot capture, seedSnapshot) already include the
    // symbols in saved.henna. Only the delta from them is added.
    for (const stat of BASE_STATS) {
        const captured = number(saved?.henna?.[stat]);
        kitPart.base[stat.toLowerCase()] = number(kitPart.base[stat.toLowerCase()], 1) + henna[stat] - captured;
    }
    return kitPart;
}

function hennaTotals(hennas) {
    return HennaRules.totals(hennas || []);
}

// The gear of worn templates (legacyEquipment: equipmentFromTemplates of
// worn rows) over the saved captured gear.
function kitEquipment(legacyEquipment, worn, savedEquipment) {
    // ARCH-NOTE: Restore snapshot gear for legacy bags with no equipped rows;
    // selling the last weapon keeps that snapshot until the next hot capture.
    // Equipped rows still override it immediately after purchases and crafts.
    return worn
        ? { ...(savedEquipment || {}), ...legacyEquipment }
        : { ...legacyEquipment, ...(savedEquipment || {}) };
}

// The numbers pass: the formulas over a kit part, a list of effects and the
// night of sourceOptions (statSources; unset: the night of timestamp).
function profileNumbers(kitPart, effects, timestamp, sourceOptions) {
    return numbersPass(kitPart, effects, timestamp, sourceOptions).profile;
}
// The pass and its power terms (powerTerms).
function numbersPass(kitPart, effects, timestamp, sourceOptions) {
    const { classId, level } = kitPart;
    const profile = { version: kitPart.version, capturedAt: kitPart.capturedAt, classId, characterId: kitPart.characterId,
        base: kitPart.base, equipment: kitPart.equipment, effects, skills: kitPart.skills };
    // Resolve effects and passive requirements once for this calculation.
    const sources = statSources(profile, timestamp, sourceOptions);
    const equipment = profile.equipment;
    const terms = powerTerms(profile, level, timestamp, sources);
    const stats = terms.stats = effectiveStats(terms, profile.base);
    const { con, wit, men } = stats;
    const power = formulaPower(terms, equipment, profile.base, stats);
    const maxMp = ((Formulas.calcMp(level, classId, men) + number(equipment.bonusMp))
        * multiplier(profile, 'maxMpMul', timestamp, sources)) + add(profile, 'maxMpAdd', timestamp, sources);
    const maxCp = Math.max(0, Formulas.calcCp(level, classId, con)
        * multiplier(profile, 'maxCpMul', timestamp, sources) + add(profile, 'maxCpAdd', timestamp, sources));
    const cpRegen = Math.max(0, number(DataCache.revitalize?.hp?.[level]) * Formulas.calcLevelMod(level)
        * Formulas.calcBaseMod.CON(con) * multiplier(profile, 'regCp', timestamp, sources));
    const mCritRate = Formulas.magicCriticalRate({
        multiplier: multiplier(profile, 'mCritRateMul', timestamp, sources),
        add: add(profile, 'mCritRateAdd', timestamp, sources),
        wit,
        weapon: !!equipment.weaponKind
    });
    return { terms, profile: {
        ...profile, level, race: kitPart.race,
        maxLoad: Math.max(0, Formulas.calcMaxLoad(con) * multiplier(profile, 'maxLoadMul', timestamp, sources)
            + add(profile, 'maxLoad', timestamp, sources)),
        maxCp, cpRegen, maxHp: power.maxHp, maxMp: Math.max(1, maxMp), pAtk: power.pAtk, mAtk: power.mAtk,
        pDef: power.pDef, mDef: power.mDef, accur: power.accur, evasion: power.evasion,
        critical: power.critical, mCritRate, atkSpd: power.atkSpd, castSpd: power.castSpd, con: power.con, men: power.men,
        str: stats.str, dex: stats.dex,
        // Run speed as the hot CalculateStats.setCollectiveTotalRunSpd: the
        // template's by DEX, plus and times the effects (the solo walk, T106);
        // 0 without a template run speed.
        runSpd: Math.max(0, number(classTemplate(classId).speed?.run) && (Formulas.calcSpeed(stats.dex, number(classTemplate(classId).speed.run))
            + add(profile, 'runSpdAdd', timestamp, sources)) * multiplier(profile, 'runSpdMul', timestamp, sources)),
        weaponMask: (WeaponMask.MASK_BY_KIND[equipment.weaponKind] || 0) | (number(equipment.shieldPDef) > 0 ? 1048576 : 0)
    } };
}

// The power terms of one numbers pass: level and class, each base stat's
// effect addition and multiplier, and each power stat's effect multiplier
// and addition (numbersPass adds stats, its effective base stats). With them
// the power numbers (formulaPower) follow from the gear raw sums and the base
// stats alone.
function powerTerms(profile, level, timestamp, sources) {
    const terms = { level, classId: profile.classId, baseAdd: {}, baseMul: {} };
    for (const stat of BASE_STATS) {
        terms.baseAdd[stat] = add(profile, stat, timestamp, sources);
        terms.baseMul[stat] = multiplier(profile, `${stat}Mul`, timestamp, sources);
    }
    for (const stat of ['pAtk', 'mAtk', 'pDef', 'mDef', 'maxHp']) {
        terms[`${stat}Mul`] = multiplier(profile, `${stat}Mul`, timestamp, sources);
        terms[`${stat}Add`] = add(profile, `${stat}Add`, timestamp, sources);
    }
    terms.pAtkSpdMul = multiplier(profile, 'pAtkSpdMul', timestamp, sources);
    terms.castSpdMul = multiplier(profile, 'castSpdMul', timestamp, sources);
    terms.accurAdd = add(profile, 'pAccuracyCombatAdd', timestamp, sources);
    terms.evasionAdd = add(profile, 'pEvasionRateAdd', timestamp, sources);
    terms.evasionMul = multiplier(profile, 'pEvasionMul', timestamp, sources);
    terms.critMul = multiplier(profile, 'pCritRateMul', timestamp, sources);
    terms.critAdd = add(profile, 'pCritRateAdd', timestamp, sources);
    return terms;
}
// The six base stats after the effects: { str, dex, con, int, wit, men }.
function effectiveStats(terms, base) {
    const stats = {};
    for (const stat of BASE_STATS) {
        const key = stat.toLowerCase();
        stats[key] = Math.max(1, Math.round((number(base?.[key], 1) + terms.baseAdd[stat]) * terms.baseMul[stat]));
    }
    return stats;
}
// The power numbers: the formula of each over the gear raw sum (the class
// base value with none), the effective base stats and the terms.
function formulaPower(terms, equipment, base, stats) {
    const { level, classId } = terms;
    return {
        maxHp: Math.max(1, Formulas.calcHp(level, classId, stats.con) * terms.maxHpMul + terms.maxHpAdd),
        pAtk: Math.max(1, Math.round(Formulas.calcPAtk(level, stats.str, number(equipment.pAtk, number(base.pAtk))) * terms.pAtkMul) + terms.pAtkAdd),
        mAtk: Math.max(1, Math.round(Formulas.calcMAtk(level, stats.int, number(equipment.mAtk, number(base.mAtk))) * terms.mAtkMul) + terms.mAtkAdd),
        pDef: Math.max(1, Math.round(Formulas.calcPDef(level, number(equipment.pDef, number(base.pDef))) * terms.pDefMul) + terms.pDefAdd),
        mDef: Math.max(1, Math.round(Formulas.calcMDef(level, stats.men, number(equipment.mDef, number(base.mDef))) * terms.mDefMul) + terms.mDefAdd),
        atkSpd: Math.max(1, Math.round(Formulas.calcAtkSpd(stats.dex, number(equipment.atkSpd, number(base.atkSpd))) * terms.pAtkSpdMul)),
        castSpd: Math.max(1, Math.round(Formulas.calcCastSpd(stats.wit) * terms.castSpdMul)),
        accur: Math.max(1, Formulas.calcAccur(level, stats.dex, number(equipment.accur, number(base.accur))) + terms.accurAdd),
        evasion: Math.max(0, Math.round((Formulas.calcEvasion(level, stats.dex, number(equipment.evasion, number(base.evasion)))
            + terms.evasionAdd) * terms.evasionMul)),
        critical: Math.max(0, Formulas.calcCritical(stats.dex, number(equipment.critical, number(base.critical))) * terms.critMul
            + terms.critAdd),
        // The effective CON and MEN: the seated regeneration (ColdRest) of the kit.
        con: stats.con, men: stats.men
    };
}

// A bot's numbers before and after one change of its kit, a what-if: no
// gather, nothing stored. Reads the kit entry once (options.preparation: the
// preparation slot); before = the kit profile; after(change) = the numbers
// with the change:
// - gear { free, wear }: the worn rows whose slot free(slot) answers true come
//   off, wear ({ selfId, objectId, enchant, slot, template? }, a list of them,
//   or null) goes on;
// - { hennas }: the symbol list replaces the bot's;
// - { skill: { selfId, level } }: the skill is learnt.
// A gear or henna change returns the power numbers (formulaPower) only, the
// kit profile with the skill a whole profile. The reader keeps the prepared
// worn rows for its candidates; they die with it.
function candidateProfiles(state = {}, timestamp = Date.now(), options = {}) {
    const entry = withBuildSite('gain', () => kitEntry(state, timestamp, options));
    let worn;
    const after = change => change.skill ? skillCandidate(entry, change.skill, timestamp)
        : change.hennas ? hennaCandidate(entry, change.hennas)
            : gearCandidate(state, entry, worn ||= entry.kitPart.worn.map(prepareWorn), change, timestamp);
    return { before: entry.profile, after };
}
function prepareWorn(row) {
    return preparedEquipment(row.template, row.selfId, row.objectId, row.enchant, row.slot);
}
function hennaCandidate({ kitPart, terms }, next) {
    const now = kitPart.henna, then = hennaTotals(next), base = { ...kitPart.base };
    for (const stat of BASE_STATS) base[stat.toLowerCase()] = number(base[stat.toLowerCase()], 1) + then[stat] - now[stat];
    return formulaPower(terms, kitPart.equipment, base, effectiveStats(terms, base));
}
// A passive skill reaches the numbers through the numbers pass; an active one
// only the skill list.
function skillCandidate({ kitPart, profile }, skill, timestamp) {
    const [snapshot] = skillSnapshotsFromRecords([skill]);
    if (!snapshot) return profile;
    const skills = [...kitPart.skills.filter(known => known.selfId !== snapshot.selfId), snapshot];
    return snapshot.passive ? profileNumbers({ ...kitPart, skills }, kitPart.effects, timestamp, { night: false })
        : { ...profile, skills };
}
// The gear of the changed worn list (kitEquipment). While no item effect
// comes on or off, the armour set effects stay and so do the gear conditions
// of passives (statSources: weapon kind, armour kinds, set kind, shield), the
// kit's terms hold: the formula over the new raw sums (with a worn row, the
// worn gear holds every field the formula reads). Else the kit effects of the
// new worn list and a numbers pass. A state without inventory (captured set
// effects) always takes the pass.
// worn: the kit's worn rows prepared (prepareWorn), in kitPart.worn order.
function gearCandidate(state, { kitPart, terms }, worn, { free, wear }, timestamp) {
    const added = [].concat(wear || []).map(one => {
        const template = one.template || itemTemplate(one.selfId);
        return template ? prepareWorn({ template, selfId: number(one.selfId), objectId: number(one.objectId, number(one.selfId)),
            enchant: number(one.enchant), slot: number(one.slot) }) : null;
    }).filter(Boolean);
    const kept = [], changed = [...added];
    for (let index = 0; index < worn.length; index++) (free(kitPart.worn[index].slot) ? changed : kept).push(worn[index]);
    const equipped = [...kept, ...added];
    const legacyEquipment = equipmentFromTemplates(equipped, kitPart.spellcaster, kitPart.classStats);
    const sameKit = equipped.length > 0 && hasInventory(state) && !changed.some(item => item.equipmentEffect)
        && sameGearConditions(legacyEquipment, kitPart.equipment, terms.armorKinds ??= armorKindsKey(kitPart.equipment.armorKinds))
        && (!changed.some(setPart) || sameKeys(C4ArmorSets.effectsForEquippedIds(wornIds(equipped)),
            kitPart.effects.filter(effect => effect.category === C4ArmorSets.CATEGORY)));
    if (sameKit) return formulaPower(terms, legacyEquipment, kitPart.base, terms.stats);
    const equipment = kitEquipment(legacyEquipment, equipped.length, state.stats?.coldCombat?.equipment);
    return profileNumbers({ ...kitPart, equipment }, kitEffects(state, equipped), timestamp, { night: false });
}
// Armour sets are made of armour and shields, never of jewels (C4ArmorSets).
function setPart(item) {
    const kind = String(item.template?.kind || '');
    return kind.startsWith('Armor.') && kind !== 'Armor.Jewel';
}
function wornIds(equipped) {
    return new Set(equipped.map(item => Number(item.selfId)));
}
function sameKeys(effects, others) {
    return effects.length === others.length && effects.every((effect, index) => effect.key === others[index].key);
}
// kitKinds: armorKindsKey of the kit's gear, kept once per kit (terms.armorKinds).
function sameGearConditions(equipment, kit, kitKinds) {
    return (equipment.weaponKind || '') === (kit.weaponKind || '') && (equipment.setKind || '') === (kit.setKind || '')
        && (number(equipment.shieldPDef) > 0) === (number(kit.shieldPDef) > 0)
        && armorKindsKey(equipment.armorKinds) === kitKinds;
}
function armorKindsKey(list) {
    return [...(list || [])].sort().join(',');
}
// The kit effects of a worn list: its armour sets (a state without inventory
// keeps its captured ones) and its items' effects.
function kitEffects(state, equipped) {
    return [...C4ArmorSets.effectsForEquippedIds(wornIds(equipped)), ...savedSetEffects(state),
        ...equipped.map(item => copyEquipmentEffect(item.equipmentEffect)).filter(Boolean)];
}

function activeMusicEffects(profile = {}, timestamp = Date.now()) {
    return activeEffects(profile.effects, timestamp).filter((effect) => (
        C4SkillRules.resolveCached({
            selfId: effect.id,
            name: effect.name,
            level: effect.level
        }).isDance === true
    ));
}

function partyMusicSkills(profile = {}) {
    return (profile.skills || []).filter((skill) => {
        if (skill.passive) return false;
        const semantic = C4SkillRules.resolveCached(skill);
        const required = number(semantic.requires?.weaponsAllowed);
        return semantic.isDance === true
            && semantic.target === 'party'
            && !semantic.notUsedInC4
            && (!required || (required & number(profile.weaponMask)) !== 0);
    });
}

// One normal attack of a fight profile (Formulas.normalAttackMs, the hot
// Attack.js cycle), its buffs read at timestamp. Kept per profile object: a
// fight profile is rebuilt whenever its numbers change. The 250 ms floor is
// cold's own.
const attackTimes = new WeakMap();
function normalAttackMs(profile = {}, timestamp = Date.now()) {
    let ms = attackTimes.get(profile);
    if (ms !== undefined) return ms;
    const bow = profile.equipment?.weaponKind === 'Weapon.Bow';
    ms = Math.max(250, Formulas.normalAttackMs(profile.atkSpd, { bow, reuseDelay: profile.equipment?.attackReuseDelay,
        reuseMul: bow ? multiplier(profile, 'atkReuseMul', timestamp) : 1 }));
    attackTimes.set(profile, ms);
    return ms;
}

function partyMusicMpCost(profile, skill, timestamp = Date.now()) {
    const semantic = C4SkillRules.resolveCached(skill);
    let cost = Math.max(0, number(skill.mp));
    if (semantic.isDance === true) {
        cost += activeMusicEffects(profile, timestamp).length * Math.max(0, number(semantic.nextDanceCost));
    }
    return Math.max(0, Math.floor(cost * multiplier(profile, 'danceMpConsumeMul', timestamp)));
}

function partyMusicEffect(skill, timestamp = Date.now()) {
    const semantic = C4SkillRules.resolveCached(skill);
    const durationMs = Math.max(0, number(semantic.durationMs ?? skill.buffTime, 120000));
    const skillId = number(skill.selfId);
    return {
        key: String(semantic.effect || `skill_${skillId}`),
        id: skillId,
        name: skill.name || semantic.effect || `Skill ${skillId}`,
        level: number(skill.level, 1),
        type: 'buff',
        durationMs,
        expiresAt: timestamp + durationMs,
        stackFamily: semantic.stackFamily || null,
        stackOrder: semantic.stackOrder ?? null,
        stats: { ...(semantic.stats || {}) }
    };
}

const ATTACK_SKILL_TYPES = new Set([C4SkillRules.DAMAGE, C4SkillRules.DAMAGE_EFFECT, C4SkillRules.DEATH_LINK,
    C4SkillRules.FATAL, C4SkillRules.DRAIN, C4SkillRules.BLOW, C4SkillRules.AGGRO_DAMAGE]);

function isAttackSkill(skill = {}) {
    if (skill.passive) return false;
    const semantic = C4SkillRules.resolveCached(skill);
    return semantic.target === 'enemy' && ATTACK_SKILL_TYPES.has(semantic.skillType) && !semantic.notUsedInC4;
}

function offensiveSkills(profile) {
    return (profile.skills || []).filter((skill) => {
        if (!isAttackSkill(skill)) return false;
        const semantic = C4SkillRules.resolveCached(skill);
        const required = number(semantic.requires?.weaponsAllowed);
        return !required || (required & profile.weaponMask) !== 0;
    });
}

function summonDetails(skill = {}) {
    const definition = skillDefinition(skill.selfId, skill.level) || {};
    return {
        skillId: number(skill.selfId),
        skillLevel: number(skill.level, 1),
        ...summonFields(definition),
        ...Object.fromEntries(Object.entries(summonFields(skill)).filter(([, value]) => value > 0 || value === true))
    };
}

function summonSkills(profile = {}) {
    if (!BotRoles.isSummoner(profile)) return [];
    return (profile.skills || [])
        .filter((skill) => !skill.passive)
        .filter((skill) => {
            const semantic = C4SkillRules.resolve(skill);
            const details = summonDetails(skill);
            return semantic.skillType === C4SkillRules.SUMMON
                && semantic.target === 'self'
                && details.npcId > 10
                && details.isCubic !== true;
        })
        .sort((a, b) => Number(b.selfId || 0) - Number(a.selfId || 0)
            || Number(b.level || 0) - Number(a.level || 0));
}

function corpseSummonSkills(profile = {}) {
    return (profile.skills || [])
        .filter((skill) => !skill.passive)
        .filter((skill) => {
            const semantic = C4SkillRules.resolve(skill);
            const details = summonDetails(skill);
            return semantic.skillType === C4SkillRules.SUMMON
                && semantic.target === 'corpse_mob'
                && details.npcId > 10
                && details.isCubic !== true;
        })
        .sort((a, b) => Number(b.selfId || 0) - Number(a.selfId || 0)
            || Number(b.level || 0) - Number(a.level || 0));
}

function spotSpawns(spot = {}, npcId) {
    const id = Number(npcId);
    if (!(id > 0)) return false;
    return Array.isArray(spot.npcEntries) && spot.npcEntries.length
        ? spot.npcEntries.some(entry => Number(entry.selfId) === id)
        : (spot.npcSelfIds || []).some(selfId => Number(selfId) === id);
}

// The one owner of "which monster of a spot a kill takes": the cold roll
// (npcForSpot) draws from it and the planners' expectation
// (SpotRewardExpectation.killShare) reads its chances. entries: the kill's
// candidates (huntable, after the hunters' matchup filter: entry.match);
// encounterEntries: the huntable ones before that filter. An untargeted
// kill draws from entries by killWeight. A targeted kill
// (options.preferredNpcId among entries: an active plan's next hunt,
// PartyHuntingTarget.planTargetNpcId, or a material party) takes its
// target, unless an aggressive other monster of the encounter engages first (interruption, 0.25 by default): a direct-drop
// plan travels to the intended monster, but it is still a real hunting
// ground, so the bot is not immune to the rest of the encounter table; an
// interrupted kill draws from those aggressive others by killWeight.
function killDraw(entries, encounterEntries, options = {}) {
    const preferredNpcId = number(options.preferredNpcId);
    const preferred = preferredNpcId > 0
        ? entries.find((entry) => number(entry.selfId) === preferredNpcId) || null
        : null;
    const interrupters = preferred
        ? encounterEntries.filter((entry) => number(entry.selfId) !== preferredNpcId
            && ItemTemplateIndex.find(DataCache.npcs, entry.selfId)?.template?.hostile === true)
        : [];
    const interruption = Math.max(0, Math.min(1, number(options.aggressiveInterruptionChance, 0.25)));
    return { preferred, interrupters, interruption, pool: interrupters.length ? interrupters : entries };
}

// An entry's weight in a kill draw: its spawn count, times its squared
// matchup efficiency for the hunters (1 without a matchup), times the share of
// its spawns whose pull a solo hunter survives (BotTargetMatchup.speciesPulls).
function killWeight(entry) {
    return Math.max(1, number(entry.count, 1)) * Math.min(1, entry.match?.efficiency ?? 1) ** 2
        * (entry.match?.share ?? 1);
}

// Each entry's chance to be the kill of a draw (killDraw), as the roll
// gives it: [{ entry, chance }], the chances sum to 1 (none for an empty
// draw).
function killChances(draw) {
    const preferredChance = !draw.preferred ? 0
        : draw.interrupters.length ? 1 - draw.interruption : 1;
    const rest = 1 - preferredChance;
    const total = draw.pool.reduce((sum, entry) => sum + killWeight(entry), 0);
    // All weights 0: the roll takes the pool's first entry.
    const chances = draw.pool.map((entry, index) => ({ entry,
        chance: total > 0 ? rest * killWeight(entry) / total : index === 0 ? rest : 0 }));
    return draw.preferred ? [{ entry: draw.preferred, chance: preferredChance }, ...chances] : chances;
}

function npcForSpot(spot = {}, rng = Math.random, options = {}) {
    const rawEntries = Array.isArray(spot.npcEntries) && spot.npcEntries.length ? spot.npcEntries : (spot.npcSelfIds || []).map((selfId) => ({ selfId, count: 1 }));
    let entries = rawEntries.filter((entry) => {
        const npc = ItemTemplateIndex.find(DataCache.npcs, entry.selfId);
        const explicitRaid = options.allowRaid === true && spot.raidBoss === true
            && BotRaidSafety.isRaidBoss(npc)
            && number(spot.raidBossTemplateId) === number(npc.selfId);
        return npc && (explicitRaid
            || !BotRaidSafety.isProtectedRaidEntity(npc) && BotHuntingTargetPolicy.canHunt(npc));
    });
    if (entries.length === 0) return null;
    const encounterEntries = entries;
    const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
    if (options.matchupProfiles?.length) {
        let resisted = 0;
        entries = entries.map(entry => {
            // A solo pick reads the shared spawn-group verdict its route search
            // read: the same evaluate and soloCanHunt per pull size for these
            // profiles and safety options; the pick takes only the pulls the
            // hunter survives (resisted only names a pick without safety).
            if (options.soloSafety) {
                const verdict = Matchup.speciesPulls(options.matchupProfiles, entry, options);
                return { ...entry, match: { eligible: verdict?.canHunt === true, efficiency: verdict?.efficiency,
                    share: verdict?.share ?? 0, allowed: verdict?.allowed } };
            }
            const match = Matchup.evaluate(options.matchupProfiles, npcCombatStats(ItemTemplateIndex.find(DataCache.npcs, entry.selfId)));
            if (!match.eligible) resisted += 1;
            return { ...entry, match };
        }).filter(entry => entry.match.eligible);
        if (!entries.length) return { avoided: true,
            reason: options.soloSafety ? 'no_safe_solo_target'
                : resisted === encounterEntries.length ? 'target_resistance' : 'no_safe_solo_target' };
    }
    const pickEntry = (candidates) => {
        const weight = entry => Math.max(1, number(entry.count, 1)) * Math.min(1, entry.match?.efficiency ?? 1) ** 2;
        const total = candidates.reduce((sum, entry) => sum + weight(entry), 0);
        let needle = rng() * total;
        return candidates.find((entry) => {
            needle -= weight(entry);
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
        ? encounterEntries.filter((entry) => number(entry.selfId) !== preferredNpcId
            && ItemTemplateIndex.find(DataCache.npcs, entry.selfId)?.template?.hostile === true)
        : [];
    const interruptionChance = Math.max(0, Math.min(1, number(options.aggressiveInterruptionChance, 0.25)));
    const selected = preferred && (!aggressive.length || rng() >= interruptionChance)
        ? preferred
        : pickEntry(aggressive.length ? aggressive : entries);
    const npc = ItemTemplateIndex.find(DataCache.npcs, selected?.selfId);
    if (!npc) return null;
    const combat = npcCombatStats(npc);
    const explicitRaid = options.allowRaid === true && spot.raidBoss === true;
    // A solo fight takes the whole pull of its spawn group (F20): one size of
    // the group's mix, among the sizes the hunter survives when safety judged it.
    const pull = options.pull && !explicitRaid
        ? BotPullEstimate.rollPulls(selected.match?.allowed || BotPullEstimate.pullsOf(selected), rng) : 0;
    const minionRows = explicitRaid
        ? RAID_MINIONS.filter((row) => number(row.bossId) === number(npc.selfId))
        : [];
    const minionPressure = minionRows.reduce((pressure, row) => {
        const minion = ItemTemplateIndex.find(DataCache.npcs, row.minionId);
        const profile = npcCombatStats(minion);
        const count = Math.max(0, number(row.max, row.min));
        if (!profile || !count) return pressure;
        pressure.count += count;
        pressure.hp += profile.maxHp * count;
        pressure.pAtk += profile.pAtk * count;
        return pressure;
    }, { count: 0, hp: 0, pAtk: 0 });
    const representedMinionHp = Math.round(minionPressure.hp * 0.35);
    const representedMinionPAtk = Math.round(minionPressure.pAtk * 0.5);
    return {
        selfId: number(npc.selfId),
        aggressiveInterruption: !!preferred && selected !== preferred,
        ...combat,
        // usualPull: the pull the verdict judged, the readiness after a win judges it too.
        ...(pull ? { pull, usualPull: pull } : {}),
        ...(explicitRaid ? {
            // Cold mode represents the raid group as one bounded encounter.
            // Adds contribute part of their HP and incoming damage instead of
            // disappearing merely because no live actors are materialized.
            maxHp: combat.maxHp + representedMinionHp,
            pAtk: combat.pAtk + representedMinionPAtk,
            raidBossMaxHp: combat.maxHp,
            raidBossPAtk: combat.pAtk,
            raidMinionHp: representedMinionHp,
            raidMinionPAtk: representedMinionPAtk,
            raidMinionCount: minionPressure.count
        } : {})
    };
}

// The kit parts' text forms (combatView over a state; a near bot's state is
// the row it posts). wornPart: the worn rows of a state-format inventory (null: none).
function wornPart(inventory, known = {}) {
    if (!inventory || typeof inventory !== 'object') return 'no-inventory';
    const rows = [];
    for (const item of Object.values(inventory)) {
        if (!item?.equipped) continue;
        const template = itemTemplate(item.selfId);
        if (template) known.worn = true;
        const amount = Math.max(0, number(item.amount, 1));
        const explicit = Array.isArray(item.equippedSlots)
            ? [...new Set(item.equippedSlots.map(Number).filter(slot => slot > 0))].slice(0, amount) : [];
        const slot = number(item.slot, number(template?.etc?.slot));
        const pair = [1, 2].includes(slot) ? [1, 2] : [4, 5].includes(slot) ? [4, 5] : [slot];
        const slots = explicit.length ? explicit : pair.slice(0, Math.min(amount, pair.length));
        for (const wornSlot of slots) {
            const instance = item.instances?.find(row => row.equipped && number(row.slot) === wornSlot);
            rows.push([Number(item.selfId), wornSlot, number(instance?.enchant, number(item.enchant))].join(':'));
        }
    }
    return rows.sort().join(',');
}
// The skills of a capture (stats.coldCombat).
function skillsPart(saved) {
    const source = ['database', 'hot'].includes(saved.skillSource) ? 'learned' : saved.skillSource;
    return Array.isArray(saved.skills) ? `${source}:${saved.skills.map(skill => `${skill.selfId}:${skill.level}`).sort().join(',')}` : '';
}
// The capture's numbers (stats.coldCombat); setEffects: its armour set
// effects when the state has no inventory to derive them (savedSetEffects).
function capturePart(saved, setEffects = [], worn = false) {
    // With a native worn bag gatherKit derives every equipment field from
    // those slots. The hot capture's redundant aggregate is not another kit.
    return JSON.stringify([saved.base || null, saved.henna || null, worn ? null : saved.equipment || null, ...setEffects]);
}
// The slow build inputs, no clock: class (saved, current), level, worn gear,
// hennas, skills, the hot capture. A new array per call.
function combatView(state) {
    const saved = state.stats?.coldCombat || {};
    const currentClassId = number(state.stats?.classId, number(state.classId));
    // Main publishes the current class in stats; worker hydration may also
    // carry its alias at the root. Both forms have the same native build.
    const known = {}, worn = wornPart(state.inventory, known);
    const hennas = [0, 1, 2].map(slot => number(state.stats?.hennas?.[slot]));
    return [number(saved.classId, currentClassId), currentClassId, state.level, worn,
        hennas.join(','), skillsPart(saved), capturePart(saved, savedSetEffects(state), known.worn)];
}
function buildHash(text) {
    return fnv1a32(text) * 2 ** 21 + (fnv1a32(text, 0x9e3779b9) & 0x1fffff);
}
// One small hash per kit part (combatView's), no clock, in a new array: the
// kit fact (DecisionSections.factsOf) and the kit profile store's hash.
function kitHash(parts) {
    const hashes = new Array(parts.length);
    for (let index = 0; index < parts.length; index++) hashes[index] = fnv1a32(String(parts[index]));
    return hashes;
}
function kitEvents(state = {}) {
    return kitHash(combatView(state));
}
// The stat sources of a fighter (whose profile is the one read) at a hit's
// time, held on the fighter for its fight (fightSources);
// undefined without one, so statMultiplier builds them for that hit.
function hitSources(fighter, timestamp) {
    if (!fighter) return undefined;
    fighter.statSources = fightSources(fighter.profile, timestamp, fighter.statSources || null);
    return fighter.statSources.sources;
}

// Cold adapters of CombatantView (HitRules, the hot Attack's rules), the
// cold fight's and the solo gate's (BotTargetMatchup): a fight
// profile as attacker and as defender, a monster (npcCombatStats or a pull
// view of it) likewise. One view per object: a profile is built per fight.
const attackerViews = new WeakMap(), defenderViews = new WeakMap();
function attackerView(subject, timestamp = Date.now(), fighter = null) {
    let view = attackerViews.get(subject);
    if (view) return view;
    if (subject.equipment) {
        const sources = hitSources(fighter, timestamp);
        view = CombatantView.view({ pAtk: subject.pAtk, pAtkRnd: subject.equipment.pAtkRnd, mAtk: subject.mAtk,
            critRate: subject.critical, mCritRate: subject.mCritRate, str: subject.str,
            critDamageMul: multiplier(subject, 'pCritDamageMul', timestamp, sources),
            critDamageAdd: add(subject, 'pCritDamageAdd', timestamp, sources) });
    } else {
        // A hot Npc's weapon hit has no spread (Attack.prepareNpcMeleeHit).
        view = CombatantView.view({ pAtk: subject.pAtk, mAtk: subject.mAtk, critRate: subject.critical, mCritRate: subject.mCritRate });
    }
    attackerViews.set(subject, view);
    return view;
}
function defenderView(subject, timestamp = Date.now(), fighter = null) {
    let view = defenderViews.get(subject);
    if (view) return view;
    if (subject.equipment) {
        const sources = hitSources(fighter, timestamp);
        view = CombatantView.view({ pDef: subject.pDef, mDef: subject.mDef, dex: subject.dex,
            shieldPDef: Number(subject.equipment.shieldPDef || 0) * multiplier(subject, 'sDefMul', timestamp, sources)
                + (Number(subject.equipment.shieldPDef) > 0 ? add(subject, 'sDefAdd', timestamp, sources) : 0),
            shieldRate: Number(subject.equipment.shieldRate || 0) * multiplier(subject, 'rShldMul', timestamp, sources) });
    } else {
        view = CombatantView.view({ pDef: subject.pDef, mDef: subject.mDef, dex: subject.dex,
            shieldPDef: subject.shieldPDef, shieldRate: subject.shieldRate });
    }
    defenderViews.set(subject, view);
    return view;
}

// A monster object whose numbers changed mid-fight (a self buff) is viewed anew.
function forgetViews(subject) {
    attackerViews.delete(subject);
    defenderViews.delete(subject);
}

function hitSucceeds(accuracy, evasion, rng) {
    return rng() < Formulas.hitChance(accuracy, evasion);
}

// A normal attack's hit chance for planning: Formulas.hitChance when both
// numbers are known, else 1 (a native target view carries neither).
function expectedHitChance(accuracy, evasion) {
    const known = value => value !== null && value !== undefined && Number.isFinite(Number(value));
    return known(accuracy) && known(evasion) ? Formulas.hitChance(accuracy, evasion) : 1;
}

// A skill takes its C4 cast time, cut by a loaded spiritshot; a skill row
// without a cast time falls back to 1000 ms (spell) or 600 ms (physical).
// A normal attack: normalAttackMs (a bow draws and reloads).
function actionDelayMs(profile, skill = null, spiritshot = false) {
    if (skill?.spell) {
        return Formulas.calcSkillHitTime(Number(skill.hitTime) || 1000, profile.castSpd, { magic: true, spiritshot });
    }
    if (skill) {
        return Formulas.calcSkillHitTime(Number(skill.hitTime) || 600, profile.atkSpd);
    }
    return normalAttackMs(profile);
}

// A servitor's time between hits (SummonControl: a monster's melee cycle).
function summonAttackMs(summon) {
    return Math.max(250, Formulas.calcMeleeAtkTime(Number(summon?.atkSpd) || 253));
}

// The shot a bot loads in one cold fight, decided once from its inventory:
// the kind and grade hot auto shots load (ShotStock.planForState), how many
// the weapon takes per charge and how many charges the stock still covers.
// Null when the bot holds none of that shot or its weapon takes none.
function shotSupply(state, timestamp) {
    const plan = ShotStock.combatPlanForState(state);
    const key = String(plan.selfId);
    const left = plan.perAction > 0 ? Math.floor(Number(state.inventory?.[key]?.amount || 0) / plan.perAction) : 0;
    if (left <= 0 || ShotStock.usePolicy(state, { timestamp, plan }).usePerHour <= 0) return null;
    return { key, timestamp, perAction: plan.perAction, left, soulshot: plan.kind === 'soulshot',
        spiritshot: plan.kind !== 'soulshot', blessedSpiritshot: plan.kind === 'blessedSpiritshot' };
}

// The shot an action loads from a supply (shotSupply), by the hot rule
// (ShotStock.actionShotKind): a spell a spiritshot, a physical skill a
// soulshot unless its ssBoost is 0, a normal attack (no skill) a soulshot.
// The supply when it holds that kind, otherwise null.
function actionShot(shot, skill = null) {
    if (!shot) return null;
    let kind = ShotStock.actionShotKind(false);
    if (skill) {
        const semantic = C4SkillRules.resolveCached(skill);
        kind = ShotStock.actionShotKind(semantic.isMagic ?? skill.spell === true, semantic.ssBoost);
    }
    if (kind === 'soulshot') return shot.soulshot ? shot : null;
    return kind && shot.spiritshot ? shot : null;
}

// How long a bot that pulls a melee-only monster (ColdMobAction.meleeOnly)
// hits before the monster closes in: the bot's reach beyond the monster's
// over the monster's run speed (C4: a bow shoots from 700, a caster nukes
// from its spells' cast range). 0 without a run speed; a fight the monster
// opens (an aggressive interruption) gives none (the caller's).
// How far the fighter strikes from: its weapon's range (a bow's with its
// range bonus), a caster's longest spell. It opens a fight from there
// (openingMs) and walks only that close to its next mob (soloWalkMs).
function attackReach(profile = {}) {
    const kind = profile.equipment?.weaponKind || '';
    let reach = AttackRange.kindRange(kind, kind === 'Weapon.Bow' ? add(profile, 'pAtkRangeAdd', Date.now()) : 0);
    if (BotRoles.usesCasterWeaponCombat(profile)) {
        for (const skill of offensiveSkills(profile)) {
            if (skill.spell) reach = Math.max(reach, number(C4SkillRules.resolveCached(skill).castRange ?? skill.distance));
        }
    }
    return reach;
}

function openingMs(profile = {}, mob = {}) {
    const speed = number(mob.runSpd);
    // lazy: cycle ColdMobAction loads this module
    if (!(speed > 0) || !invoke('GameServer/Bot/Population/ColdMobAction').meleeOnly(mob)) return 0;
    return Math.max(0, attackReach(profile) - number(mob.atkRadius)) / speed * 1000;
}

// Drops the bot's kit profiles (both slots).
function forgetBuild(characterId) {
    kitProfiles.delete(Number(characterId));
}
// The kit profile store's bots in this thread (the status line).
function kitStoreSize() { return kitProfiles.size; }

module.exports = {
    PROFILE_VERSION, classIdOf, capture, legacySnapshot, treeSnapshot, needsDatabaseBackfill, profileFor, buildCount, buildMs, withBuildSite,
    fightProfile, currentCp, seedSnapshot, oldSeedRepair, candidateProfiles, fightSources, combatView, kitHash, skillsFor, forgetBuild, kitStoreSize,
    isAttackSkill, offensiveSkills, summonDetails, summonSkills, corpseSummonSkills, activeMusicEffects, partyMusicSkills, partyMusicMpCost, partyMusicEffect, normalAttackMs,
    spotSpawns, npcForSpot, killDraw, killChances, npcCombatStats, skillSnapshotsFromRecords, skillRecordsFromTree, treeSkillLevel,
    statMultiplier: multiplier, statAdd: add, statSources,
    // The cold fight's views, hit roll, action times, shots and opening (BackgroundResolver, the solo gate).
    hitSources, attackerView, defenderView, forgetViews, hitSucceeds, expectedHitChance, actionDelayMs, summonAttackMs,
    shotSupply, actionShot, openingMs, attackReach,
    // The offline hunt tables (scripts/hunt-tables) sum a kit from their rows through the same numbers pass.
    profileNumbers, equipmentFromTemplates
};
