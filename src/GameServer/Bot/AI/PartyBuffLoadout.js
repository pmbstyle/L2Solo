const Roles = invoke('GameServer/Bot/AI/BotRoles');
const ClassPolicy = invoke('GameServer/Bot/AI/BotClassPolicy');
const Effects = invoke('GameServer/Effects/EffectStore');

const aliases = {
    chant_of_battle:'might', power_of_paagrio:'might', soul_shield:'shield', chant_of_shielding:'shield',
    chant_of_flame:'acumen', chant_of_fire:'magic_barrier', chant_of_fury:'haste',
    chant_of_rage:'death_whisper', chant_of_eagle:'guidance', chant_of_vampire:'vampiric_rage',
    chant_of_predator:'focus', chant_of_evasion:'agility', soul_of_paagrio:'blessed_soul',
    wisdom_of_paagrio:'acumen', eye_of_paagrio:'guidance',
    blessing_of_paagrio:'shield', glory_of_paagrio:'magic_barrier', tact_of_paagrio:'agility',
    rage_of_paagrio:'berserker_spirit'
};
const priorities = {
    wind_walk:100, shield:95, magic_barrier:90, blessed_body:90,
    might:90, haste:90, acumen:90, empower:85, concentration:80,
    focus:80, death_whisper:80, vampiric_rage:80, bless_shield:75, blessed_soul:75,
    guidance:65, agility:60, wild_magic:65, regeneration:15,
    song_of_earth:88, song_of_warding:88, song_of_hunter:88,
    dance_of_warrior:88, dance_of_fire:88, dance_of_fury:88,
    dance_of_mystic:88, dance_of_concentration:88,
    song_of_wind:40, song_of_water:40, song_of_life:15, dance_of_inspiration:40
};
const situational = {
    holy_weapon:'undead', dance_of_light:'undead', song_of_invocation:'undead',
    resist_poison:'poison', invigor:'bleed', mental_shield:'mental',
    resist_fire:'fire', song_of_flame_guard:'fire', resist_aqua:'water',
    resist_wind:'wind', dance_of_earth_guard:'earth',
    elemental_protection:'elemental', resist_shock:'stun'
};
function normalize(key) { return String(key || '').replace(/([a-z0-9])([A-Z])/g,'$1_$2').trim().toLowerCase().replace(/\s+/g,'_'); }
function family(key) { key=normalize(key);return aliases[key] || key; }

// A resurrected damage dealer needs a short combat restart, not the full
// pre-pull loadout. Native chants count as the same buff families.
function raidRecoveryFamilies(actor) {
    return Roles.usesCasterWeaponCombat(actor) ? ['acumen', 'empower'] : ['haste', 'might'];
}

function useful(actor, skill, context = {}) {
    const key=family(skill.fetchSemantic?.()?.effect);
    if (situational[key] && context[situational[key]] !== true) return false;
    if (key==='decrease_weight' || key==='kiss_of_eva') return false;
    if (key==='bless_shield' && actor.backpack?.fetchItems
        && !actor.backpack.fetchItems().some(i=>i.fetchEquipped?.() && Number(i.fetchSlot?.())===8)) return false;
    const caster=Roles.usesCasterWeaponCombat(actor) || ([49,50,51,52].includes(Roles.roleClassId(actor))
        && !!actor.backpack?.fetchEquippedWeapon?.() && !Roles.hasMeleeWeapon(actor));
    if (['might','haste','focus','death_whisper','guidance','vampiric_rage'].includes(key)
        && ['healer','buffer'].includes(Roles.inferRole(actor)) && caster) return false;
    if (['dance_of_warrior','dance_of_fire','dance_of_fury','dance_of_inspiration','song_of_hunter','dance_of_light'].includes(key)) {
        return ClassPolicy.buffUseful(actor,'might') === true && !caster;
    }
    if (key==='dance_of_mystic') return Roles.inferRole(actor)==='mage';
    if (key==='dance_of_concentration') return caster;
    if (key==='wild_magic') return Roles.inferRole(actor)==='mage';
    return ClassPolicy.buffUseful(actor,key) !== false;
}

