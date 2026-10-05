// Lisvus fdc7e33a 224_TestOfSagittarius: the crescent bow must be wielded.
const H = require('../SecondProfessionQuest');
const NPCS=[7702,7626,7653,7514,7717], BOW=3028, KADESH=5090;
const PARTS=[3302,3303,3304,3305];
const ROWS=[
    [1,7626,2,[[3294,1]],[[3295,1]]], [2,7653,3,[[3295,1]],[]],
    [3,7626,4,[[3298,10]],[[3296,1]]], [4,7514,5,[[3296,1]],[]],
    [6,7514,7,[[3301,1]],[]], [7,7626,8,[],[[3297,1]]], [8,7717,9,[[3297,1]],[]],
    [9,7717,10,PARTS.map(i=>[i,1]),[[BOW,1],[17,10]]],
    [10,7626,11,[],[]], [12,7626,0,[[3300,1],[BOW,1]],[[3293,1]]]
];
const DROPS=[...[79,80,81,82,84,86,89,90].map(m=>[3,m,3298,10,50]),
    [5,269,3299,10,50],[5,270,3299,10,60],...[230,232,234].map(m=>[9,m,3303,1,10]),
    [9,563,3305,1,10],[9,233,3304,1,10],[9,551,3302,1,10]];
const eligible=s=>s.session.actor.fetchLevel()>=39 && [7,22,35].includes(s.session.actor.fetchClassId());
const l=(e,t)=>H.link(224,e,t);
const recover=s=>H.spawn(s,KADESH,JSON.parse(s.get('encounter')));
const quest={
    id:224,name:'Test of Sagittarius',startNpcs:[7702],npcs:NPCS,questSpawns:[KADESH],
    clientCondition: () => 1, // Source progression uses step; client cond stays 1.
    killNpcs:[...new Set([...DROPS.map(r=>r[1]),577,578,579,580,581,582,KADESH])],
    questItems:[BOW,...Array.from({length:13},(_,i)=>3294+i)],equippedQuestItems:[BOW],
    eventNpc:e=>({start:7702,handin:NPCS,recover:7626})[e],canTalk:(s,npc)=>s.isStarted()||s.isCompleted()||npc.fetchSelfId()===7702&&eligible(s),
    async onTalk(s,npc) {
        if(s.isCompleted()) return H.page(s,'You have earned the Mark of Sagittarius.');
        if(!s.isStarted()) return H.page(s,'Bernard in Gludin sends you to Hamil in Floran to investigate Brankel\'s disappearance.',l('start','Accept the test'));
        const cond=s.getInt('cond'), row=ROWS.find(r=>r[0]===cond), actions=[];
        if(row&&npc.fetchSelfId()===row[1]&&H.has(s,row[3])) actions.push(l('handin','Speak and continue the test'));
        if(cond===11&&npc.fetchSelfId()===7626&&s.get('encounter')) actions.push(l('recover','Locate Kadesh again'));
        const hunts=DROPS.filter(r=>r[0]===cond).map(r=>`Hunt ${H.npcName(r[1])}: ${H.itemName(r[2])} ${H.count(s,r[2])}/${r[3]}.`).join('<br>');
        const text=cond===11?'Hunt Leto Lizardmen near Oren until Kadesh appears. Wield the Crescent Moon Bow when defeating him. Hamil can locate a lost encounter again.'
            :`Visit ${H.npcName(row?.[1]||7514)}.<br>${hunts}`;
        return H.page(s,text,actions.join('<br>'));
    },
    async onEvent(s,e) {
        const id=s.session.activeNpcTalk.selfId,cond=s.getInt('cond');
        if(e==='start') {
            if(s.isStarted()||s.isCompleted()||!eligible(s)) return null;
            await H.step(s,1,{gives:[[3294,1]]});
        } else if(s.isStarted()&&e==='recover'&&cond===11&&s.get('encounter')) recover(s);
        else if(s.isStarted()&&e==='handin') {
            const row=ROWS.find(r=>r[0]===cond&&r[1]===id);
            if(!row||!H.has(s,row[3])||(cond===10&&!H.count(s,BOW))) return null;
            const finish=row[2]===0;
            await H.step(s,row[2],{takes:finish?quest.questItems.map(i=>[i,H.count(s,i)]):row[3],gives:row[4],
                ...(finish?{status:'completed',exp:54726,sp:20250}:{} )});
            if(finish){H.clearSpawns(s);H.clearRadars(s);}
        } else return null;
        return quest.onTalk(s,{fetchSelfId:()=>id});
    },
    async onKill(s,npc) {
        const cond=s.getInt('cond'),id=npc.fetchSelfId(),row=DROPS.find(r=>r[0]===cond&&r[1]===id&&H.count(s,r[2])<r[3]);
        if(row&&Math.floor(Math.random()*100)<row[4]) {
            const complete=cond===5&&H.count(s,3299)===9;
            await H.step(s,complete?6:cond,{takes:complete?[[3299,9]]:[],gives:[[complete?3301:row[2],1]]});
        } else if(cond===11&&id>=577&&id<=582&&!H.personalSpawns(s,KADESH).some(n=>!n.isDead())) {
            const blood=H.count(s,3306);
            if((blood-120)*5>Math.floor(Math.random()*100)) {
                await H.step(s,cond,{variables:{encounter:JSON.stringify(H.coords(npc,[0,0,0]))}});recover(s);
            } else if(blood<141) await H.step(s,cond,{gives:[[3306,1]]});
        } else if(cond===11&&id===KADESH&&H.owns(s,npc)) {
            if(s.session.actor.backpack.fetchEquippedWeapon()?.fetchSelfId()===BOW) await H.step(s,12,{gives:[[3300,1]]});
            H.clearSpawns(s);
        }
    },onAbort:H.abort
};
module.exports=quest;
