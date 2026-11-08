'use strict';

// A solo table has no row when its reference cannot survive alone. That
// says nothing about a safe roster's weapon damage. For a roster that uses
// only unpaid normal attacks, forecast its shared fight and recovery from
// the same profiles, mob attacks, seated regeneration and walk as combat.
// Paid attacks, spells, pets and packs keep the ordinary measured forecast.
function forecast(members, profiles, spot, { timestamp, cohesion }) {
    if (members.length < 2 || profiles.length !== members.length) return null;
    const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Rules = invoke('GameServer/Skills/C4SkillRules');
    if (profiles.some(profile => profile.servitor || profile.equipment?.weaponKind === 'Weapon.Bow'
        || profile.equipment?.bowMp > 0 || Cold.actionShot(profile.shot)
        || Cold.offensiveSkills(profile).length || profile.skills.some(skill => !skill.passive
            && skill.mp > 0 && Rules.resolveCached(skill).operateType !== 'toggle'))) return null;
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Mob = invoke('GameServer/Bot/Population/ColdMobAction');
    const Rest = require('./ColdRest');
    const Formulas = invoke('GameServer/Formulas');
    const Data = invoke('GameServer/DataCache');
    const Index = require('../../Item/ItemTemplateIndex');
    const entries = spot.npcEntries || [];
    if (!entries.length) return null;
    const recovery = profiles.map((profile, index) => Rest.coldRestRegenPerTick(members[index],
        { profile, timestamp }).hp * 1000 / Formulas.REGEN_TICK_MS);
    if (recovery.some(rate => !(rate > 0))) return null;
    let weight = 0, seconds = 0, production = 0;
    for (const entry of entries) {
        if ((entry.pull || 1) > 1 || entry.pulls?.some(([size]) => size > 1)) return null;
        const template = Index.find(Data.npcs, entry.selfId);
        if (!template || !(entry.count > 0)) return null;
        const target = Cold.npcCombatStats(template);
        if (!Match.soloCanHunt(profiles, target).eligible) return null;
        const channels = profiles.map(profile => Match.channels(profile, target));
        if (channels.some(attacks => attacks.length !== 1 || !attacks[0].normal)) return null;
        const damage = Match.damageRate(profiles, target);
        if (!(damage > 0)) return null;
        const fight = target.maxHp / damage;
        // Charge each member the whole incoming attack stream, rather than
        // assuming an advantageous aggro split. This overprices recovery.
        const rest = Math.max(...profiles.map((profile, index) =>
            Mob.incomingPerSecond(target, profile) * fight / recovery[index]));
        const share = entry.production > 0 ? entry.production : entry.count;
        weight += share; seconds += share * (fight + rest);
        production += Number(entry.production) || 0;
    }
    if (!(weight > 0) || !(seconds > 0)) return null;
    const leader = profiles[0];
    const walk = invoke('GameServer/Bot/Population/BackgroundResolver').soloWalkMs(spot.density,
        leader.runSpd, spot.spawnArea || undefined, Cold.attackReach(leader)) / 1000;
    const kills = Math.min(300, production || Infinity, 3600 / (seconds / weight + walk))
        * Math.min(1, Math.max(0, cohesion));
    return kills > 0 && Number.isFinite(kills) ? { kills } : null;
}

module.exports = { forecast };
