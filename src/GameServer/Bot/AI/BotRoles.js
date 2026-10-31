const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const BotClassProgression = invoke('GameServer/Bot/BotClassProgression');

const ROLE_CLASSES = {
    healer: [15, 16, 29, 30, 42, 43],
    buffer: [17, 21, 34, 49, 50, 51, 52],
    tank: [4, 5, 6, 19, 20, 32, 33],
    dagger: [7, 8, 23, 35, 36],
    archer: [9, 22, 24, 37],
    mage: [10, 11, 12, 13, 14, 25, 26, 27, 28, 38, 39, 40, 41],
    spoiler: [53, 54, 55],
    crafter: [56, 57]
};
const SUMMONER_CLASSES = new Set([14, 28, 41]);
// The first classes whose second classes split the kit they fight 20-39
// with: they fight with their own future second class's (user 10-30, class
// kits by C4 masteries). By weapon, bow or dagger (Rogue, Elven Scout,
// Assassin); by pet, a servitor or none (Wizard, Elven Wizard, Dark Wizard:
// a future summoner summons the cat it learns at 20, as in C4, T122).
const splitsBy = (next, holds) => next.some(holds) && next.some((id) => !holds(id));
const SPLIT_KIT_CLASSES = new Set(Object.entries(ClassProgression.secondProfMap)
    .filter(([, next]) => (next.some((id) => ROLE_CLASSES.archer.includes(id))
        && next.some((id) => ROLE_CLASSES.dagger.includes(id)))
        || splitsBy(next, (id) => SUMMONER_CLASSES.has(id)))
    .map(([classId]) => Number(classId)));
const DWARF_CLASS_IDS = new Set([53, 54, 55, 56, 57, 117, 118]);
const SPOILER_CLASS_IDS = new Set([53, 54, 55, 117]);
// The C4 craft classes: Artisan, Warsmith and Maestro. Spoiler dwarves learn
// Create Item from their class line but do not craft.
const CRAFTER_CLASS_IDS = new Set([56, 57, 118]);
const MANA_REST_ROLES = new Set(['mage', 'archer', 'healer']);
// Prophet and the Orc mystic line cast as their primary party job. Sword
// Singer and Bladedancer share the buffer role, but they are melee fighters
// whose combat loop must not stop merely because their MP is low.
const CASTER_BUFFER_CLASSES = new Set([17, 49, 50, 51, 52]);
const PARTY_MUSIC_CLASSES = new Set([21, 34]);
const NECROMANCER_CLASSES = new Set([13]);

function classIdOf(value) {
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (value && typeof value.fetchClassId === 'function') return value.fetchClassId();
    if (value?.classId !== null && value?.classId !== undefined) return Number(value.classId);
    if (value?.stats?.classId !== null && value?.stats?.classId !== undefined) return Number(value.stats.classId);
    if (value?.stats?.classProgressionClassId !== null && value?.stats?.classProgressionClassId !== undefined) {
        return Number(value.stats.classProgressionClassId);
    }
    return null;
}

