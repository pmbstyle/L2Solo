const assert=require('node:assert/strict');
const {createTrialWorld,abort,H,Service,Database,withRandom}=require('./helpers/secondProfessionHarness');
const {reloadActor}=require('./helpers/fighterProfessionHarness');
const {equip}=require('./helpers/remainingProfessionHarness');
const STARTS=[[213,7106,35,7],[214,7461,35,11],[224,7702,39,7],[228,7629,39,11],[229,7630,39,4],[230,7634,39,11]];
(async()=>{
    const chars=STARTS.flatMap(([q,,level,classId])=>[
        {id:190000+q,classId,level:level-1,race:0},
        {id:191000+q,classId:15,level:40,race:0}
    ]);
    const c=await createTrialWorld('remaining-trial-guards',189001,chars,{classId:11,race:0,level:39});
    try {
        for(const [q,npc,level]of STARTS) {
            const s=await c.world.session(190000+q),wrong=await c.world.session(191000+q);
            assert.equal(await c.world.event(s,q,'start',npc),false,'lower-level acceptance blocked');
            assert.equal(await c.world.event(wrong,q,'start',npc),false,'wrong-class acceptance blocked');
            s.actor.level=level;await Database.execute(['UPDATE characters SET level = ? WHERE id = ?',[level,s.actor.fetchId()]]);
            assert.equal(await c.world.event(s,q,'start',npc+1),false,'wrong NPC cannot authorize acceptance');
            assert.equal(await c.world.event(s,q,'start',npc),true);
            assert.equal(await c.world.event(s,q,'start',npc),false);
            const state=c.world.state(s,q);
            await Service.giveItem(s,57,123);await Service.giveItem(s,7562,3);
            for(const item of state.quest.questItems) if(!H.count(state,item)) await Service.giveItem(s,item,1);
            // Retire a worn trial weapon through the real packet path, preserving ordinary inventory.
            if(q===224||q===229) {
                const ctx={...c,id:s.actor.fetchId(),session:s};
                ctx.reopen=async()=>{ctx.session=await c.world.reopen(ctx.id);};
                await equip(ctx,q===224?3028:3029);await abort(ctx.session,q);
            } else await abort(s,q);
            const reopened=await c.world.reopen(s.actor.fetchId());
            const row=await c.world.questRow(s.actor.fetchId(),q);assert.equal(row.state,'created');
            assert.deepEqual(Object.keys(JSON.parse(row.variables)),['revision']);
            for(const item of state.quest.questItems)assert.equal(await c.world.amount(s.actor.fetchId(),item),0);
            assert.equal(await c.world.amount(s.actor.fetchId(),57),123);assert.equal(await c.world.amount(s.actor.fetchId(),7562),3);
            assert.equal(reopened.actor.backpack.fetchEquippedWeapon(),undefined);
        }
        // Foreign interference is delivered to the owner even if the attacker has no Q230 state.
        await c.click(230,'start',7634);await withRandom([0],()=>c.click(230,'list',7063));
        await c.kill(555,30);await c.kill(577,30);await c.click(230,'handin',7063);
        await reloadActor(c);
        const Npc=invoke('GameServer/Npc/Npc'),D=invoke('GameServer/DataCache');
        const d=D.npcs.find(n=>n.selfId===12006);
        const pet=new Npc(c.runtime.npc.nextId++,{...utils.crushOb(d),locX:0,locY:0,locZ:0,head:0,isSummon:true,ownerId:c.id});
        c.session.actor.summon=pet;
        const foreign=await c.world.session(191230);c.runtime.user.sessions=[c.session,foreign];
        await c.click(230,'duel',7635);const enemy=H.personalSpawns(c.state(230),5102)[0];assert(enemy);
        await Service.onAttack(foreign,enemy,foreign.actor,1);
        assert.equal(c.state(230).getInt('duel'),0);assert.equal(await c.amount(3362),1);
        assert.equal(await c.amount(3353),1);assert.equal(await c.world.amount(foreign.actor.fetchId(),3362),0);
        await Service.onAttack(foreign,enemy,foreign.actor,1);await Service.onKill(foreign,enemy,pet);
        assert.equal(await c.amount(3364),0);assert.equal(await c.amount(3362),1);
        await c.click(230,'duel',7635);assert.equal(await c.amount(3353),0);
        assert.equal(await c.event(230,'duel',7636),false,'no parallel duel');
        await abort(c.session,230);assert.equal(H.personalSpawns(c.state(230)).length,0);
        assert.equal(c.session.questWaypoints?.size||0,0);
        console.log('Remaining C4 trials: class/level/NPC gates, once-only acceptance, equipped-weapon abort, unrelated inventory, foreign duel interference and private spawn cleanup passed');
    }finally{await c.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
