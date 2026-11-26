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
    return toggleSkill(1001, 'Soul Cry', level);
}

function toggleSkill(selfId, name, level) {
    return new SkillModel({
        selfId,
        name,
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

    const knight = actor(100);
    const guardStance = toggleSkill(288, 'Guard Stance', 4);
    ToggleSkills.handleRequest(session(knight), knight, guardStance);
    assert.strictEqual(EffectStats.add(knight, 'pDefAdd'), 256.5, 'Guard Stance should apply sourced P.Def at level 4');
    assert.strictEqual(EffectStats.multiplier(knight, 'rShldMul'), 1.5, 'Guard Stance should apply sourced shield-rate multiplier');

    const dagger = actor(100);
    const viciousStance = toggleSkill(312, 'Vicious Stance', 20);
    ToggleSkills.handleRequest(session(dagger), dagger, viciousStance);
    assert.strictEqual(dagger.fetchMp(), 86, 'Vicious Stance should consume sourced initial MP at level 20');
    assert.strictEqual(EffectStats.add(dagger, 'pCritDamageAdd'), 609, 'Vicious Stance should apply sourced critical damage bonus');
    assert.strictEqual(
        Formulas.calcMeleeDamage(100, 0, 50, { critical: true, criticalDamageAdd: EffectStats.add(dagger, 'pCritDamageAdd') }),
        1132.6,
        'Vicious Stance bonus should be consumed by the critical damage formula'
    );

    const summoner = actor(100);
    const soulGuard = toggleSkill(1283, 'Soul Guard', 13);
    ToggleSkills.handleRequest(session(summoner), summoner, soulGuard);
    assert.strictEqual(summoner.fetchMp(), 86, 'Soul Guard should consume sourced initial MP at level 13');
    assert.strictEqual(EffectStats.add(summoner, 'pDefAdd'), 653.1, 'Soul Guard should apply sourced P.Def at level 13');

    const restingSummoner = actor(100);
    Object.assign(restingSummoner, { fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 });
    restingSummoner.state = {
        seated: false,
        fetchSeated() { return this.seated; },
        setSeated(value) { this.seated = value; },
        fetchAnimated: () => false,
        setAnimated() {},
        fetchCasts: () => false,
        fetchHits: () => false
    };
    const chameleonRest = toggleSkill(296, 'Rest of Chameleon', 1);
    ToggleSkills.handleRequest({ ...session(restingSummoner), dataSendToMeAndOthers() {} }, restingSummoner, chameleonRest);
    assert.strictEqual(restingSummoner.state.fetchSeated(), true, 'Rest of Chameleon should sit the caster down');
    assert.strictEqual(restingSummoner.silentMoving, true, 'Rest of Chameleon should enable silent moving while resting');
    assert.strictEqual(restingSummoner.fetchMp(), 91, 'Rest of Chameleon should consume sourced 9 initial MP');
    assert.strictEqual(EffectStore.list(restingSummoner)[0].manaDot.damage, 6, 'Rest of Chameleon should consume sourced 6 MP per tick');
    ToggleSkills.handleRequest({ ...session(restingSummoner), dataSendToMeAndOthers() {} }, restingSummoner, chameleonRest);
    assert.strictEqual(restingSummoner.silentMoving, false, 'Stopping Rest of Chameleon should clear silent moving');

    const tiredOrc = actor(1);
    const tiredSession = session(tiredOrc);
    ToggleSkills.handleRequest(tiredSession, tiredOrc, soulCry(1));
    assert.strictEqual(EffectStore.list(tiredOrc).length, 0, 'Soul Cry should not activate without initial MP');
    assert.strictEqual(tiredOrc.fetchMp(), 1, 'Rejected Soul Cry activation should not consume MP');

    const drainingOrc = actor(3);
    const drainingSession = session(drainingOrc);
    const drainingSkill = soulCry(1);
    drainingSkill.semantic = { ...drainingSkill.fetchSemantic(), toggleIntervalMs: 10 };
    ToggleSkills.handleRequest(drainingSession, drainingOrc, drainingSkill);
    assert.strictEqual(drainingOrc.fetchMp(), 1, 'Soul Cry level 1 should consume sourced initial MP 2');
    assert.strictEqual(EffectStats.add(drainingOrc, 'pAtkAdd'), 4.5, 'Soul Cry level 1 should apply sourced additive P.Atk');

    await wait(30);
    assert.strictEqual(EffectStore.list(drainingOrc).length, 0, 'Soul Cry should auto-remove when periodic MP drain cannot be paid');
    assert.strictEqual(EffectStats.add(drainingOrc, 'pAtkAdd'), 0, 'Auto-removed Soul Cry should drop its P.Atk bonus');

    // Cancel (applyCancel) and NPC Cancel 4094 (applyNegate) remove the
    // Silent Move effect; actor.silentMoving, read first by NpcAggro, must follow.
    const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
    for (const cancelSkill of [
        new SkillModel({ selfId: 1056, name: 'Cancel', level: 12, spell: true, power: 25, mp: 0, hp: 0, distance: 600 }),
        new SkillModel({ selfId: 4094, name: 'NPC Cancel', level: 9, spell: true, power: 0, mp: 0, hp: 0, distance: 600 })
    ]) {
        const sneak = actor(100);
        sneak.fetchCollectiveMDef = () => 10;
        ToggleSkills.handleRequest(session(sneak), sneak, toggleSkill(221, 'Silent Move', 1));
        assert.strictEqual(sneak.silentMoving, true, 'Silent Move should enable silent moving');
        const caster = actor(100);
        caster.fetchCollectiveMAtk = () => 1000;
        const outcome = C4SkillEffects.execute(session(caster), caster, sneak, cancelSkill, {
            magicSkill: true,
            rng: () => 0,
            attack: { clearLoadedShot() {} }
        });
        assert.strictEqual(outcome.cancelled.length, 1, `${cancelSkill.fetchName()} should remove Silent Move`);
        assert.strictEqual(EffectStore.list(sneak).length, 0, `${cancelSkill.fetchName()} should leave no Silent Move effect`);
        assert.strictEqual(sneak.silentMoving, false, `${cancelSkill.fetchName()} should clear the silent moving flag`);
    }

    // E287: Dance of Shadow (366, not a toggle) also carries silentMoving. Silent
    // Move turned off while the dance runs leaves the flag true; the dance
    // expiring must recompute it, or mobs ignore the actor for good.
    const EffectTicker = invoke('GameServer/Effects/EffectTicker');
    const dancer = actor(100);
    const dancerSession = session(dancer);
    const silentMove = toggleSkill(221, 'Silent Move', 1);
    ToggleSkills.handleRequest(dancerSession, dancer, silentMove);
    assert.strictEqual(dancer.silentMoving, true, 'Silent Move should enable silent moving');
    const dance = EffectStore.apply(dancer, {
        key: 'dance_of_shadow', id: 366, level: 1, name: 'Dance of Shadow',
        stats: { runSpdMul: 0.5, silentMoving: true }, durationMs: 40
    });
    EffectTicker.scheduleExpiry(dancerSession, dancer, dance);
    ToggleSkills.handleRequest(dancerSession, dancer, silentMove);
    assert.strictEqual(dancer.silentMoving, true, 'Dance of Shadow keeps silent moving after Silent Move is turned off');
    await wait(120);
    assert.strictEqual(EffectStore.list(dancer).length, 0, 'Dance of Shadow should have expired');
    assert.strictEqual(dancer.silentMoving, false, 'Expired Dance of Shadow should clear the silent moving flag');

    // A dance expiring while Silent Move is still on must not drop the flag.
    const keeper = actor(100);
    const keeperSession = session(keeper);
    ToggleSkills.handleRequest(keeperSession, keeper, silentMove);
    EffectStore.apply(keeper, {
        key: 'dance_of_shadow', id: 366, level: 1, name: 'Dance of Shadow',
        stats: { runSpdMul: 0.5, silentMoving: true }, durationMs: 40
    });
    EffectTicker.scheduleExpiry(keeperSession, keeper, EffectStore.list(keeper).find((entry) => entry.key === 'dance_of_shadow'));
    await wait(120);
    assert.strictEqual(keeper.silentMoving, true, 'Expired dance must keep silent moving while Silent Move is on');

    // E291: slot-limit eviction removes the oldest counted buff. When it is a
    // silentMoving buff, C4SkillEffects must recompute the flag: with Silent
    // Move still on it stays true, with no other source it clears.
    const DataCache = invoke('GameServer/DataCache');
    DataCache.init();
    const wildMagicData = DataCache.skills.find((entry) => entry.selfId === 1303);
    const wildMagic = new SkillModel({ ...utils.crushOb(wildMagicData), ...wildMagicData.levels.find((entry) => entry.level === 1) });
    for (const withToggle of [true, false]) {
        const evictee = actor(100);
        const evicteeSession = session(evictee);
        if (withToggle) ToggleSkills.handleRequest(evicteeSession, evictee, silentMove);
        EffectStore.apply(evictee, {
            key: 'dance_of_shadow', id: 366, level: 1, name: 'Dance of Shadow',
            stats: { runSpdMul: 0.5, silentMoving: true }, durationMs: 60000
        });
        evictee.silentMoving = true;
        for (let index = 0; index < 19; index += 1) {
            EffectStore.apply(evictee, { key: `filler_${index}`, id: 5000 + index, level: 1, name: `Filler ${index}`, stats: { pDefMul: 1.01 }, durationMs: 60000 });
        }
        assert.strictEqual(EffectStore.list(evictee).some((entry) => entry.key === 'dance_of_shadow'), true, 'Dance of Shadow should still be stored before the eviction');
        const caster2 = actor(100);
        const cast = C4SkillEffects.execute(session(caster2), caster2, evictee, wildMagic, {
            magicSkill: true, rng: () => 0, attack: { clearLoadedShot() {} }
        });
        assert(cast.effect, 'Wild Magic should land and push the oldest buff out');
        assert.strictEqual(EffectStore.list(evictee).some((entry) => entry.key === 'dance_of_shadow'), false, 'Dance of Shadow should be evicted as the oldest counted buff');
        assert.strictEqual(evictee.silentMoving, withToggle, withToggle
            ? 'Eviction of a dance must keep silent moving while Silent Move is on'
            : 'Eviction of the only silent moving source should clear the flag');
    }

    console.log('Toggle skill checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
