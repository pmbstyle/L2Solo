const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root,'tmp/vendor/l2j-lisvus');
const revision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'}).trim()!==revision) throw Error('Unexpected reference revision');
function tuple(line) {
    if(!line.startsWith('(')) return null;
    const values=[];let value='',quoted=false,escaped=false;
    for(let i=1;i<line.length;i++) {
        const c=line[i];
        if(escaped){value+=c;escaped=false;continue;}
        if(c==='\\' && quoted){escaped=true;continue;}
        if(c==="'"){quoted=!quoted;continue;}
        if(!quoted && (c===',' || c===')')) {const s=value.trim();values.push(/^[-+]?\d+(\.\d+)?$/.test(s)?Number(s):s);value='';if(c===')')return values;}
        else value+=c;
    }
    return null;
}
const read=name=>fs.readFileSync(path.join(vendor,'datapack/sql',name),'utf8').split(/\r?\n/).map(tuple).filter(Boolean);
const ids=new Set([919,920,921,5185,5186,5187,5188,5189]);
const npcs=read('npc.sql').filter(row=>ids.has(row[0])).map(row=>{
    const [selfId,,name,,title,,,radius,size,level,,type,atkRadius,maxHp,maxMp,revHp,revMp,str,con,dex,int,wit,men,exp,sp,pAtk,pDef,mAtk,mDef,atkSpd,aggro,castSpd,weapon,shield,,walk,run,clanName,helpRadius,undead]=row;
    return { selfId,template:{kind:'Monster',name,title,level,hostile:aggro>0},traits:{race:selfId<1000?'humanoid':selfId===5189?'undead':'plant',undead:!!undead},
        base:{str,con,dex,int,wit,men},stats:{pAtk,pAtkRnd:30,pDef,mAtk,mDef,atkSpd,castSpd,atkRadius,accur:4.75},speed:{walk,run},
        vitals:{maxHp,maxMp,revHp,revMp,corpseTime:7000},collision:{radius,size},equipment:{weapon,shield,reuseTime:0},clan:{clanName:clanName==='NULL'?'':clanName,helpRadius},rewards:{exp:exp/(level*level),sp} };
});
if(npcs.length!==8)throw Error('Missing pet quest NPCs');
const existing=new Set();
for(const file of fs.readdirSync(path.join(root,'data/Npcs/Spawns')).filter(f=>f.endsWith('.json'))) {
    const groups=JSON.parse(fs.readFileSync(path.join(root,'data/Npcs/Spawns',file),'utf8'));
    if(Array.isArray(groups)) for(const group of groups)for(const spawn of group.spawns||[])existing.add(spawn.selfId);
}
const needed=new Set([...ids,7610,7608,7711,7747,7748,7749,7750,7751,7752]);
const rows=read('spawnlist.sql').filter(row=>needed.has(row[3]) && !existing.has(row[3]));
const spawns=rows.map(row=>({selfId:row[3],name:npcs.find(n=>n.selfId===row[3])?.template.name||'Pet Quest NPC',coords:[{locX:row[4],locY:row[5],locZ:row[6],head:row[9]}],total:row[2],respawn:row[10],bias:0}));
const skills = read('npcskills.sql').filter(row => ids.has(row[0])).map(([npcId,skillId,level]) => ({npcId,skillId,level}));
const drops = read('droplist.sql').filter(row => ids.has(row[0]));
const rewards = npcs.map(npc => {
    const groups = new Map(), spoils = [];
    for (const [,selfId,min,max,category,chance] of drops.filter(row => row[0] === npc.selfId)) {
        const item = {selfId,min,max,chance:chance/10000};
        if (category < 0) spoils.push({overall:100,items:[item]});
        else { if (!groups.has(category)) groups.set(category,[]); groups.get(category).push(item); }
    }
    return {selfId:npc.selfId,template:{name:npc.template.name},spoils,rewards:[...groups.values()].map(items => {
        const overall = items.reduce((total,item) => total+item.chance,0);
        return {overall,items:items.map(item=>({...item,chance:item.chance/overall*100}))};
    })};
});
const result={revision,npcs,skills,spawns:[{selfId:'c4_pet_quest_npcs',bounds:[],spawns}],rewards};
fs.writeFileSync(path.join(root,'data/Pets/c4-quest-npcs.json'),JSON.stringify(result,null,2)+'\n');
console.log(`Generated ${npcs.length} pet quest NPC templates and ${spawns.length} spawn rows`);
