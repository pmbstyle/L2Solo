const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
// The cold profile owner; a profile-less state reads its class tree.
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

// ARCH-NOTE: native FirstPrice needs seated recovery time in the clan worker.
// Share the resolver's unchanged calculation without its ChargeLifecycle/network
// imports; the authored regeneration and class tables arrive once per worker.

function midpointBand(levelBand) {
    if (!levelBand) return 1;
    const parts = String(levelBand).split('-').map((value) => Number(value));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return Number(parts[0]) || 1;
    return Math.round((parts[0] + parts[1]) / 2);
}


// The regen terms (regHp, regMp multipliers; regHpAdd, regMpAdd) of a
// profile's passives and buffs at rest (seated) or on its feet, with its kit
// deciding their armour conditions (ColdCombatProfile.statSources, the hot
// EffectStats rule: Mana Recovery in a robe, Clear Mind only standing). A
// kit profile without buffs is read once per state of rest.
const kitTerms = new WeakMap();
function regenTerms(profile, seated, timestamp) {
    const still = !(profile.effects?.length);
    const held = still ? kitTerms.get(profile) : null;
    if (held?.[seated]) return held[seated];
    const P = ColdCombatProfile, sources = P.statSources(profile, timestamp, { seated });
    const terms = { regHp: P.statMultiplier(profile, 'regHp', timestamp, sources), regHpAdd: P.statAdd(profile, 'regHpAdd', timestamp, sources),
        regMp: P.statMultiplier(profile, 'regMp', timestamp, sources), regMpAdd: P.statAdd(profile, 'regMpAdd', timestamp, sources) };
    if (still) kitTerms.set(profile, { ...held, [seated]: terms });
    return terms;
}
// A state without a profile: a bot's stored kit profile, else (a class at a
// level, no bot) its class tree's skills with no kit (once per class and level).
const treeProfiles = new Map();
let profileTree = null;
function restProfile(state, classId, level, timestamp) {
    if (state.characterId) return ColdCombatProfile.profileFor(state, timestamp);
    if (profileTree !== DataCache.skillTree) { treeProfiles.clear(); profileTree = DataCache.skillTree; }
    const key = `${classId}:${level}`;
    let profile = treeProfiles.get(key);
    if (!profile) treeProfiles.set(key, profile = { skills: ColdCombatProfile.skillsFor({ level, stats: { classId } }, classId, level), equipment: {}, effects: [] });
    return profile;
}

// One regeneration tick, seated (C4 x1.5) or standing still (options.standing:
// x1.1, Formulas.java calcHpRegen/calcMpRegen; Automation.fetchRegenStateMultiplier
// hot). options.stats: the kit's effective { con, men } (a kit profile,
// HuntCycle); unset, the profile's, else the class template's base stats.
// options.profile: the bot's cold profile (its passives, buffs and kit).
function coldRestRegenPerTick(state, options = {}) {
    const level = Math.max(1, Number(state.level || midpointBand(state.levelBand)) || 1);
    const classId = Number(state.stats?.classId ?? state.classId);
    const timestamp = options.timestamp ?? Date.now();
    const profile = options.profile || restProfile(state, classId, level, timestamp);
    const baseStats = options.stats || (profile.men && profile.con ? profile : null)
        || (ClassProgression.firstClassRow(DataCache.classTemplates || [], classId) || {}).base || {};
    const seated = options.standing !== true;
    const terms = regenTerms(profile, seated, timestamp);
    const hpBase = Number(DataCache.revitalize?.hp?.[level]) || 0;
    const mpBase = Number(DataCache.revitalize?.mp?.[level]) || 0;
    const stateMul = seated ? 1.5 : 1.1;
    const hp = ((hpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.CON(Number(baseStats.con) || 1) * terms.regHp)
        + terms.regHpAdd) * stateMul;
    const mp = ((mpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.MEN(Number(baseStats.men) || 1) * terms.regMp)
        + terms.regMpAdd) * stateMul;

    return { hp: Math.max(0, hp) * (options.hpMultiplier || 1), mp: Math.max(0, mp) * (options.mpMultiplier || 1) };
}

function requiresManaRecovery(state, options = {}) {
    if (typeof options.requireMana === 'boolean') return options.requireMana;
    return RestPolicy.sitsForMana(state, options.party === true);
}

// The tick of a rest that refills missingHp and missingMp: seated, or
// standing when that refills it faster (RestPolicy.sitsToRest; standing: true
// on the answer). options as coldRestRegenPerTick's.
function restRegenPerTick(state, missingHp, missingMp, options = {}) {
    const seated = coldRestRegenPerTick(state, options);
    const standing = coldRestRegenPerTick(state, { ...options, standing: true });
    return RestPolicy.sitsToRest(seated, standing, missingHp, missingMp, requiresManaRecovery(state, options))
        ? seated : { ...standing, standing: true };
}

// The MP a rest for mana wins back per tick, in its faster posture (the
// T100 MP price's rate: a bot short of MP only).
function restMpPerTick(state, options = {}) {
    return Math.max(coldRestRegenPerTick(state, options).mp, coldRestRegenPerTick(state, { ...options, standing: true }).mp);
}

// The rest seconds that refill missingHp and missingMp (MP only for a bot
// that sits for mana, RestPolicy.sitsForMana), in the rest's posture
// (restRegenPerTick). options.regen: a tick the caller holds.
function restSeconds(state, missingHp, missingMp, options = {}) {
    const regen = options.regen || restRegenPerTick(state, missingHp, missingMp, options);
    const hpSeconds = Math.max(0, missingHp) / Math.max(0.01, regen.hp / (Formulas.REGEN_TICK_MS / 1000));
    const mpSeconds = requiresManaRecovery(state, options)
        ? Math.max(0, missingMp) / Math.max(0.01, regen.mp / (Formulas.REGEN_TICK_MS / 1000))
        : 0;
    return Math.max(hpSeconds, mpSeconds);
}

function estimateRestMs(state, vitals, options = {}) {
    const maxHp = Number(vitals.maxHp || vitals.hp || 1);
    const maxMp = Number(vitals.maxMp || vitals.mp || 1);
    return Math.round(Math.max(restSeconds(state, maxHp - Number(vitals.hp || 0), maxMp - Number(vitals.mp || 0), options), 8) * 1000);
}

module.exports = { coldRestRegenPerTick, restRegenPerTick, restMpPerTick, requiresManaRecovery, restSeconds, estimateRestMs };
