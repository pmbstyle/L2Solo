// Lisvus fdc7e33a 230_TestOfSummoner and its C4 spawnlist. Duels are personal.
const H=require('../SecondProfessionQuest');
const NPCS=[7063,7634,7635,7636,7637,7638,7639,7640];
const POSITIONS=[[-118719,233139,-2912],[23354,187991,-3592],[23031,118953,-3704],[-24003,207704,-3184],[17832,86087,-3632],[106252,135416,-3432]];
const LISTS=[[3347,3338,3337],[3348,3339,3340],[3349,3342,3341],[3350,3345,3343],[3351,3344,3346]];
const DROPS=[[555,1,3338,80],...[577,578,579,580,581,582].map(m=>[m,1,3337,m<580?25:m===580?50:75]),
    [600,2,3339,80],[563,2,3340,80],[552,3,3342,60],...[267,268,269,270,271].map(m=>[m,3,3341,[269,270].includes(m)?50:25]),
    [553,4,3345,70],[192,4,3343,50],[193,4,3343,50],[89,5,3344,30],[90,5,3344,60],[176,5,3346,50]];
const eligible=s=>s.session.actor.fetchLevel()>=39&&[11,26,39].includes(s.session.actor.fetchClassId());
const l=(e,t)=>H.link(230,e,t);
const activePet=s=>invoke('GameServer/Npc/SummonControl').activeSummon(s.session.actor);
const crystals=i=>Array.from({length:5},(_,n)=>3360+i*5+n);
const validPet=(s,source)=>source&&source===activePet(s)&&source.fetchIsSummon?.()===true
    &&Number(source.fetchOwnerId?.())===s.session.actor.fetchId();
