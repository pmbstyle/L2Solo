// Lisvus fdc7e33a 229_TestOfWitchcraft. Independent gems and sword/crystal branches.
const H=require('../SecondProfessionQuest');
const NPCS=[7063,7098,7110,7188,7314,7417,7435,7476,7630,7631,7632,7633];
const SWORD=3029,DRE=5101,GEMS=[3317,3318,3319,3320,3321,3322];
const FIRST=[70381,109638,-3726],FINAL=[14027,169896,-3646];
const eligible=s=>s.session.actor.fetchLevel()>=39&&[11,4,32].includes(s.session.actor.fetchClassId());
const l=(e,t)=>H.link(229,e,t);
const recover=s=>H.spawn(s,DRE,JSON.parse(s.get('encounter')));
function rows(s) {
    const cond=s.getInt('cond'),out=[];
    if(cond===1) out.push([7098,2,[[3308,1]],[[3309,1]]]);
    if(cond===2) {
        if(!H.count(s,3317)) {
            if(!H.count(s,3310)) out.push([7110,2,[],[[3310,1]]]);
            else out.push([7110,2,[[3310,1],[3311,20],[3312,20],[3313,20]],[[3317,1]]]);
        }
        if(!H.count(s,3318)) out.push([7476,2,[],[[3318,1]]]);
        if(!H.count(s,3319)&&!H.count(s,3314)) out.push([7063,2,[],[[3314,1]]]);
        if(!s.getInt('nestle')) out.push([7314,2,[],[[3315,1]],{nestle:'1'}]);
        if(H.count(s,3315)) out.push([7435,2,[[3315,1]],[[3316,1]],{leopold:'1'}]);
        out.push([7630,3,[[3309,1],...GEMS.map(i=>[i,1])],[[3323,1]]]);
    }
    if(cond===4) out.push([7630,5,[[3323,1]],[[3324,1],[3325,1],[3326,1]]]);
    if(cond===5) {
        if(H.count(s,3326)) out.push([7110,5,[[3326,1]],[[3331,1],[3332,1]]]);
        if(H.count(s,3325)) out.push([7417,5,[[3325,1]],[[3327,1]]]);
        if(H.count(s,3327)) out.push([7188,5,[[3327,1]],[[3328,1]]]);
        if(H.count(s,3328)) out.push([7188,5,[[3328,1],[3329,20]],[[3330,1]]]);
        if(H.count(s,3330)) out.push([7417,5,[[3330,1]],[[SWORD,1]]]);
        if(H.has(s,[[SWORD,1],[3331,1],[3332,1],[3324,1]])) out.push([7633,6,[],[[3335,1]]]);
    }
    if(cond===7) out.push([7630,0,[[3334,1],[3333,1],[SWORD,1],[3331,1],[3324,1]],[[3307,1]]]);
    return out;
}
const DROPS=[[557,3311,100],[565,3313,80],...[577,578,579,580,581,582].map(m=>[m,3312,m<579?50:m<581?60:70])];
const quest={
    id:229,name:'Test of Witchcraft',startNpcs:[7630],npcs:NPCS,questSpawns:[DRE],
    killNpcs:[...DROPS.map(r=>r[0]),5099,5100,DRE,601,602],
    questItems:[SWORD,...Array.from({length:28},(_,i)=>3308+i)],equippedQuestItems:[SWORD],radarPoints:[FIRST,FINAL],
    eventNpc:e=>({start:7630,handin:NPCS,recover:[7630,7633]})[e],canTalk:(s,npc)=>s.isStarted()||s.isCompleted()||npc.fetchSelfId()===7630&&eligible(s),
    async onTalk(s,npc) {
        if(s.isCompleted()) return H.page(s,'You have earned the Mark of Witchcraft.');
        if(!s.isStarted()) return H.page(s,'Orim near Death Pass asks you to identify a mysterious box. Begin with Alexandria in Giran.',l('start','Accept the test'));
        const cond=s.getInt('cond'),options=rows(s),actions=[];
        if(options.some(r=>r[0]===npc.fetchSelfId()&&H.has(s,r[2]))) actions.push(l('handin','Speak and continue the test'));
        if([3,6].includes(cond)&&npc.fetchSelfId()===(cond===3?7630:7633)) actions.push(l('recover','Locate Dre Vanul again'));
        const text=cond===2?'Gather the six gems. Iker needs twenty Dire Wyrm Fangs, Leto Lizardman Charms and Enchanted Golem Hearts. Visit Kaira, Lara and Nestle; follow Nestle\'s trail through Leopold and recover three gems from the quest skeletons.'
            :cond===3?'Defeat the first Dre Vanul, then return to Orim.'
            :cond===5?'Obtain the soultrap from Iker and the Sword of Binding through Klaus Vasper and Vadin. Vadin needs twenty Tamlin Orc Amulets. Carry both tools to Fisherman Evert.'
            :cond===6?'Wield the Sword of Binding when defeating Dre Vanul. Evert can recover the encounter if you used another weapon.'
            :options.map(r=>`Visit ${H.npcName(r[0])}.`).join('<br>');
        return H.page(s,text+'<br>'+options.flatMap(r=>r[2].map(([i,n])=>`${H.itemName(i)}: ${H.count(s,i)}/${n}`)).join('<br>'),actions.join('<br>'));
    },
    async onEvent(s,e) {
        const id=s.session.activeNpcTalk.selfId,cond=s.getInt('cond');
        if(e==='start') {
            if(s.isStarted()||s.isCompleted()||!eligible(s)) return null;
            await H.step(s,1,{gives:[[3308,1]]});
        } else if(e==='recover'&&s.isStarted()&&[3,6].includes(cond)&&id===(cond===3?7630:7633)) recover(s);
        else if(e==='handin'&&s.isStarted()) {
            const r=rows(s).find(r=>r[0]===id&&H.has(s,r[2]));if(!r) return null;
            const finish=r[1]===0,encounter=r[1]===3?FIRST:r[1]===6?FINAL:null;
            await H.step(s,r[1],{takes:finish?quest.questItems.map(i=>[i,H.count(s,i)]):r[2],gives:r[3],
                variables:{...r[4],...(encounter?{encounter:JSON.stringify(encounter)}:{})},
                ...(finish?{status:'completed',exp:139796,sp:40000}:{} )});
            if(encounter) recover(s);
            if(finish){H.clearSpawns(s);H.clearRadars(s);}
        } else return null;
        return quest.onTalk(s,{fetchSelfId:()=>id});
    },
    async onKill(s,npc) {
        const cond=s.getInt('cond'),id=npc.fetchSelfId();
        if(cond===2) {
            const r=DROPS.find(r=>r[0]===id);
            if(r&&H.count(s,3310)&&H.count(s,r[1])<20&&Math.floor(Math.random()*100)<r[2]) await H.step(s,cond,{gives:[[r[1],1]]});
            if(id===5099&&H.count(s,3314)&&!H.count(s,3319)) await H.step(s,cond,{takes:[[3314,1]],gives:[[3319,1]]});
            if(id===5100&&s.getInt('leopold')) {
                const gem=[3320,3321,3322].find(i=>!H.count(s,i));
                if(gem) await H.step(s,cond,{takes:H.count(s,3316)?[[3316,1]]:[],gives:[[gem,1]]});
            }
        } else if([3,6].includes(cond)&&id===DRE&&H.owns(s,npc)) {
            if(cond===3) await H.step(s,4);
            else if(H.has(s,[[3335,1],[3332,1]])&&s.session.actor.backpack.fetchEquippedWeapon()?.fetchSelfId()===SWORD)
                await H.step(s,7,{takes:[[3335,1],[3332,1]],gives:[[3334,1],[3333,1]]});
            H.clearSpawns(s);
        } else if(cond===5&&H.count(s,3328)&&[601,602].includes(id)&&H.count(s,3329)<20&&Math.floor(Math.random()*100)<(id===601?50:55))
            await H.step(s,cond,{gives:[[3329,1]]});
    },onAbort:H.abort
};
module.exports=quest;
