const Formulas = invoke('GameServer/Formulas');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');
const EffectStats = invoke('GameServer/Effects/EffectStats');

function setCollectiveTotalHp(actor) {
    const base = Formulas.calcHp(actor.fetchLevel(), actor.fetchClassId(), actor.fetchCon()) * EffectStats.multiplier(actor, 'maxHpMul');
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
    const base  = Formulas.calcMp(actor.fetchLevel(), actor.isSpellcaster(), transfer, actor.fetchMen());
    const bonus = actor.backpack.fetchTotalArmorBonusMp();
    actor.setMaxMp((base + bonus) * EffectStats.multiplier(actor, 'maxMpMul'));
    actor.setMp(Math.min(actor.fetchMp(), actor.fetchMaxMp()));
}

function setCollectiveTotalLoad(actor) {
    const base = Formulas.calcMaxLoad(actor.fetchCon());
    actor.setMaxLoad(base);
    actor.setLoad(actor.backpack.fetchTotalLoad());
}

function setCollectiveTotalPAtk(actor) {
    const pAtk = actor.backpack.fetchTotalWeaponPAtk() ?? actor.fetchPAtk();
    let base = Formulas.calcPAtk(actor.fetchLevel(), actor.fetchStr(), pAtk);
    base = Math.round(base * BuffCatalog.statMultiplier(actor, 'might', 'pAtkMul'));
    base = Math.round(base * EffectStats.multiplier(actor, 'pAtkMul'));
    actor.setCollectivePAtk(base);
}

function setCollectiveTotalMAtk(actor) {
    const mAtk = actor.backpack.fetchTotalWeaponMAtk() ?? actor.fetchMAtk();
    let base = Formulas.calcMAtk(actor.fetchLevel(), actor.fetchInt(), mAtk);
    base = Math.round(base * EffectStats.multiplier(actor, 'mAtkMul'));
    actor.setCollectiveMAtk(base);
}

function setCollectiveTotalPDef(actor) {
    const pDef = actor.backpack.fetchTotalArmorPDef(actor.isSpellcaster()) ?? actor.fetchPDef();
    let base = Formulas.calcPDef(actor.fetchLevel(), pDef);
    base = Math.round(base * BuffCatalog.statMultiplier(actor, 'shield', 'pDefMul'));
    base = Math.round(base * EffectStats.multiplier(actor, 'pDefMul'));
    actor.setCollectivePDef(base);
}

function setCollectiveTotalMDef(actor) {
    const mDef = actor.backpack.fetchTotalArmorMDef() ?? actor.fetchMDef();
    let base = Formulas.calcMDef(actor.fetchLevel(), actor.fetchMen(), mDef);
    base = Math.round(base * EffectStats.multiplier(actor, 'mDefMul'));
    actor.setCollectiveMDef(base);
}

function setCollectiveTotalAccur(actor) {
    const accur = actor.backpack.fetchTotalWeaponAccur() ?? actor.fetchAccur();
    const base  = Formulas.calcAccur(actor.fetchLevel(), actor.fetchDex(), accur);
    actor.setCollectiveAccur(base);
}

function setCollectiveTotalEvasion(actor) {
    const evasion = actor.backpack.fetchTotalArmorEvasion() ?? actor.fetchEvasion();
    const base    = Formulas.calcEvasion(actor.fetchLevel(), actor.fetchDex(), evasion);
    actor.setCollectiveEvasion(base);
}

function setCollectiveTotalCritical(actor) {
    const critical = actor.backpack.fetchTotalWeaponCritical() ?? actor.fetchCritical();
    const base    = Formulas.calcCritical(actor.fetchDex(), critical) + EffectStats.add(actor, 'pCritRateAdd');
    actor.setCollectiveCritical(base);
}

function setCollectiveTotalAtkSpd(actor) {
    const atkSpd = actor.backpack.fetchTotalWeaponAtkSpd() ?? actor.fetchAtkSpd();
    let base   = Formulas.calcAtkSpd(actor.fetchDex(), atkSpd);
    base = Math.round(base * BuffCatalog.statMultiplier(actor, 'haste', 'pAtkSpdMul'));
    actor.setCollectiveAtkSpd(base);
}

function setCollectiveTotalCastSpd(actor) {
    let base = Formulas.calcCastSpd(actor.fetchWit());
    base = Math.round(base * EffectStats.multiplier(actor, 'castSpdMul'));
    actor.setCollectiveCastSpd(base);
}

function setCollectiveTotalWalkSpd(actor) {
    const base = Formulas.calcSpeed(actor.fetchDex(), actor.fetchWalkSpd());
    actor.setCollectiveWalkSpd(base);
}

function setCollectiveTotalRunSpd(actor) {
    let base = Formulas.calcSpeed(actor.fetchDex(), actor.fetchRunSpd());
    base += BuffCatalog.statAdd(actor, 'windwalk', 'runSpdAdd');
    const effectMultiplier = EffectStats.multiplier(actor, 'runSpdMul');
    if (effectMultiplier !== 1) {
        base = Math.round(base * effectMultiplier);
    }
    actor.setCollectiveRunSpd(base);
}

function calculateStats(session, actor) {
    setCollectiveTotalHp      (actor);
    setCollectiveTotalMp      (actor);
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
