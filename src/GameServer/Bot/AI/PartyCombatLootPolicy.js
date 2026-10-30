const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Effects = invoke('GameServer/Effects/EffectStore');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Aggro = invoke('GameServer/Npc/NpcAggro');
const Retreat = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const World = invoke('GameServer/World/World');
const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');

const ATTACK_MARGIN = 100;

function position(actor) {
    return {locX:actor.fetchLocX(),locY:actor.fetchLocY(),locZ:actor.fetchLocZ()};
}
function distance(a,b) { return Math.hypot(a.locX-b.locX,a.locY-b.locY); }
function hp(actor) { return Number(actor.fetchHp?.() || 0) / Math.max(1,Number(actor.fetchMaxHp?.() || 1)); }

function idleSupport(actor) {
    return ['healer','buffer'].includes(Roles.inferRole(actor))
        && (Roles.usesCasterWeaponCombat(actor) || !Roles.hasMeleeWeapon(actor));
}

function hazardClearance(npc, actor, members, fallback) {
    if (!npc.fetchStateAttack?.() || RaidSafety.isProtectedRaidEntity(npc)) return fallback;
    const tank = members.find(member => member?.actor !== actor
        && Number(member?.actor?.fetchId?.()) === Number(npc.fetchDestId?.())
        && Roles.inferRole(member.actor) === 'tank')?.actor;
    if (!tank || tank.isDead?.() || tank.fetchIsOnline?.() === false
        || !npc.fetchCombatAttackRange || !npc.fetchCombatSkills) return fallback;
    // A target id alone is not protection: a travelling pull is still unsafe.
    const tankRange = Number(npc.fetchCombatAttackRange(tank));
    const attackRange = Number(npc.fetchCombatAttackRange(actor));
    if (!Number.isFinite(tankRange) || !Number.isFinite(attackRange)
        || distance(position(npc),position(tank)) > tankRange + ATTACK_MARGIN) return fallback;
    let reach = Math.max(50,attackRange);
    for (const skill of npc.fetchCombatSkills()) {
        if (skill.fetchTargetKind?.() !== 'enemy') continue;
        const castRange = Number(npc.fetchSkillCastRange?.(skill,actor) ?? skill.fetchDistance?.());
        if (!Number.isFinite(castRange)) return fallback;
        // Include aura and target-centred splash, not just the melee swing.
        reach = Math.max(reach,Math.max(0,castRange) + Math.max(0,Number(skill.fetchSemantic?.()?.radius) || 0));
    }
    return Math.max(reach + ATTACK_MARGIN,150);
}

function allowed(session, leaderSession, item, members) {
    const actor=session?.actor, leader=leaderSession?.actor;
    if (!actor || !leader || !item || !session.partyCompanion || session.plan !== 'following'
        || !idleSupport(actor) || session.pvpDefense) return false;
    // FollowingState grants this only after its healing/control/buff choices.
    if (!session.partyGroundPickupInProgress && Date.now()-Number(session.partyCombatLootReadyAt || 0)>1500) return false;
    if (actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()
        || session.pendingSupportApproach || Number(session.pendingSupportCast?.expiresAt || 0)>Date.now()
        || Effects.impairments(actor).disabled || Effects.impairments(actor).rooted || hp(actor)<0.7) return false;
    if (members.some(member=>member?.actor?.isDead?.()
        || hp(member.actor)<(Roles.inferRole(actor)==='healer'?0.7:0.45))) return false;
    if (Roles.inferRole(actor)==='healer'
        && invoke('GameServer/Bot/AI/BotSkillCapabilities').manaRechargeSkill(actor)
        && members.some(member=>Roles.inferRole(member.actor)==='tank'
            && Number(member.actor.fetchMp?.() || 0)/Math.max(1,Number(member.actor.fetchMaxMp?.() || 1))<0.2)) return false;
    if (Awareness.recentIncomingNpc(session,1500)) return false;
    const partyThreat=Awareness.findThreatTargetingPartyProjected(leaderSession);
    if (partyThreat && partyThreat.type !== 'npc') return false;
    const from=position(actor), to=position(item), anchor=position(leader);
    if (distance(from,to)>500 || distance(to,anchor)>600 || distance(from,anchor)>600
        || Math.abs(from.locZ-to.locZ)>64 || session.botStay && distance(from,to)>50) return false;
    // Native PickupExec follows this straight segment, not a MoveTo A* route.
    if (Geodata.hasLineOfSight(from.locX,from.locY,from.locZ,to.locX,to.locY,to.locZ)!==true) return false;
    return !(World.fetchNpcsInRadius(from.locX,from.locY,distance(from,to)+Aggro.MAX_AGGRO_RADIUS+100) || []).some(npc => {
        const clearance=Aggro.aggroRadius(npc)+100;
        if (npc.isDead?.() || npc.state?.fetchDead?.() || !npc.fetchAttackable?.()) return false;
        if (!npc.fetchHostile?.() && !npc.fetchDestId?.() && !npc.fetchStateAttack?.()) return false;
        const p=position(npc);
        if (Math.abs(p.locZ-from.locZ)>Aggro.MAX_AGGRO_Z_DIFFERENCE) return false;
        return Retreat.distanceToSegment(p,from,to)<=hazardClearance(npc,actor,members,clearance);
    });
}

module.exports={allowed,idleSupport};
