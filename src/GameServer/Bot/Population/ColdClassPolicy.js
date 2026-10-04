const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const ClassPolicy = invoke('GameServer/Bot/AI/BotClassPolicy');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const SkillModel = invoke('GameServer/Model/Skill');
const DataCache = invoke('GameServer/DataCache');

// A cold fight has no pathfinding geometry. Reuse class/skill validity and
// intent while keeping its existing damage, time and outcome abstraction.
// Adapters are built once per combat profile, not per attack. Every fight
// builds a new profile object, so the skill models, which depend only on the
// skill record, are shared by record content across fights and bots.
const adapters = new WeakMap();
const skillModels = new Map();
const activeServitor = Object.freeze({ isDead: () => false });
function skillModel(record) {
    const key=JSON.stringify(record);
    if (skillModels.has(key)) return skillModels.get(key);
    const source=DataCache.skills?.find(s=>s.selfId===record.selfId);
    const definition=source?.levels?.find(s=>s.level===record.level) || {};
    const skill=new SkillModel({...utils.crushOb(source || {}),...definition,...record,
        spell:definition.spell??source?.template?.spell??record.spell,
        hitTime:record.hitTime||definition.hitTime||source?.time?.hitTime||0,
        reuse:record.reuse||definition.reuse||source?.time?.reuse||0,
        distance:record.distance??definition.distance??source?.template?.distance??0});
    skill.model.distance=skill.fetchSemantic().castRange??skill.model.distance;
    skill.coldRecord={...record,mp:skill.fetchConsumedMp(),hp:skill.fetchConsumedHp(),
        power:skill.fetchPower(),hitTime:skill.fetchHitTime(),reuse:skill.fetchReuseTime(),spell:skill.fetchSpell()};
    skillModels.set(key,skill);
    return skill;
}
function adapter(profile) {
    if (adapters.has(profile)) return adapters.get(profile);
    const state={};
    const skills=(profile.skills||[]).map(skillModel);
    const actor={
        fetchClassId:()=>profile.classId,fetchLevel:()=>profile.level,
        fetchHp:()=>state.hp,fetchMaxHp:()=>profile.maxHp,
        fetchMp:()=>state.mp,fetchMaxMp:()=>profile.maxMp,
        fetchCharges:()=>state.charges,
        canUseSkill:skill=>Number(state.cooldowns[skill.fetchSelfId()]||0)<=state.time,
        skillset:{skills,fetchSkills:()=>skills,fetchSkill:id=>skills.find(s=>s.fetchSelfId()===id)},
        backpack:{fetchTotalWeaponKind:()=>profile.equipment?.weaponKind||'',
            fetchEquippedArmors:()=>profile.equipment?.shieldPDef>0?[{fetchKind:()=> 'Armor.Shield'}]:[]}
    };
    const result={actor,state,policies:new Map()};adapters.set(profile,result);return result;
}
function select(profile,{hp,mp,cooldowns,time,charges=0,mob,party=false,pvp=false,prepare=false,summon=null}) {
    const cached=adapter(profile);Object.assign(cached.state,{hp,mp,cooldowns,time,charges});
    cached.actor.summon = summon?.active && !(Number(summon.hp) <= 0) ? activeServitor : null;
    const mode=ClassPolicy.modeFor(cached.actor,{party,pvp});
    if(!cached.policies.has(mode))cached.policies.set(mode,{mode,classProfile:ClassPolicy.profileFor(cached.actor,{mode})});
    const policy=cached.policies.get(mode),role=Roles.combatRoleFor(cached.actor);
    const target=mob?{fetchHp:()=>mob.maxHp,fetchUndead:()=>mob.undead===true,matchupTarget:mob}:null;
    if(prepare)return Utility.selectChargePlan(cached.actor,role,policy,target)?.skill.coldRecord||null;
    const selected=Utility.select(cached.actor,target,role,policy);
    return selected?{skill:selected.skill.coldRecord,magic:selected.skill.fetchSpell()===true,
        reasons:selected.reasons,score:selected.score}:null;
}
module.exports={select};
