// Lisvus fdc7e33a 228_TestOfMagus: four elemental tones may be earned in any order.
const H=require('../SecondProfessionQuest');
const NPCS=[7629,7391,7612,7409,7411,7412,7413];
const BRANCHES=[
    [7413,2862,2856,[[2848,20]]], [7411,2860,2857,[[2849,5]]],
    [7412,2861,2858,[[2850,20],[2851,10],[2852,10]]], [7409,2863,2859,[[2853,10],[2854,10],[2855,10]]]
];
const DROPS=[[230,2848,20,30,2862],[231,2848,20,30,2862],[157,2848,20,30,2862],[232,2848,20,40,2862],[234,2848,20,50,2862],
    [5098,2849,5,50,2860],[145,2850,20,50,2861],[176,2851,10,50,2861],[553,2852,10,50,2861],
    [564,2853,10,100,2863],[565,2854,10,100,2863],[566,2855,10,100,2863]];
const ROWS=[[1,7391,2,[[2841,1]],[[2842,1]]],[2,7612,3,[[2842,1]],[[2843,1]]],
    [3,7629,4,[[2843,1],[2844,1],[2845,1],[2846,1]],[[2847,1]]],
    [4,7629,0,[[2847,1],...[2856,2857,2858,2859].map(i=>[i,1])],[[2840,1]]]];
const eligible=s=>s.session.actor.fetchLevel()>=39&&[11,26,39].includes(s.session.actor.fetchClassId());
const l=(e,t)=>H.link(228,e,t);
const quest={
    id:228,name:'Test of the Magus',startNpcs:[7629],npcs:NPCS,killNpcs:[5095,5096,5097,...DROPS.map(r=>r[0])],
    questItems:Array.from({length:23},(_,i)=>2841+i),eventNpc:e=>e==='start'?7629:e==='handin'?NPCS:null,
    canTalk:(s,npc)=>s.isStarted()||s.isCompleted()||npc.fetchSelfId()===7629&&eligible(s),
    async onTalk(s,npc) {
        if(s.isCompleted()) return H.page(s,'You have earned the Mark of Magus.');
        if(!s.isStarted()) return H.page(s,'Rukal in Dion asks you to investigate an elemental song. Speak to Parina in Gludin.',l('start','Accept the test'));
        const cond=s.getInt('cond'),row=ROWS.find(r=>r[0]===cond),b=cond===4&&BRANCHES.find(b=>b[0]===npc.fetchSelfId()&&!H.count(s,b[2]));
        const ready=b&&(!H.count(s,b[1])||H.has(s,b[3]));
        const text=cond===3?'Collect one seed each from the Singing Flowers of Phantasm, Nightmare and Horror, then return to Rukal.'
            :cond===4?BRANCHES.map(b=>`${H.npcName(b[0])}: ${H.count(s,b[2])?'tone complete':b[3].map(([i,n])=>`${H.itemName(i)} ${H.count(s,i)}/${n}`).join(', ')}`).join('<br>')
            :`Visit ${H.npcName(row[1])}.`;
        const hunts=cond===4?DROPS.filter(()=>s.getInt('elements')).map(r=>`${H.npcName(r[0])}: ${H.itemName(r[1])}`).join('<br>'):'';
        return H.page(s,text+'<br>'+hunts,ready||row&&row[1]===npc.fetchSelfId()&&H.has(s,row[3])?l('handin','Speak and continue the test'):'');
    },
    async onEvent(s,e) {
        const id=s.session.activeNpcTalk.selfId,cond=s.getInt('cond');
        if(e==='start') {
            if(s.isStarted()||s.isCompleted()||!eligible(s)) return null;
            await H.step(s,1,{gives:[[2841,1]]});
        } else if(e==='handin'&&s.isStarted()) {
            const b=cond===4&&BRANCHES.find(b=>b[0]===id&&!H.count(s,b[2]));
            if(b) {
                if(!H.count(s,b[1])) await H.step(s,cond,{gives:[[b[1],1]],variables:{elements:'1'}});
                else if(H.has(s,b[3])) await H.step(s,cond,{takes:[[b[1],1],...b[3]],gives:[[b[2],1]]});
                else return null;
            } else {
                const row=ROWS.find(r=>r[0]===cond&&r[1]===id);
                if(!row||!H.has(s,row[3])) return null;
                const finish=row[2]===0;
                await H.step(s,row[2],{takes:finish?quest.questItems.map(i=>[i,H.count(s,i)]):row[3],gives:row[4],...(finish?{status:'completed',exp:139039,sp:40000}:{} )});
            }
        } else return null;
        return quest.onTalk(s,{fetchSelfId:()=>id});
    },
    async onKill(s,npc) {
        const id=npc.fetchSelfId(),cond=s.getInt('cond');
        if(cond===3&&id>=5095&&id<=5097&&!H.count(s,id-2251)) await H.step(s,cond,{gives:[[id-2251,1]]});
        if(cond===4) {
            const r=DROPS.find(r=>r[0]===id&&s.getInt('elements')&&H.count(s,r[1])<r[2]);
            if(r&&Math.floor(Math.random()*100)<r[3]) await H.step(s,cond,{gives:[[r[1],1]]});
        }
    },onAbort:H.abort
};
module.exports=quest;
