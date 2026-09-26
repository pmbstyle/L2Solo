const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Formulas = invoke('GameServer/Formulas');

function castCycle(p, skill) {
    const magic = skill.spell !== false;
    const speed = Math.max(1, Number(magic ? p.castSpd : p.atkSpd) || 333);
    const cast = Formulas.calcRemoteAtkTime(Number(skill.hitTime) || 1000, speed);
    let reuse = Number(skill.reuse) || 0;
    if (!Rules.resolve(skill).staticReuse) {
        reuse *= 333 / speed * Combat.statMultiplier(p, magic ? 'mReuseMul' : 'pReuseMul')
            / Math.max(0.01, Combat.statMultiplier(p, magic ? 'mReuseDiv' : 'pReuseDiv'));
    }
    return Math.max(250, cast, reuse);
}

function weaponDps(p, boss) {
    const cycle = p.equipment?.weaponKind === 'Weapon.Bow'
        ? Formulas.calcBowAttackTimes(p.atkSpd, p.equipment.attackReuseDelay ?? 1500,
            Combat.statMultiplier(p, 'atkReuseMul')).cycleMs
        : Formulas.calcMeleeAtkTime(p.atkSpd || 333);
    return Formulas.calcPhysicalDamage(p.pAtk, 0, Math.max(1, boss.pDef), 0) * 1000 / Math.max(250, cycle);
}

function damageRate(entry, boss, seconds) {
    const { profile: p, role, member } = entry;
    if (role === 'healer' || role === 'buffer' && !Roles.isPartyMusicFighter(member)) return 0;
    const physical = weaponDps(p, boss);
    if (role !== 'mage') return physical;
    const spells = (p.skills || []).filter(skill => !skill.passive && skill.spell !== false
        && [Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN, Rules.DEATH_LINK].includes(Rules.resolve(skill).skillType)
        && Number(skill.power) > 0);
    return Math.max(physical, ...spells.map(skill => {
        const castsPerSecond = Math.min(1000 / castCycle(p, skill), Number(skill.mp) > 0
            ? p.maxMp * 0.85 / Number(skill.mp) / seconds : Infinity);
        return Formulas.calcMagicDamage(p.mAtk, Number(skill.power), Math.max(1, boss.mDef)) * castsPerSecond;
    }));
}

function estimate(members, spot, cache = new Map()) {
    const profiles = members.map(member => {
        const key = `raid_combat:${member.characterId || member.id}`;
        if (!cache.has(key)) cache.set(key, Combat.profileFor(member));
        return { member, profile: cache.get(key), role: Roles.inferRole(member) };
    });
    const bossKey = `raid_boss:${spot.raidBossTemplateId || spot.id}`;
    if (!cache.has(bossKey)) cache.set(bossKey, Combat.npcForSpot(spot, () => 0.5, {
        preferredNpcId: spot.raidBossTemplateId, allowRaid: true
    }));
    const boss = cache.get(bossKey);
    if (!boss || !profiles.length) return null;
    let fightSeconds = 15, dps = 0;
    // A small bounded estimate, not a combat simulation in the planner.
    // Re-evaluate mana-limited casting against the estimated fight length.
    for (let pass = 0; pass < 4; pass++) {
        dps = profiles.reduce((sum, entry) => sum + damageRate(entry, boss, fightSeconds), 0);
        fightSeconds = Math.max(15, Math.min(3600, Number(boss.maxHp) / Math.max(1, dps * 1.2)));
    }
    const tank = profiles.find(entry => entry.role === 'tank')?.profile;
    const incoming = tank ? Formulas.calcMeleeDamage(boss.pAtk, 0, Math.max(1, tank.pDef))
        * 1000 / Math.max(250, Formulas.calcMeleeAtkTime(boss.atkSpd || 253)) : Number(boss.pAtk);
    const tankSurvivalSeconds = tank ? tank.maxHp / Math.max(1, incoming) : 0;
    let healingBudget = 0, healingPerSecond = 0;
    for (const { profile: p, role } of profiles) {
        if (!['healer', 'buffer'].includes(role)) continue;
        const heals = (p.skills || []).flatMap(skill => {
            const semantic = Rules.resolve(skill);
            if (skill.passive || ![Rules.HEAL, Rules.HEAL_HOT, Rules.HOT, Rules.HEAL_PERCENT].includes(semantic.skillType)
                || !['friendly', 'party', 'ally'].includes(semantic.target)) return [];
            const amount = semantic.hot ? Number(semantic.hot.heal || skill.power) * Number(semantic.hot.count || 1)
                : semantic.skillType === Rules.HEAL_PERCENT ? (tank?.maxHp || p.maxHp) * Number(skill.power) / 100
                    : Formulas.calcHealAmount(Number(skill.power || 0));
            const budget = Number(skill.mp) > 0 ? amount * p.maxMp * 0.85 / Number(skill.mp) : amount * fightSeconds;
            const rate = amount * 1000 / Math.max(castCycle(p, skill), semantic.hot
                ? semantic.hot.count * semantic.hot.intervalMs : 0);
            return [{ budget, rate, sustained: Math.min(rate, budget / fightSeconds) }];
        }).sort((a, b) => b.sustained - a.sustained);
        if (heals[0]) { healingBudget += heals[0].budget; healingPerSecond += heals[0].sustained; }
    }
    // Soft risk, not a new gear gate: real encounters calibrate the model.
    const survival = Math.min(1, tankSurvivalSeconds / 8);
    const deliveredHealing = Math.min(healingBudget, healingPerSecond * fightSeconds);
    const sustain = Math.min(1, (deliveredHealing + Number(tank?.maxHp || 0)) / Math.max(1, incoming * fightSeconds));
    const successChance = Math.max(0.1, Math.min(0.95, 0.95 * survival * Math.sqrt(sustain)));
    return { fightSeconds, preparationSeconds: 90, recoverySeconds: 60,
        successChance, damagePerSecond: dps, healingPerSecond, healingBudget, tankSurvivalSeconds };
}

module.exports = { estimate };