function normalizedClassId(value) {
    const classId = classIdOf(value);
    if (classId === null || classId === undefined || classId === '') return null;
    const number = Number(classId);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function className(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return null;
    return ClassProgression.firstClassRow(DataCache.classTemplates || [], classId)
        ?.template?.class || null;
}

function presentation(value) {
    const classId = normalizedClassId(value);
    return {
        classId,
        className: className(value),
        role: inferRole(value)
    };
}

function roleClassId(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return null;
    return Number(ClassProgression.getThirdClass(classId)?.parentClassId || classId);
}

// A bot's character id, null for a player: the future class is the bots' own
// draw (BotClassProgression), a player picks its second class itself. A live
// actor is a bot by its session; a state row by its bot_ account (a cold
// state without one is a bot's).
function botCharacterIdOf(value) {
    if (!value || typeof value !== 'object') return null;
    const actor = typeof value.fetchId === 'function';
    if (actor ? value.session?.botSession !== true
        : value.accountName && !String(value.accountName).startsWith('bot_')) return null;
    const id = Number(actor ? value.fetchId() : value.characterId);
    return Number.isInteger(id) && id > 0 ? id : null;
}

// The future second class whose kit (weapon, pet) a split-kit first class
// fights with, or null (a class-only value, a player, or any other class).
function kitClassId(value) {
    const classId = roleClassId(value);
    if (!SPLIT_KIT_CLASSES.has(classId)) return null;
    const id = botCharacterIdOf(value);
    return id === null ? null : BotClassProgression.futureClass(classId, id);
}

function levelOf(value) {
    const raw = value && typeof value.fetchLevel === 'function'
        ? value.fetchLevel()
        : value?.level ?? value?.stats?.level;
    const level = Number(raw);
    return Number.isFinite(level) && level > 0 ? level : null;
}

function isSpoiler(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return false;

    const baseClassId = roleClassId(value);
    if (SPOILER_CLASS_IDS.has(classId) || SPOILER_CLASS_IDS.has(baseClassId)) return true;

    const level = levelOf(value);
    return DWARF_CLASS_IDS.has(classId) && level !== null && level < 40;
}

function isCrafterClass(value) {
    return CRAFTER_CLASS_IDS.has(normalizedClassId(value));
}

function inferRole(value) {
    const future = kitClassId(value);
    if (future !== null) return inferRole(future);
    const classId = roleClassId(value);
    if (classId === null || classId === undefined) return 'dps';

    if (isSpoiler(value)) return 'spoiler';
    if (ROLE_CLASSES.healer.includes(classId)) return 'healer';
    if (ROLE_CLASSES.buffer.includes(classId)) return 'buffer';
    if (ROLE_CLASSES.tank.includes(classId)) return 'tank';
    if (ROLE_CLASSES.dagger.includes(classId)) return 'dagger';
    if (ROLE_CLASSES.archer.includes(classId)) return 'archer';
    if (ROLE_CLASSES.mage.includes(classId)) return 'mage';
    if (ROLE_CLASSES.crafter.includes(classId)) return 'crafter';
    return 'dps';
}

// The table roles of their own (T106): summoners fight with a pet (isSummoner),
// orc chanters by their own line, not as the role's measured class.
const CHANTER_TABLE_CLASSES = new Set([49, 50, 51, 52]);

// The game table's role of a bot (SpotValueTable roles): its party role, else
// its own. crafter -> spoiler is the author's call (the table has no crafter).
function tableRoleFor(state = {}) {
    const role = state.party?.role || state.stats?.role
        || inferRole({ classId: state.stats?.classId || state.classId || 0, characterId: state.characterId });
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    const classId = roleClassId(state.stats?.classId ?? state.classId ?? null);
    if (tableRole === 'mage' && isSummoner({ classId, characterId: state.characterId })) return 'summoner';
    if (tableRole === 'buffer' && CHANTER_TABLE_CLASSES.has(classId)) return 'chanter';
    return tableRole;
}

function isRole(value, role) {
    if (role === 'spoiler') return isSpoiler(value);
    if (role === 'crafter' && isSpoiler(value)) return false;
    const classId = roleClassId(value);
    const classes = ROLE_CLASSES[role];
    return !!classes && classes.includes(classId);
}

// Crafting remains a separate economic identity, but until its dedicated
// combat policy exists a non-spoiler dwarf should fight as a normal DPS.
function combatRoleFor(value) {
    if (isSpoiler(value)) return 'spoiler';
    const role = inferRole(value);
    return role === 'crafter' && DWARF_CLASS_IDS.has(normalizedClassId(value)) ? 'dps' : role;
}

function isHealer(value) {
    return isRole(value, 'healer');
}

function usesCasterWeaponCombat(value) {
    // Class identity owns this policy, even if a bot temporarily equips a
    // different weapon. Orc mystics, Sword Singers, and Bladedancers retain
    // their melee support style; Prophet belongs with the staff casters.
    const role = inferRole(value);
    return role === 'mage' || role === 'healer' || roleClassId(value) === 17;
}

function isTank(value) {
    return isRole(value, 'tank');
}

// A summoner fights with its servitor: a summoner class, or a bot's first
// class whose future second class is one (kitClassId; a Wizard heading for
// Warlock, T122). A future Sorcerer or Necromancer Wizard learns the cat too,
// but no rule prices a pet for a non-summoner: it fights without one.
function isSummoner(value) {
    return SUMMONER_CLASSES.has(kitClassId(value) ?? roleClassId(value));
}

function isNecromancer(value) {
    return NECROMANCER_CLASSES.has(roleClassId(value));
}

function canBuff(value) {
    return isRole(value, 'buffer');
}

function isHealingBuffer(value) {
    return CASTER_BUFFER_CLASSES.has(roleClassId(value));
}

function isPartyMusicFighter(value) {
    return PARTY_MUSIC_CLASSES.has(roleClassId(value));
}

function isPartyCasterSupport(value) {
    return isHealer(value) || isHealingBuffer(value);
}

function shouldRestForMana(value) {
    const role = inferRole(value);
    return MANA_REST_ROLES.has(role) || (
        role === 'buffer' && CASTER_BUFFER_CLASSES.has(roleClassId(value))
    );
}

// Sitting and receiving Recharge are separate policies. Tanks and music
// fighters stay with the melee line, but still need MP for taunts and rebuffs.
function needsPartyManaRecovery(value) {
    return shouldRestForMana(value) || isPartyMusicFighter(value) || inferRole(value) === 'tank';
}

function isRanged(roleOrActor) {
    const role = typeof roleOrActor === 'string' ? roleOrActor : inferRole(roleOrActor);
    return role === 'archer' || role === 'mage';
}

function hasMeleeWeapon(actor) {
    const weapon = actor?.backpack?.fetchEquippedWeapon?.();
    if (!weapon) return false;

    const kind = String(weapon.fetchKind?.() || '');
    const name = String(weapon.fetchName?.() || '');
    const casterWeapon = BotWeaponCompatibility.isCasterWeapon(
        kind,
        name,
        weapon.fetchPAtk?.(),
        weapon.fetchMAtk?.()
    );
    return kind.startsWith('Weapon.') && kind !== 'Weapon.Bow' && !casterWeapon;
}

function partyRoleStance(role) {
    if (role === 'healer') return 'support';
    if (role === 'buffer') return 'buff_support';
    if (role === 'tank') return 'protector';
    if (role === 'dagger') return 'flank_assist';
    if (role === 'archer' || role === 'mage') return 'ranged_assist';
    return 'assist';
}

module.exports = {
    classIdOf,
    ROLE_CLASSES,
    SUMMONER_CLASSES,
    NECROMANCER_CLASSES,
    className,
    roleClassId,
    kitClassId,
    botCharacterId: botCharacterIdOf,
    isSpoiler,
    isCrafterClass,
    presentation,
    inferRole,
    tableRoleFor,
    combatRoleFor,
    isRole,
    isHealer,
    usesCasterWeaponCombat,
    isTank,
    isSummoner,
    isNecromancer,
    canBuff,
    isHealingBuffer,
    isPartyMusicFighter,
    isPartyCasterSupport,
    shouldRestForMana,
    needsPartyManaRecovery,
    isRanged,
    hasMeleeWeapon,
    partyRoleStance
};
