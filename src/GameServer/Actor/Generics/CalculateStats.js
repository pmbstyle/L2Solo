const Formulas = invoke('GameServer/Formulas');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const C4GradePenalty = invoke('GameServer/Items/C4GradePenalty');

function effectiveBaseStat(actor, stat, fallback) {
    const base = Number(fallback()) || 0;
    const added = base + EffectStats.add(actor, stat);
    return Math.max(1, Math.round(added * EffectStats.multiplier(actor, `${stat}Mul`)));
}

function setCollectiveTotalHp(actor) {
    const con = effectiveBaseStat(actor, 'CON', () => actor.fetchCon());
    const base = (Formulas.calcHp(actor.fetchLevel(), actor.fetchClassId(), con) * EffectStats.multiplier(actor, 'maxHpMul')) + EffectStats.add(actor, 'maxHpAdd');
    actor.setMaxHp(base);
    actor.setHp(Math.min(actor.fetchHp(), actor.fetchMaxHp()));
}

function getClassTransfer(classId) {
    const baseClasses = [0, 10, 18, 25, 31, 38, 44, 49, 53];
    if (baseClasses.includes(classId)) return 0;
    const firstProfClasses = [1, 4, 7, 11, 15, 19, 22, 26, 29, 32, 35, 39, 42, 45, 47, 50, 54, 56];
    if (firstProfClasses.includes(classId)) return 1;
    return 2;
}

function setCollectiveTotalMp(actor) {
    const transfer = getClassTransfer(actor.fetchClassId());
    const men = effectiveBaseStat(actor, 'MEN', () => actor.fetchMen());
    const base  = Formulas.calcMp(actor.fetchLevel(), actor.isSpellcaster(), transfer, men);
    const bonus = actor.backpack.fetchTotalArmorBonusMp();
    actor.setMaxMp(((base + bonus) * EffectStats.multiplier(actor, 'maxMpMul')) + EffectStats.add(actor, 'maxMpAdd'));
    actor.setMp(Math.min(actor.fetchMp(), actor.fetchMaxMp()));
}

function setCollectiveTotalCp(actor) {
    if (typeof actor.setMaxCp !== 'function' || typeof actor.setCp !== 'function') return;

    const previousMaxCp = Number(actor.fetchMaxCp?.()) || 0;
    const con = effectiveBaseStat(actor, 'CON', () => actor.fetchCon());
    const base = Formulas.calcCp(actor.fetchLevel(), actor.fetchClassId(), con);
    actor.setMaxCp((base * EffectStats.multiplier(actor, 'maxCpMul')) + EffectStats.add(actor, 'maxCpAdd'));

    if (previousMaxCp <= 0) {
        actor.setCp(actor.fetchMaxCp());
    } else {
        actor.setCp(Math.min(actor.fetchCp(), actor.fetchMaxCp()));
    }
}

function setCollectiveTotalLoad(actor) {
    const con = effectiveBaseStat(actor, 'CON', () => actor.fetchCon());
    const base = Formulas.calcMaxLoad(con) + EffectStats.add(actor, 'maxLoad');
    actor.setMaxLoad(base);
    actor.setLoad(actor.backpack.fetchTotalLoad());
}

function setCollectiveTotalPAtk(actor) {
    const pAtk = actor.backpack.fetchTotalWeaponPAtk() ?? actor.fetchPAtk();
    const str = effectiveBaseStat(actor, 'STR', () => actor.fetchStr());
    let base = Formulas.calcPAtk(actor.fetchLevel(), str, pAtk);
    base = Math.round(base * legacyBuffMultiplier(actor, 'might', 'pAtkMul'));
    base = Math.round(base * EffectStats.multiplier(actor, 'pAtkMul'));
    base += EffectStats.add(actor, 'pAtkAdd');
    actor.setCollectivePAtk(base);
}

function setCollectiveTotalMAtk(actor) {
    const mAtk = actor.backpack.fetchTotalWeaponMAtk() ?? actor.fetchMAtk();
    const int = effectiveBaseStat(actor, 'INT', () => actor.fetchInt());
    let base = Formulas.calcMAtk(actor.fetchLevel(), int, mAtk);
    base = Math.round(base * EffectStats.multiplier(actor, 'mAtkMul'));
    base += EffectStats.add(actor, 'mAtkAdd');
    actor.setCollectiveMAtk(base);
}

function setCollectiveTotalPDef(actor) {
    const pDef = actor.backpack.fetchTotalArmorPDef(actor.isSpellcaster()) ?? actor.fetchPDef();
    let base = Formulas.calcPDef(actor.fetchLevel(), pDef);
    base = Math.round(base * legacyBuffMultiplier(actor, 'shield', 'pDefMul'));
    base = Math.round(base * EffectStats.multiplier(actor, 'pDefMul'));
    base += EffectStats.add(actor, 'pDefAdd');
    actor.setCollectivePDef(base);
}

function setCollectiveTotalMDef(actor) {
    const mDef = actor.backpack.fetchTotalArmorMDef() ?? actor.fetchMDef();
    const men = effectiveBaseStat(actor, 'MEN', () => actor.fetchMen());
    let base = Formulas.calcMDef(actor.fetchLevel(), men, mDef);
    base = Math.round(base * EffectStats.multiplier(actor, 'mDefMul'));
    base += EffectStats.add(actor, 'mDefAdd');
    actor.setCollectiveMDef(base);
}

