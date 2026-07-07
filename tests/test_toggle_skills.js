const assert = require('assert');

require('../src/Global');

const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
const SkillModel = invoke('GameServer/Model/Skill');
const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');

function actor(mp = 100) {
    return {
        level: 20,
        classId: 49,
        hp: 100,
        mp,
        packets: [],
        effects: {},
        fetchId() { return 2000001; },
        fetchLevel() { return this.level; },
        fetchClassId() { return this.classId; },
        fetchCon() { return 30; },
        fetchMen() { return 30; },
        fetchStr() { return 30; },
        fetchDex() { return 30; },
        fetchInt() { return 30; },
        fetchWit() { return 30; },
        fetchHp() { return this.hp; },
        fetchMp() { return this.mp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMaxMp() { return this.maxMp; },
        fetchPAtk() { return 10; },
        fetchMAtk() { return 10; },
        fetchPDef() { return 10; },
        fetchMDef() { return 10; },
        fetchAccur() { return 0; },
        fetchEvasion() { return 0; },
        fetchCritical() { return 40; },
        fetchAtkSpd() { return 300; },
        fetchCastSpd() { return 333; },
        fetchWalkSpd() { return 80; },
        fetchRunSpd() { return 120; },
        isSpellcaster() { return 0; },
        setMaxHp(value) { this.maxHp = value; },
        setHp(value) { this.hp = value; },
        setMaxMp(value) { this.maxMp = value; },
        setMp(value) { this.mp = value; },
        setMaxLoad(value) { this.maxLoad = value; },
        setLoad(value) { this.load = value; },
        setCollectivePAtk(value) { this.collectivePAtk = value; },
        setCollectiveMAtk(value) { this.collectiveMAtk = value; },
        setCollectivePDef(value) { this.collectivePDef = value; },
        setCollectiveMDef(value) { this.collectiveMDef = value; },
        setCollectiveAccur(value) { this.collectiveAccur = value; },
        setCollectiveEvasion(value) { this.collectiveEvasion = value; },
        setCollectiveCritical(value) { this.collectiveCritical = value; },
        setCollectiveAtkSpd(value) { this.collectiveAtkSpd = value; },
        setCollectiveCastSpd(value) { this.collectiveCastSpd = value; },
        setCollectiveWalkSpd(value) { this.collectiveWalkSpd = value; },
        setCollectiveRunSpd(value) { this.collectiveRunSpd = value; },
        statusUpdateVitals(target) {
            if (target === this) calculateStats({}, this);
        },
        backpack: {
            fetchTotalArmorBonusMp: () => 0,
            fetchTotalLoad: () => 0,
            fetchTotalWeaponPAtk: () => 100,
            fetchTotalWeaponMAtk: () => 50,
            fetchTotalArmorPDef: () => 100,
            fetchTotalArmorMDef: () => 80,
            fetchTotalWeaponAccur: () => 5,
            fetchTotalArmorEvasion: () => 2,
            fetchTotalWeaponCritical: () => 40,
            fetchTotalWeaponAtkSpd: () => 300
        }
    };
}

function session(target) {
    return {
        actor: target,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        }
    };
}

function soulCry(level = 2) {
    return new SkillModel({
        selfId: 1001,
        name: 'Soul Cry',
        level,
        passive: false,
        spell: false,
        power: 1,
        mp: 0,
        hp: 0,
        distance: -1
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    const orc = actor(100);
    const castSession = session(orc);
    const skill = soulCry(2);
    const basePAtk = Math.round(Formulas.calcPAtk(20, 30, 100));

    assert.strictEqual(ToggleSkills.isToggle(skill), true, 'Soul Cry should resolve as a toggle skill');
    assert.strictEqual(ToggleSkills.handleRequest(castSession, orc, skill), true, 'Soul Cry should be handled by toggle runtime');
    assert.strictEqual(orc.fetchMp(), 97, 'Soul Cry level 2 should consume sourced initial MP 3 on activation');
    assert.strictEqual(EffectStats.add(orc, 'pAtkAdd'), 14, 'Soul Cry level 2 should apply sourced additive P.Atk');
    assert.strictEqual(orc.collectivePAtk, basePAtk + 14, 'Soul Cry should refresh actor P.Atk while active');
    assert(castSession.packets.some((packet) => packet[0] === 0x7f), 'Soul Cry activation should refresh abnormal status icons');

    ToggleSkills.handleRequest(castSession, orc, skill);
    assert.strictEqual(EffectStats.add(orc, 'pAtkAdd'), 0, 'Second Soul Cry use should remove the toggle effect');
    assert.strictEqual(orc.collectivePAtk, basePAtk, 'Soul Cry removal should refresh actor P.Atk');

    const tiredOrc = actor(1);
    const tiredSession = session(tiredOrc);
    ToggleSkills.handleRequest(tiredSession, tiredOrc, soulCry(1));
    assert.strictEqual(EffectStore.list(tiredOrc).length, 0, 'Soul Cry should not activate without initial MP');
    assert.strictEqual(tiredOrc.fetchMp(), 1, 'Rejected Soul Cry activation should not consume MP');

    const drainingOrc = actor(3);
    const drainingSession = session(drainingOrc);
    const drainingSkill = soulCry(1);
    drainingSkill.fetchSemantic().toggleIntervalMs = 10;
    ToggleSkills.handleRequest(drainingSession, drainingOrc, drainingSkill);
    assert.strictEqual(drainingOrc.fetchMp(), 1, 'Soul Cry level 1 should consume sourced initial MP 2');
    assert.strictEqual(EffectStats.add(drainingOrc, 'pAtkAdd'), 4.5, 'Soul Cry level 1 should apply sourced additive P.Atk');

    await wait(30);
    assert.strictEqual(EffectStore.list(drainingOrc).length, 0, 'Soul Cry should auto-remove when periodic MP drain cannot be paid');
    assert.strictEqual(EffectStats.add(drainingOrc, 'pAtkAdd'), 0, 'Auto-removed Soul Cry should drop its P.Atk bonus');

    console.log('Toggle skill checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