// Select whole native casts, budgeting every aura recipient. A brief heal or
// cooldown must not change the desired set, so MP/busy state is excluded here.
function build(members, providers, context, api) {
    const actors=members.map(m=>m.actor).filter(a=>a && !a.isDead?.() && !a.state?.fetchDead?.());
    const skills=providers.filter(p=>p && !p.isDead?.() && !p.state?.fetchDead?.())
        .flatMap(provider=>api.skills(provider).map(skill=>({provider,skill,
            aura:api.recipients(members,provider,skill)})));
    const managed=new Set(skills.map(({skill})=>family(skill.fetchSemantic().effect)));
    const used=new Map(), limits=new Map(), selected=new Map(), selectedFamilies=new Map(), managedByActor=new Map();
    const init=actor=>{
        if(used.has(actor))return;
        // Clan auras can reach actors outside this party. Count their slots,
        // but never treat their effects as ours to remove or replace.
        const actorManaged=new Set(actors.includes(actor) ? skills
            .filter(({skill,aura})=>!api.isAura(skill) || aura.includes(actor))
            .map(({skill})=>family(skill.fetchSemantic().effect)) : []);
        managedByActor.set(actor,actorManaged);
        const effects=api.effects(actor);
        const protectedEffects=effects.filter(e=>Effects.includedInBuffCount(e)
            && (!actorManaged.has(family(e.key)) || e.dispellable===false || e.type!=='buff'));
        used.set(actor,protectedEffects.length);
        limits.set(actor,Math.max(0,Effects.BUFF_LIMIT-Math.max(0,effects.filter(e=>e.type==='debuff').length-Effects.DEBUFF_RESERVED_SLOTS)));
        selected.set(actor,new Set(protectedEffects.map(e=>normalize(e.key))));
        selectedFamilies.set(actor,new Set(protectedEffects.map(e=>family(e.key))));
    };
    actors.forEach(init);
    const candidates=[];
    for(const {provider,skill,aura} of skills) {
        const key=normalize(skill.fetchSemantic().effect),group=family(key);
        if(api.isAura(skill) && !aura.length)continue;
        const groups=aura.length?[aura]:actors.map(a=>[a]);
        for(const recipients of groups) {
            recipients.forEach(init);
            const beneficiaries=recipients.filter(a=>api.useful(a,skill,provider,context));
            if(!beneficiaries.length)continue;
            candidates.push({provider,skill,key,group,recipients,beneficiaries,
                priority:priorities[group] ?? (situational[group]?92:50),
                efficiency:beneficiaries.length/recipients.length});
        }
    }
    // Within one benefit, retain the stronger learned version. At equal
    // strength prefer casts which avoid occupying unrelated recipients' slots.
    // Raids instead prefer covering more beneficiaries per cast; every aura
    // recipient still goes through the same slot budget below.
    candidates.sort((a,b)=>b.priority-a.priority || a.group.localeCompare(b.group)
        || Number(b.skill.fetchSemantic().stackOrder||0)-Number(a.skill.fetchSemantic().stackOrder||0)
        || Number(b.skill.fetchLevel?.()||1)-Number(a.skill.fetchLevel?.()||1)
        || (api.preferGroupBuffs ? b.beneficiaries.length-a.beneficiaries.length : 0)
        || b.efficiency-a.efficiency
        || b.beneficiaries.length-a.beneficiaries.length
        || Number(a.skill.fetchConsumedMp?.()||0)-Number(b.skill.fetchConsumedMp?.()||0)
        || Number(a.provider.fetchId?.()||0)-Number(b.provider.fetchId?.()||0)
        || Number(a.skill.fetchSelfId?.()||0)-Number(b.skill.fetchSelfId?.()||0));
    const chosen=[];
    for(const c of candidates) {
        // Do not reintroduce a chant after selective casts covered its useful
        // recipients, or budget two ordinary versions of the same benefit.
        if(c.recipients.some(a=>selectedFamilies.get(a).has(c.group) || used.get(a)>=limits.get(a)))continue;
        chosen.push(c);
        for(const a of c.recipients){used.set(a,used.get(a)+1);selected.get(a).add(c.key);selectedFamilies.get(a).add(c.group);}
    }
    return {chosen,selected,managed,managedByActor};
}

module.exports={build,useful,family,normalize,raidRecoveryFamilies};
