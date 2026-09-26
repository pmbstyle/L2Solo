const assert=require('assert');
require('../src/Global');
const Planner=invoke('GameServer/Bot/AI/BotSupportPlanner');
const Loadout=invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Effects=invoke('GameServer/Effects/EffectStore');
const Stats=invoke('GameServer/Effects/EffectStats');
const Rules=invoke('GameServer/Skills/C4SkillRules');
const Ticker=invoke('GameServer/Effects/EffectTicker');
const World=invoke('GameServer/World/World');
const Bots=invoke('GameServer/Bot/BotManager');
const originalRefresh=Ticker.refreshEffects;
Ticker.refreshEffects=()=>{};

function skill(id,level=1) {
    const semantic=Rules.resolve({selfId:id,level});
    return {fetchSelfId:()=>id,fetchLevel:()=>level,fetchName:()=>semantic.effect,
        fetchSemantic:()=>semantic,fetchPassive:()=>false,fetchConsumedMp:()=>10,
        fetchTargetKind:()=>semantic.target,fetchDistance:()=>semantic.target==='party'?-1:600,
        fetchBuffTime:()=>semantic.isDance?120000:semantic.durationMs||1200000};
}
let id=8800000;
function member(classId,skills=[],shield=false) {
    const actor={id:++id,mp:100,fetchId(){return this.id;},fetchClassId:()=>classId,
        fetchName:()=>String(classId),fetchMp(){return this.mp;},fetchMaxMp:()=>100,
        fetchHp:()=>100,fetchMaxHp:()=>100,fetchLocX:()=>0,fetchLocY:()=>0,fetchLocZ:()=>0,
        isDead:()=>false,fetchIsOnline:()=>true,skillset:{fetchSkills:()=>skills},
        state:{fetchDead:()=>false,fetchHits:()=>false,fetchCasts:()=>false,fetchTowards:()=>false},
        backpack:{fetchTotalWeaponKind:()=>classId===34?'Weapon.Dual':'Weapon.Sword',
            fetchItems:()=>shield?[{fetchEquipped:()=>true,fetchSlot:()=>8}]:[]}};
    const session={actor,plan:'following'};actor.session=session;return {actor,session};
}
try {
    const leader=member(6,[],true),healer=member(43,[skill(1059,3),skill(1268,3)]),
        prophet=member(17,[1040,1045,1048,1032,1044,1036,1182,1189,1191,1204,1243,1077,1240,1242,1068,1086,1085,1078].map(id=>skill(id))),
        tank=member(20,[],true),singer=member(21,[264,265,266,267,268,269,270,306].map(id=>skill(id)),true),
        orc=member(52,[1002,1006,1007,1009,1251,1252,1253,1308,1309,1310].map(id=>skill(id))),
        dwarf=member(57,[],true),dancer=member(34,[271,272,273,274,275,276,277,309].map(id=>skill(id)));
    const rows=[leader,healer,prophet,tank,singer,orc,dwarf,dancer];leader.leader=true;
    rows.slice(1).forEach(r=>Object.assign(r.session,{partyCompanion:true,followPlayerSession:leader.session}));
    World.user={sessions:rows.map(r=>r.session)};Bots.sessions=rows.slice(1).map(r=>r.session);
    const providers=rows.map(r=>r.actor),context={fire:true,poison:true};
    let selected=Planner.desiredLoadout(rows,providers,context);
    for(const row of rows) {
        const keys=selected.selected.get(row.actor);
        assert(keys.size<=20);
        for(const key of ['song_of_earth','song_of_hunter','song_of_warding','dance_of_warrior','dance_of_fire','dance_of_fury']) {
            assert(keys.has(key),`${row.actor.fetchClassId()}: reserve space for ${key}`);
        }
        assert(!keys.has('invigor'));assert(!keys.has('resist_aqua'));assert(!keys.has('resist_wind'));
        assert(keys.has('resist_fire'),`observed fire attacks justify protection: ${row.actor.fetchClassId()} ${[...keys]}`);
    }
    for(const row of [healer,prophet]) {
        const keys=selected.selected.get(row.actor);
        assert(!keys.has('bless_shield'),'no shield, no shield buff');
        assert(!keys.has('chant_of_battle'),'selective Might prevents pollution from the party chant');
        assert(!keys.has('chant_of_fury'),'selective Haste leaves caster slots free');
    }
    assert(!selected.selected.get(dancer.actor).has('bless_shield'),'dual swords cannot use shield buffs');
    const casterOrc=member(52);
    casterOrc.actor.backpack.fetchEquippedWeapon=()=>({fetchKind:()=>'Weapon.Etc',fetchName:()=>"Unicorn's Horn",fetchPAtk:()=>100,fetchMAtk:()=>143});
    assert.strictEqual(Loadout.useful(casterOrc.actor,skill(1068),{}),false,'caster-armed Warcryer does not request melee buffs');
    assert.strictEqual(Loadout.useful(singer.actor,skill(1068),{}),true,'Sword Singer retains physical support buffs');
    const serialize=plan=>rows.map(r=>[...plan.selected.get(r.actor)].sort());
    const steady=serialize(selected);prophet.actor.mp=0;
    assert.deepStrictEqual(serialize(Planner.desiredLoadout(rows,providers,context)),steady,'temporary MP loss must not churn the loadout');prophet.actor.mp=100;
    const empty=Planner.desiredLoadout(rows,providers,{});
    assert(!empty.selected.get(leader.actor).has('resist_fire'),'fire resistance is not unconditional');
    assert.strictEqual(Planner.isUsefulForTarget(healer.actor,skill(1032),null,{bleed:true}),true);

    // Simulate the actual overfull legacy party and converge by native effects,
    // preserving party-wide landing and the normal nextAction/capacity guards.
    const legacy=[1002,1007,1009,1032,1036,1044,1045,1048,1059,1078,1182,1189,1191,1204,1243,1251,1253,1308,1309,1310];
    for(const r of rows) for(const sid of legacy){const k=skill(sid),s=k.fetchSemantic();Effects.apply(r.actor,{...s,key:s.effect,id:sid,type:'buff',durationMs:1200000});}
    const passive={key:'armor_set:test',id:3516,type:'item_passive',dispellable:false,stats:{maxHpAdd:270}};
    Effects.apply(prophet.actor,passive);
    assert.strictEqual(Effects.list(prophet.actor).filter(Effects.includedInBuffCount).length,20);
    assert.strictEqual(Effects.packetEffects(prophet.actor).length,20,'passives do not enter effect packets');
    assert.strictEqual(Stats.add(prophet.actor,'maxHpAdd'),270,'the armor bonus still contributes to stats');
    const removed=Planner.reconcileLoadout(rows,providers);
    assert(removed.length>0,'old low-priority buffs must release real slots');
    assert(Effects.list(prophet.actor).some(e=>e.type==='item_passive'),'cleanup cannot remove set bonuses');
    let casts=0;
    for(;casts<180;casts++) {
        const action=Planner.nextPartyAction(rows,providers);if(!action)break;
        const s=action.skill.fetchSemantic(),targets=action.skill.fetchTargetKind()==='party'?rows.map(r=>r.actor):[action.target];
        for(const a of targets) Effects.apply(a,{...s,key:s.effect,id:action.skill.fetchSelfId(),level:action.skill.fetchLevel(),type:'buff',durationMs:action.skill.fetchBuffTime()});
    }
    assert(casts<180,'the rotation must terminate instead of endlessly replacing buffs');
    assert(casts>0);
    assert.strictEqual(Planner.hasPendingAction(rows,providers),false,'finished buffing releases the pull');
    for(const r of rows) {
        const effects=Effects.list(r.actor);
        assert(effects.filter(Effects.includedInBuffCount).length<=20);
        assert(effects.some(e=>e.key==='dance_of_fury'),`after ${casts} casts, ${r.actor.fetchClassId()}: ${effects.map(e=>e.key)}`);
        assert(effects.some(e=>e.key==='song_of_hunter'));
    }
    assert.strictEqual(Planner.needsSkill(leader.actor,skill(1040)),false,'ordinary Shield coexists with Song of Earth');
    const clock=Date.now,refreshAt=clock()+91000;
    let refreshes=0;
    try {
        Date.now=()=>refreshAt;
        for(;refreshes<100;refreshes++) {
            const action=Planner.nextPartyAction(rows,providers);if(!action)break;
            const s=action.skill.fetchSemantic();
            assert(s.isDance,'only short-duration music is due after 91 seconds');
            for(const {actor} of rows) Effects.apply(actor,{...s,key:s.effect,id:action.skill.fetchSelfId(),level:action.skill.fetchLevel(),type:'buff',durationMs:action.skill.fetchBuffTime()});
        }
        assert(refreshes>0 && refreshes<100,'music refresh also converges without eviction loops');
    } finally {Date.now=clock;}
    const musicOnly=member(6);
    Effects.apply(musicOnly.actor,{key:'song_of_earth',id:264,level:1,type:'buff',stats:{pDefMul:1.25},durationMs:120000});
    assert.strictEqual(Planner.needsSkill(musicOnly.actor,skill(1040)),true,'a song cannot substitute for an ordinary buff');
    Effects.apply(musicOnly.actor,{key:'armor:test',id:999,type:'item_passive',stats:{pDefMul:1.25}});
    assert.strictEqual(Planner.needsSkill(musicOnly.actor,skill(1040)),true,'armor cannot substitute for an ordinary buff');

    // Non-dispellable or externally supplied effects are reserved, not silently
    // budgeted as removable space. Even a single full recipient blocks an aura.
    const protectedTarget=member(6),other=member(6),externalRows=[protectedTarget,other];
    Effects.apply(protectedTarget.actor,{key:'might',id:1068,type:'buff',dispellable:false,durationMs:1200000});
    for(let i=0;i<19;i++)Effects.apply(protectedTarget.actor,{key:`external_${i}`,id:8000+i,type:'buff',durationMs:1200000});
    const externalPlan=Planner.desiredLoadout(externalRows,[singer.actor],{});
    assert.strictEqual(externalPlan.chosen.length,0,'a party aura must not evict external effects on another member');
    Planner.reconcileLoadout(externalRows,[prophet.actor,singer.actor]);
    assert.strictEqual(Effects.list(protectedTarget.actor).length,20,'protected effects survive cleanup');

    const weak=member(17,[skill(1068,1)]),strong=member(52,[skill(1007,3)]),fighter=member(6),caster=member(43);
    const strengthPlan=Planner.desiredLoadout([fighter,caster,weak,strong],[weak.actor,strong.actor],{});
    assert(strengthPlan.selected.get(fighter.actor).has('chant_of_battle'),'do not replace a stronger chant with a weaker individual buff');
    const away=member(6),nearSinger=member(21,[skill(264)]);
    away.actor.fetchLocX=()=>3000;
    Effects.apply(away.actor,{key:'song_of_earth',id:264,level:1,type:'buff',stats:{pDefMul:1.25},durationMs:120000});
    Planner.reconcileLoadout([away,nearSinger],[nearSinger.actor]);
    assert(Effects.list(away.actor).some(e=>e.key==='song_of_earth'),'leaving aura range must not strip an existing song');
    const outsider=member(6),overlord=member(51,[skill(1005),skill(1032)]);
    Effects.apply(outsider.actor,{key:'invigor',id:1032,level:1,type:'buff',durationMs:1200000});
    const Attack=invoke('GameServer/Actor/Attack'),resolve=Attack.prototype.resolveSkillTargets;
    try {
        Attack.prototype.resolveSkillTargets=()=>[overlord.actor,outsider.actor];
        Planner.reconcileLoadout([overlord],[overlord.actor]);
        assert(Effects.list(outsider.actor).some(e=>e.key==='invigor'),'clan aura recipients outside the party retain ownership of their buffs');
    } finally {Attack.prototype.resolveSkillTargets=resolve;}

    // Read the native NPC combat-skill list, and retain context across short
    // gaps between pulls instead of removing/recasting resistance each kill.
    const realNow=Date.now,oldNpc=World.npc,oldRadius=World.fetchNpcsInRadius;
    let now=900000,nearby=true;
    try {
        Date.now=()=>now;
        World.npc={grid:{}};
        World.fetchNpcsInRadius=()=>nearby?[{fetchId:()=>771,fetchName:()=>'',fetchAttackable:()=>true,isDead:()=>false,
            fetchLocX:()=>0,fetchLocY:()=>0,fetchCombatSkills:()=>[{fetchSemantic:()=>({trait:'fire'})}]}]:[];
        const target=member(6),provider=member(17,[skill(1191)]),party=[target,provider];target.leader=true;
        assert(Planner.desiredLoadout(party,[provider.actor]).selected.get(target.actor).has('resist_fire'));
        nearby=false;now+=1000;
        assert(Planner.desiredLoadout(party,[provider.actor]).selected.get(target.actor).has('resist_fire'),'keep resistance between nearby pulls');
        now+=61000;
        assert(!Planner.desiredLoadout(party,[provider.actor]).selected.get(target.actor).has('resist_fire'),'retire resistance after leaving the encounter');
    } finally {Date.now=realNow;World.npc=oldNpc;World.fetchNpcsInRadius=oldRadius;}
    assert.strictEqual(Loadout.useful(leader.actor,skill(1191),{fire:true}),true);

    // Raid preparation trades a few unused caster slots for substantially
    // fewer native casts, while ordinary mixed-party slot policy stays intact.
    const raidTank=member(6), raidHealer=member(43,[skill(1040,3),skill(1059,3)]),
        raidProphet=member(17,[skill(1040,3),skill(1068,3)]),
        raidOrc=member(52,[skill(1009,3),skill(1007,3)]),
        raidDps=member(0), raidSinger=member(21,[skill(264)]), raidDancer=member(34,[skill(271)]);
    const raidRows=[raidTank,raidHealer,raidProphet,raidOrc,raidDps,raidSinger,raidDancer];
    const raidProviders=raidRows.map(r=>r.actor);
    const Parties=invoke('GameServer/Bot/Population/BackgroundPartyState'),findParty=Parties.find;
    raidTank.actor.session.hotBackgroundPartyId='buff-test-raid';
    try {
        Parties.find=id=>id==='buff-test-raid'?{stats:{objective:{sourceKind:'raid'}}}:findParty.call(Parties,id);
        const raidLoadout=Planner.desiredLoadout(raidRows,raidProviders,{});
        assert(raidLoadout.selected.get(raidTank.actor).has('chant_of_battle'),
            'prefer a same-strength group chant over many individual Might casts during a raid');
        assert(raidLoadout.selected.get(raidTank.actor).has('chant_of_shielding'));
        for(const r of raidRows) {
            assert(raidLoadout.selected.get(r.actor).size<=20);
            assert(raidLoadout.selected.get(r.actor).has('song_of_earth'));
            assert(raidLoadout.selected.get(r.actor).has('dance_of_warrior'));
        }
        let raidCasts=0,healerCasts=0;
        for(;raidCasts<30;raidCasts++) {
            const action=Planner.nextPartyAction(raidRows,raidProviders,{partyMusicLast:true});
            if(!action)break;
            if(action.provider===raidHealer.actor) {
                healerCasts++;
                assert.equal(action.skill.fetchSelfId(),1059,'healer only supplies its unique Empower, not shared Shield');
            }
            const semantic=action.skill.fetchSemantic();
            const recipients=action.skill.fetchTargetKind()==='party'?raidRows.map(r=>r.actor):[action.target];
            for(const recipient of recipients)Effects.apply(recipient,{...semantic,key:semantic.effect,
                id:action.skill.fetchSelfId(),level:action.skill.fetchLevel(),type:'buff',durationMs:action.skill.fetchBuffTime()});
            Planner.reconcileLoadout(raidRows,raidProviders);
        }
        assert(raidCasts<15,'mass buffs must converge with fewer casts than two single-target buffs per member');
        assert(healerCasts>0,'the healer still supplies useful unique buffs');
        assert.equal(Planner.hasPendingAction(raidRows,raidProviders),false,
            'readiness must use the same raid loadout as casting, not wait for replaced single buffs');
        assert(Effects.list(raidTank.actor).some(e=>e.key==='chant_of_battle'),
            'loadout maintenance must not strip the selected raid chant');
        console.log(`Raid group-buff preparation converged in ${raidCasts} casts (${healerCasts} unique healer casts)`);
    } finally {Parties.find=findParty;}
    console.log(`Party buff loadout: mixed roles, equipment, encounter protection, stable allocation, passive slots and ${casts} casts converged`);
} finally {Ticker.refreshEffects=originalRefresh;}