function setCollectiveTotalAccur(actor) {
    const accur = actor.backpack.fetchTotalWeaponAccur() ?? actor.fetchAccur();
    const dex = effectiveBaseStat(actor, 'DEX', () => actor.fetchDex());
    const base  = Formulas.calcAccur(actor.fetchLevel(), dex, accur) + EffectStats.add(actor, 'pAccuracyCombatAdd');
    actor.setCollectiveAccur(base);
}

function setCollectiveTotalEvasion(actor) {
    const evasion = actor.backpack.fetchTotalArmorEvasion() ?? actor.fetchEvasion();
    const dex = effectiveBaseStat(actor, 'DEX', () => actor.fetchDex());
    let base = Formulas.calcEvasion(actor.fetchLevel(), dex, evasion) + EffectStats.add(actor, 'pEvasionRateAdd');
    base = Math.round(base * EffectStats.multiplier(actor, 'pEvasionMul'));
    actor.setCollectiveEvasion(base);
}

function setCollectiveTotalCritical(actor) {
    const critical = actor.backpack.fetchTotalWeaponCritical() ?? actor.fetchCritical();
    const dex = effectiveBaseStat(actor, 'DEX', () => actor.fetchDex());
    const base    = (Formulas.calcCritical(dex, critical) * EffectStats.multiplier(actor, 'pCritRateMul')) + EffectStats.add(actor, 'pCritRateAdd');
    actor.setCollectiveCritical(base);
}

function setCollectiveTotalAtkSpd(actor) {
    const atkSpd = actor.backpack.fetchTotalWeaponAtkSpd() ?? actor.fetchAtkSpd();
    const dex = effectiveBaseStat(actor, 'DEX', () => actor.fetchDex());
    let base   = Formulas.calcAtkSpd(dex, atkSpd);
    base = Math.round(base * legacyBuffMultiplier(actor, 'haste', 'pAtkSpdMul'));
    base = Math.round(base * EffectStats.multiplier(actor, 'pAtkSpdMul'));
    actor.setCollectiveAtkSpd(base);
}

function setCollectiveTotalCastSpd(actor) {
    const wit = effectiveBaseStat(actor, 'WIT', () => actor.fetchWit());
    let base = Formulas.calcCastSpd(wit);
    base = Math.round(base * EffectStats.multiplier(actor, 'castSpdMul'));
    actor.setCollectiveCastSpd(base);
}

function setCollectiveTotalWalkSpd(actor) {
    const dex = effectiveBaseStat(actor, 'DEX', () => actor.fetchDex());
    const base = Formulas.calcSpeed(dex, actor.fetchWalkSpd());
    actor.setCollectiveWalkSpd(base);
}

function setCollectiveTotalRunSpd(actor) {
    const dex = effectiveBaseStat(actor, 'DEX', () => actor.fetchDex());
    let base = Formulas.calcSpeed(dex, actor.fetchRunSpd());
    base += legacyBuffAdd(actor, 'windwalk', 'runSpdAdd');
    base += EffectStats.add(actor, 'runSpdAdd');
    const effectMultiplier = EffectStats.multiplier(actor, 'runSpdMul');
    if (effectMultiplier !== 1) {
        base = Math.round(base * effectMultiplier);
    }
    actor.setCollectiveRunSpd(base);
}

function hasStructuredBuffStat(actor, typeOrKey, stat) {
    const buff = BuffCatalog.byTypeOrKey(typeOrKey);
    if (!buff) return false;
    return EffectStore.list(actor).some((effect) => (
        effect.key === buff.key && Number.isFinite(Number(effect.stats?.[stat]))
    ));
}

function legacyBuffMultiplier(actor, typeOrKey, stat, fallback = 1) {
    if (hasStructuredBuffStat(actor, typeOrKey, stat)) return fallback;
    return BuffCatalog.statMultiplier(actor, typeOrKey, stat, fallback);
}

function legacyBuffAdd(actor, typeOrKey, stat, fallback = 0) {
    if (hasStructuredBuffStat(actor, typeOrKey, stat)) return fallback;
    return BuffCatalog.statAdd(actor, typeOrKey, stat, fallback);
}

function calculateStats(session, actor) {
    C4GradePenalty.sync(actor);
    actor.backpack?.syncEquipmentItemSkills?.(actor);
    setCollectiveTotalHp      (actor);
    setCollectiveTotalMp      (actor);
    setCollectiveTotalCp      (actor);
    setCollectiveTotalLoad    (actor);
    setCollectiveTotalPAtk    (actor);
    setCollectiveTotalMAtk    (actor);
    setCollectiveTotalPDef    (actor);
    setCollectiveTotalMDef    (actor);
    setCollectiveTotalAccur   (actor);
    setCollectiveTotalEvasion (actor);
    setCollectiveTotalCritical(actor);
    setCollectiveTotalAtkSpd  (actor);
    setCollectiveTotalCastSpd (actor);
    setCollectiveTotalWalkSpd (actor);
    setCollectiveTotalRunSpd  (actor);
}

module.exports = calculateStats;