async function result(s,i,outcome) {
    await H.step(s,1,{takes:crystals(i).map(id=>[id,H.count(s,id)]),gives:[[3360+i*5+outcome,1]],variables:{duel:'0',pet:'0'}});
    H.clearSpawns(s);H.clearRadars(s);
}
const quest={
    id:230,name:'Test of the Summoner',startNpcs:[7634],npcs:NPCS,
    exclusiveSpawns:[5102,5103,5104,5105,5106,5107],
    questSpawns:[5102,5103,5104,5105,5106,5107],attackNpcs:[5102,5103,5104,5105,5106,5107],
    killNpcs:[...DROPS.map(r=>r[0]),5102,5103,5104,5105,5106,5107],questItems:Array.from({length:53},(_,i)=>3337+i),radarPoints:POSITIONS,
    eventNpc:e=>({start:7634,list:7063,handin:NPCS,duel:[7635,7636,7637,7638,7639,7640],forfeit:[7635,7636,7637,7638,7639,7640]})[e],
    canTalk:(s,npc)=>s.isStarted()||s.isCompleted()||npc.fetchSelfId()===7634&&eligible(s),
    async onTalk(s,npc) {
        if(s.isCompleted()) return H.page(s,'You have earned the Mark of Summoner.');
        if(!s.isStarted()) return H.page(s,'Galatea in Gludin asks you to win six summoning duels. Lara in Dion supplies two Beginner\'s Arcanas for each completed materials list.',l('start','Accept the test'));
        const id=npc.fetchSelfId(),i=id-7635,list=LISTS[s.getInt('list')-1],actions=[];
        if(id===7063) {
            if(!list) actions.push(l('list','Request a materials list'));
            else if(H.has(s,[[list[0],1],[list[1],30],[list[2],30]])) actions.push(l('handin','Exchange the materials for two arcanas'));
        } else if(i>=0&&i<6&&!H.count(s,3354+i)) {
            if(H.count(s,3364+i*5)) actions.push(l('handin','Receive the summoner\'s arcana'));
            else if(s.getInt('duel')===i+1) actions.push(l('forfeit','Concede this duel and prepare another attempt'));
            else if(!s.getInt('duel')&&H.count(s,3353)&&activePet(s)) actions.push(l('duel','Spend one Beginner\'s Arcana and begin the duel'));
        } else if(id===7634&&H.has(s,Array.from({length:6},(_,i)=>[3354+i,1]))) actions.push(l('handin','Receive the Mark of Summoner'));
        const materials=list?`<br>${[list[1],list[2]].map(i=>`${H.itemName(i)}: ${H.count(s,i)}/30`).join('<br>')}<br>`+DROPS.filter(r=>r[1]===s.getInt('list')).map(r=>`Hunt ${H.npcName(r[0])} for ${H.itemName(r[2])}.`).join('<br>'):'';
        return H.page(s,'Let one and the same summoned creature fight alone. Your own attacks or switching creatures forfeits the duel. If a fight is lost after a restart, concede it at its master and start a new attempt.<br>'+Array.from({length:6},(_,i)=>`${H.npcName(7635+i)}: ${H.count(s,3354+i)?'complete':'pending'}`).join('<br>')+materials,actions.join('<br>'));
    },
    async onEvent(s,e) {
        const id=s.session.activeNpcTalk.selfId,i=id-7635,list=LISTS[s.getInt('list')-1];
        if(e==='start') {
            if(s.isStarted()||s.isCompleted()||!eligible(s)) return null;
            await H.step(s,1,{gives:[[3352,1]]});
        } else if(s.isStarted()&&e==='list'&&!list) {
            const n=Math.floor(Math.random()*5),r=LISTS[n];
            await H.step(s,1,{takes:[[3352,H.count(s,3352)]],gives:[[r[0],1]],variables:{list:String(n+1)}});
        } else if(s.isStarted()&&e==='duel'&&i>=0&&i<6&&!s.getInt('duel')&&!H.count(s,3354+i)&&!H.count(s,3364+i*5)&&H.count(s,3353)&&activePet(s)) {
            await H.step(s,1,{takes:[[3353,1],...crystals(i).map(id=>[id,H.count(s,id)])],gives:[[3360+i*5,1]],variables:{duel:String(i+1),pet:'0',encounter:JSON.stringify(POSITIONS[i])}});
            H.spawn(s,5102+i,POSITIONS[i]);
        } else if(s.isStarted()&&e==='forfeit'&&s.getInt('duel')===i+1) await result(s,i,3);
        else if(s.isStarted()&&e==='handin') {
            if(id===7063&&list&&H.has(s,[[list[0],1],[list[1],30],[list[2],30]]))
                await H.step(s,1,{takes:[[list[0],1],[list[1],30],[list[2],30]],gives:[[3353,2]],variables:{list:'0'}});
            else if(i>=0&&i<6&&H.count(s,3364+i*5)&&!H.count(s,3354+i))
                await H.step(s,1,{takes:[[3364+i*5,1]],gives:[[3354+i,1]]});
            else if(id===7634&&H.has(s,Array.from({length:6},(_,i)=>[3354+i,1]))) {
                await H.step(s,0,{takes:quest.questItems.map(i=>[i,H.count(s,i)]),gives:[[3336,1]],status:'completed',exp:148409,sp:30000});H.clearSpawns(s);H.clearRadars(s);
            } else return null;
        } else return null;
        return quest.onTalk(s,{fetchSelfId:()=>id});
    },
    async onAttack(s,npc,source,damage) {
        const i=npc.fetchSelfId()-5102;
        if(i<0||i>=6||s.getInt('duel')!==i+1||!H.owns(s,npc)||damage<=0) return;
        if(!validPet(s,source)||(s.getInt('pet')&&s.getInt('pet')!==source.fetchId())) {await result(s,i,2);return;}
        if(!s.getInt('pet')) await H.step(s,1,{takes:[[3360+i*5,1]],gives:[[3361+i*5,1]],variables:{pet:String(source.fetchId())}});
    },
    async onKill(s,npc,source) {
        const id=npc.fetchSelfId(),i=id-5102;
        if(i>=0&&i<6) {
            if(s.getInt('duel')!==i+1||!H.owns(s,npc)) return;
            await result(s,i,validPet(s,source)&&(!s.getInt('pet')||s.getInt('pet')===source.fetchId())?4:2);
        } else {
            const r=DROPS.find(r=>r[0]===id&&r[1]===s.getInt('list')&&H.count(s,r[2])<30);
            if(r&&Math.floor(Math.random()*100)<r[3]) await H.step(s,1,{gives:[[r[2],1]]});
        }
    },
    async onSummonDeath(s,pet) {
        const i=s.getInt('duel')-1;
        if(i>=0&&s.getInt('pet')===pet.fetchId()) await result(s,i,3);
    },onAbort:H.abort
};
module.exports=quest;
