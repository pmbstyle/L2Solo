const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const SkillRankIndex = require('../../Skills/SkillRankIndex');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const ClassPolicy = invoke('GameServer/Bot/AI/BotClassPolicy');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const SkillModel = invoke('GameServer/Model/Skill');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { coldRestRegenPerTick, restMpPerTick } = require('./ColdRest');

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
    const source=ItemTemplateIndex.findStrictRequired(DataCache.skills ?? [], record.selfId);
    const definition=SkillRankIndex.findStrict(source?.levels ?? [], record.level) || {};
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
    let seatedMp=null,seatedHp=null;
    // The numbers BotCombatUtility's MP price reads (T100): the cold normal
    // attack time and the rate the cold rest (resolveRest) refills MP at.
    const actor={
        // A bot's id (ColdCombatProfile): a split-kit first class fights for
        // its future second class (BotRoles.kitClassId), hot and cold.
        characterId:profile.characterId,
        fetchClassId:()=>profile.classId,fetchLevel:()=>profile.level,
        fetchPAtk:()=>profile.pAtk,fetchMAtk:()=>profile.mAtk,fetchAtkSpd:()=>profile.atkSpd,fetchCastSpd:()=>profile.castSpd,
        fetchNormalAttackMs:()=>ColdCombatProfile.normalAttackMs(profile),
        fetchSeatedMpPerMs:()=>seatedMp??=restMpPerTick({classId:profile.classId,level:profile.level},{profile})/Formulas.REGEN_TICK_MS,
        fetchSeatedHpPerMs:()=>seatedHp??=coldRestRegenPerTick({classId:profile.classId,level:profile.level},{profile}).hp/Formulas.REGEN_TICK_MS,
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
// mobHp: the mob's HP now (the MP price caps damage at it), else its max HP.
function select(profile,{hp,mp,cooldowns,time,charges=0,mob,mobHp=null,party=false,pvp=false,prepare=false,summon=null}) {
    const cached=adapter(profile);Object.assign(cached.state,{hp,mp,cooldowns,time,charges});
    cached.actor.summon = summon?.active && !(Number(summon.hp) <= 0) ? activeServitor : null;
    const mode=ClassPolicy.modeFor(cached.actor,{party,pvp});
    if(!cached.policies.has(mode))cached.policies.set(mode,{mode,classProfile:ClassPolicy.profileFor(cached.actor,{mode})});
    const policy=cached.policies.get(mode),role=Roles.combatRoleFor(cached.actor);
    const target=mob?{fetchHp:()=>mobHp??mob.maxHp,fetchPDef:()=>mob.pDef,fetchMDef:()=>mob.mDef,
        fetchUndead:()=>mob.undead===true,matchupTarget:mob}:null;
    const fight={...policy,raid:mob?.raidBossMaxHp!=null};
    if(prepare)return Utility.selectChargePlan(cached.actor,role,fight,target)?.skill.coldRecord||null;
    const selected=Utility.select(cached.actor,target,role,fight);
    return selected?{skill:selected.skill.coldRecord,magic:selected.skill.fetchSpell()===true,
        reasons:selected.reasons,score:selected.score}:null;
}
// Compile full-health solo priorities once per hunting profile, on the scale
// the matchup adds a target's resistance on (BotTargetMatchup.soloChannels:
// 180 x log2 of the effectiveness): 180 x log2 of the skill's priced damage
// rate at full HP and MP (BotCombatUtility.manaPrice, T100), cast after cast:
// a skill's reuse bounds its rate, so the fight's channel is the skill the bot
// keeps casting, not a long-reuse opener. Transient planning data.
const NEUTRAL_TARGET = Object.freeze({ fetchHp: () => 1e12, fetchPDef: () => 1000, fetchMDef: () => 1000,
    fetchUndead: () => true, matchupTarget: { vulnerabilities: {}, undead: true } });
function soloAttackScores(profile, { summon = false } = {}) {
    const cached = adapter(profile);
    Object.assign(cached.state, { hp: profile.maxHp, mp: profile.maxMp, cooldowns: {}, time: 0, charges: 0 });
    cached.actor.summon = summon ? activeServitor : null;
    const policy = { mode: 'solo_pve', classProfile: ClassPolicy.profileFor(cached.actor, { mode: 'solo_pve' }),
        matchupTarget: NEUTRAL_TARGET.matchupTarget };
    const role = Roles.combatRoleFor(cached.actor);
    const context = Utility.priceContext(cached.actor, NEUTRAL_TARGET, policy);
    return Object.fromEntries(cached.actor.skillset.skills.map(skill => {
        const verdict = Utility.evaluate(cached.actor, NEUTRAL_TARGET, skill, role, policy);
        const recast = verdict && Math.max(0, Number(skill.fetchReuseTime?.()) - Utility.skillHitMs(context, skill)) || 0;
        const rate = verdict && Utility.manaPrice(context, verdict, verdict.cost, recast)?.rate;
        return rate > 0 && [skill.fetchSelfId(), 180 * Math.log2(rate)];
    }).filter(Boolean));
}
// The profile as the hot actor the shared bot rules read (SoloSelfHeal), at
// the fight's HP, MP, reuse and time.
function actorFor(profile,{hp,mp,cooldowns,time,charges=0}){
    const cached=adapter(profile);Object.assign(cached.state,{hp,mp,cooldowns,time,charges});return cached.actor;
}
module.exports={select,soloAttackScores,actorFor};
