'use strict';

const Rules = require('./GrandBossRules');
const alive = npc => !!npc && !npc.isDead?.() && !npc.state?.fetchDead?.() && Number(npc.fetchHp?.()) > 0;
const id = Rules.templateId;
const coords = npc => ({ locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: npc.fetchLocZ(), head: npc.fetchHead?.() || 0 });
const distance = (a, b) => Math.hypot(a.fetchLocX()-b.fetchLocX(), a.fetchLocY()-b.fetchLocY(), a.fetchLocZ()-b.fetchLocZ());
const quiet = { dataSendToMe() {}, dataSendToMeAndOthers() {} };
// Lisvus ALT_PARTY_RANGE: only nearby contributors can be the drop's main
// damage dealer. This is separate from this server's party EXP share range.
const DROP_REWARD_RANGE = 1600;

function bossFor(world, npc) {
    return Rules.isGrandBoss(npc) ? npc : invoke('GameServer/World/RaidEntityIndex')
        .bossByTemplateId(world, npc?.model?.grandBossOwnerId || npc?.minionBossTemplateId);
}
function group(world, boss) {
    return invoke('GameServer/World/RaidEntityIndex').entitiesForRaid(world,
        { bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId() });
}
function bind(world, npc, boss) {
    npc.minionBossTemplateId = boss.fetchSelfId();
    npc.minionBossObjectId = boss.fetchId();
    world.addNpcToGrid(npc);
}
function teleportNpc(world, npc, point, session = quiet) {
    npc.attack?.abortCast?.(session, npc);
    npc.abortCombatState?.(session);
    npc.aggroList?.clear();
    npc.grandBossDamage?.clear();
    npc.automation?.abortAll?.(npc);
    npc.setLocXYZ(point);
    npc.spawnOrigin = { ...point };
    world.addNpcToGrid(npc);
    const response = invoke('GameServer/Network/Response');
    for (const viewer of world.user?.sessions || []) {
        if (viewer.actor?.fetchIsOnline?.()) viewer.dataSendToMe?.(response.teleportToLocation(npc.fetchId(), point));
    }
    invoke('GameServer/World/Generics/SpawnNpcs').notifyNearby(world, npc);
}
function cast(npc, target, skillId, session = quiet, level = 1) {
    if (!alive(npc) || !alive(target) || npc.state?.fetchCasts?.()
        || !invoke('GameServer/Effects/EffectRestrictions').canCast(npc)) return false;
    const skill = invoke('GameServer/Npc/NpcSkills').forId(skillId, level);
    if (!skill || !npc.canUseSkill(skill) || npc.fetchMp() < skill.fetchConsumedMp()
        || distance(npc, target) > Math.max(40, skill.fetchDistance())) return false;
    npc.castSkill(session, target, skill);
    return true;
}
function insideOrfen(npc) {
    const x = npc.fetchLocX(), y = npc.fetchLocY(), polygon = Rules.data.orfenZone;
    if (npc.fetchLocZ() < -5796 || npc.fetchLocZ() > -3796) return false;
    let inside = false;
    for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
        const [a,b]=polygon[i], [c,d]=polygon[j];
        if ((b>y)!==(d>y) && x < (c-a)*(y-b)/(d-b)+a) inside=!inside;
    }
    return inside;
}
function tick(world, boss, now = Date.now(), random = Math.random) {
    if (!alive(boss)) return;
    if (id(boss) === 12001) {
        if (now - (boss.grandBossCheckAt || 0) < 120000) return;
        boss.grandBossCheckAt = now;
        const origin = Rules.data.locations[12001][0];
        if (Math.hypot(boss.fetchLocX()-origin.locX,boss.fetchLocY()-origin.locY,boss.fetchLocZ()-origin.locZ)>10000)
            teleportNpc(world,boss,origin);
        for (const mob of group(world,boss).filter(n=>id(n)===12005 && alive(n)))
            if (distance(mob,boss)>10000) teleportNpc(world,mob,coords(boss));
    }
    if (id(boss) === 12169) {
        if (boss.grandBossLair && boss.fetchHp()>boss.fetchMaxHp()*.95 || !boss.grandBossLair && !insideOrfen(boss)) {
            const places = Rules.data.locations[12169];
            teleportNpc(world,boss,places[Math.min(2,Math.floor(random()*3))]);
            boss.grandBossLair = false;
        } else if (boss.grandBossLair && !insideOrfen(boss)) teleportNpc(world,boss,Rules.data.orfenLair);
        for (const mob of group(world,boss).filter(n=>id(n)===12171 && !n.spawnDefinition && alive(n)))
            if (distance(mob,boss)>3000) teleportNpc(world,mob,coords(boss));
    }
}
function spawned(world, npc) {
    if (!Rules.isEncounterNpc(npc)) return;
    if (!Rules.isGrandBoss(npc)) {
        const boss = bossFor(world,npc);
        if (boss) bind(world,npc,boss);
        return;
    }
    for (const mob of world.npc.spawns) if (mob.model?.grandBossOwnerId===id(npc)) bind(world,mob,npc);
    clearInterval(npc.grandBossTimer);
    if (id(npc)!==12052) {
        npc.grandBossCheckAt = Date.now();
        npc.grandBossTimer = setInterval(()=>tick(world,npc),10000);
        npc.grandBossTimer.unref?.();
    }
}
function stop(npc) { clearInterval(npc?.grandBossTimer); if(npc) npc.grandBossTimer=null; }
function actingPlayer(actor, session) {
    if (!actor?.fetchIsSummon?.() && !actor?.fetchIsPet?.()) return actor;
    if (actor.ownerSession?.actor) return actor.ownerSession.actor;
    if (session?.actor && typeof session.actor.fetchKind !== 'function') return session.actor;
    const ownerId = Number(actor.fetchOwnerId?.());
    return (invoke('GameServer/World/World').user?.sessions || [])
        .find(candidate => Number(candidate.actor?.fetchId?.()) === ownerId)?.actor;
}
function recordDamage(npc, actor, damage, session) {
    if (!Rules.isGrandBoss(npc) || !(damage>0)) return;
    const owner = actingPlayer(actor, session);
    const ownerId = Number(owner?.fetchId?.());
    if (!ownerId || typeof owner?.fetchKind === 'function') return;
    npc.grandBossDamage ||= new Map();
    const row = npc.grandBossDamage.get(ownerId) || { level:Number(owner.fetchLevel()),damage:0 };
    row.actor = owner;
    row.level = Number(owner.fetchLevel());
    row.damage += Math.min(damage,npc.fetchHp());
    npc.grandBossDamage.set(ownerId,row);
}
function dropContext(npc, lastActor = null) {
    if (!Rules.isGrandBoss(npc)) return null;
    const contributions = [...(npc.grandBossDamage?.values() || [])];
    const main = contributions.filter(({ actor }) => actor
        && actor.fetchIsOnline?.() !== false
        && (!actor.session || actor.session.actor === actor)
        && distance(npc, actor) <= DROP_REWARD_RANGE)
        .sort((a, b) => b.damage - a.damage)[0];
    const lastPlayer = actingPlayer(lastActor);
    const level = npc.fetchLevel();
    return {
        npcLevel: level,
        killerLevel: Number(main?.actor.fetchLevel() ?? lastPlayer?.fetchLevel?.()
            ?? npc.model?.dropLastAttackerLevel ?? 0),
        attackerLevels: contributions.map(row => Number(row.actor?.fetchLevel?.() ?? row.level))
            .filter(attackerLevel => attackerLevel <= level + 8)
    };
}
function pull(world,boss,actor,session) {
    if (actor?.fetchIsSummon?.() && actingPlayer(actor, session) && alive(actor)) teleportNpc(world, actor, coords(boss), session);
    else if (!invoke('GameServer/Skills/C4SkillEffects').applyGetPlayer(boss,actor, () => .5)) return false;
    cast(boss,actor,4064,session);
    return true;
}
function onAttack(world,npc,actor,damage,session=quiet,random=Math.random) {
    if (!alive(npc) || !Rules.isEncounterNpc(npc)) return;
    if ([12001,12002].includes(id(npc)) && damage>0 && random()<.05) {
        const boss=bossFor(world,npc);
        const nurses=boss&&group(world,boss).filter(n=>id(n)===12003 && alive(n)
            && invoke('GameServer/Effects/EffectRestrictions').canCast(n));
        if(nurses?.length) cast(nurses[Math.min(nurses.length-1,Math.floor(random()*nurses.length))],npc,id(npc)===12002?4024:4020,session);
    }
    if(id(npc)===12169) {
        // The C4 attack event names the acting player even for pet damage;
        // onSkillSee below instead targets the actual pet caster.
        const attacker = actingPlayer(actor, session) || actor;
        if(npc.fetchHp()<npc.fetchMaxHp()/2 && !npc.grandBossLair) {
            npc.grandBossLair=true;
            teleportNpc(world,npc,Rules.data.orfenLair,session);
        } else if(distance(npc,attacker)>300 && distance(npc,attacker)<=1000 && random()<.1) pull(world,npc,attacker,session);
    }
    if(id(npc)===12173 && npc.fetchHp()<npc.fetchMaxHp()/2) cast(npc,npc,4516,session);
}
function factionCall(world,helper,caller,attacker,session=quiet,random=Math.random) {
    if(id(helper)===12171 && random()<.05) cast(helper,attacker,4067,session,4);
    if(id(helper)===12173 && id(caller)!==12173 && caller.fetchHp()<caller.fetchMaxHp()/2
        && random() < (id(caller) === 12169 ? .9 : .1)) {
        helper.abortCombatState?.(session);
        cast(helper,caller,4516,session);
    }
}
function skillSeen(actor,skill,random=Math.random,session=actor?.session || actor?.ownerSession || quiet) {
    if ((actor?.fetchKind && !actor.fetchIsSummon?.()) || !(Number(skill.fetchSemantic?.()?.aggroPoints || 0) > 0)) return;
    const world=invoke('GameServer/World/World');
    const boss=invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(world,12169);
    if(alive(boss) && distance(boss,actor)<=1000 && random()<.2) pull(world,boss,actor,session);
}
function died(world,npc) {
    if(!Rules.isGrandBoss(npc)) return;
    stop(npc);
    if(id(npc)===12052) for(const point of [{locX:16502,locY:110165,locZ:-6394},{locX:18948,locY:110166,locZ:-6397}])
        invoke('GameServer/World/Generics/SpawnNpcs').spawnQuestNpc(world,{selfId:12053,...point,despawnDelay:900000});
}

module.exports={spawned,stop,tick,onAttack,factionCall,skillSeen,recordDamage,dropContext,died,teleportNpc,cast,insideOrfen};
