const { count, step, abort } = require('../../Pets/PetQuest');
const dragons = [
    { npc:7748, name:'Exarion', mob:580, prey:'Leto Lizardman Warriors', scale:3822, egg:3823 },
    { npc:7749, name:'Zwov', mob:233, prey:'Marsh Spiders', scale:3824, egg:3825 },
    { npc:7750, name:'Kalibran', mob:551, prey:'Road Scavengers', scale:3826, egg:3827 },
    { npc:7751, name:'Suzet', mob:270, prey:'Breka Orc Overlords', scale:3828, egg:3829 },
    { npc:7752, name:'Shamhai', mob:202, prey:'Dead Seekers', scale:3830, egg:3831 }
];
const fairyMobs = [...Array.from({length:11}, (_,i)=>589+i),719];
const link = (event,text) => `<a action="bypass -h quest 420 ${event}">${text}</a><br>`;
const page = text => `<html><body>Little Wing:<br>${text}</body></html>`;
const materials = deluxe => deluxe ? [[1870,10],[1871,10],[2131,1],[1873,5],[1875,1],[3820,20],[3819,1]] : [[1870,10],[1871,10],[2130,1],[1873,3],[3820,10],[3818,1]];
module.exports = {
    questItems:[3499,...Array.from({length:16},(_,i)=>3816+i)], onAbort:abort,
    id:420, name:'Little Wing', npcs:[7829,7610,7608,7711,7747,...dragons.map(d=>d.npc)], startNpcs:[7829],
    killNpcs:[231,...dragons.map(d=>d.mob),...fairyMobs],
    canTalk: state => state.isStarted() || state.session.actor.fetchLevel() >= 35,
    eventNpc: event => ({ start:7829, normal:7610, deluxe:7610, craft:7608, cronos:7610, byron:7711, fairy:7747, hatch:7747, dust:7747 })[event] ??
        (event.startsWith('dragon_') || event.startsWith('eggs_') ? Number(event.split('_')[1]) : null),
    async onTalk(state, npc) {
        const id = npc.fetchSelfId(), c = state.getInt('cond'), deluxe = state.getInt('deluxe');
        if (!state.isStarted()) return page(id === 7829 && state.session.actor.fetchLevel() >= 35 ? link('start','Ask Cooper about raising a hatchling.') : 'Speak to Cooper in Giran at level 35 or higher.');
        if (id === 7610 && c === 1) return page('Choose a Fairy Stone recipe. Deluxe requires more materials, but can earn an extra reward.<br>'+link('normal','Fairy Stone')+link('deluxe','Deluxe Fairy Stone'));
        if (id === 7608 && c === 2) return page(`Bring 10 Coal, 10 Charcoal, ${deluxe ? '1 Gemstone C, 5 Silver Nuggets, 1 Stone of Purity and 20' : '1 Gemstone D, 3 Silver Nuggets and 10'} Toad Lord Back Skins. Hunt Toad Lords near Cruma Marshlands.<br>Skins: ${count(state,3820)}/${deluxe?20:10}<br>`+link('craft','Craft the stone.'));
        if (id === 7610 && c === 3) return page(link('cronos','Show Cronos the Fairy Stone.'));
        if (id === 7711 && c === 4) return page('Seek Fairy Mymyu in the Enchanted Valley. Avoid killing fairies while carrying the Deluxe Fairy Stone.<br>'+link('byron','Listen to Byron\'s advice.'));
        if (id === 7747 && c === 5) return page(link('fairy','Give Mymyu the Fairy Stone.'));
        const dragon = dragons.find(d=>d.npc===id);
        if (dragon && c === 6) return page(`Help ${dragon.name} recover stolen eggs from ${dragon.prey}.<br>`+link(`dragon_${id}`,'Offer the Fairy Juice and help.'));
        if (dragon && c === 7 && state.getInt('dragon') === id) return page(`Recover 20 eggs from ${dragon.prey}: ${count(state,dragon.egg)}/20.<br>`+link(`eggs_${id}`,'Return the eggs.'));
        if (id === 7747 && c === 8) return page('Mymyu can hatch the egg into a Wind, Star or Twilight hatchling. The type is random.<br>'+link('hatch','Hatch the egg.')+(count(state,3499) ? link('dust','Use Fairy Dust as well.') : ''));
        return page(({1:'Visit Sage Cronos in Hunters Village.',2:'Collect the materials and visit Maria in Dion.',3:'Show the stone to Cronos.',4:'Speak to Guard Byron in Hunters Village.',5:'Visit Fairy Mymyu in the Enchanted Valley.',6:'Choose one dragon: Exarion, Zwov, Kalibran, Suzet or Shamhai.',7:'Recover the eggs and return them to your chosen dragon.',8:'Bring your gifted egg to Mymyu.'})[c] || 'Speak to Cooper.');
    },
    async onEvent(state,event) {
        const c=state.getInt('cond'), deluxe=state.getInt('deluxe'), vars=state.variables;
        if (event==='start' && !state.isStarted() && state.session.actor.fetchLevel()>=35) await step(state,{cond:1});
        else if (state.isStarted() && c===1 && ['normal','deluxe'].includes(event)) await step(state,{cond:2,deluxe:Number(event==='deluxe')},[],[[event==='deluxe'?3819:3818,1]]);
        else if (state.isStarted() && c===2 && event==='craft') {
            const take=materials(deluxe);
            if (take.some(([id,n])=>count(state,id)<n)) return page('You still need the listed materials.');
            await step(state,{...vars,cond:3},take,[[deluxe?3817:3816,1]]);
        } else if (state.isStarted() && c===3 && event==='cronos') await step(state,{...vars,cond:4});
        else if (state.isStarted() && c===4 && event==='byron') await step(state,{...vars,cond:5});
        else if (state.isStarted() && c===5 && event==='fairy') await step(state,{...vars,cond:6},[[deluxe?3817:3816,1]],[[3821,1],...(deluxe?[[3499,1]]:[])]);
        else if (state.isStarted() && c===6 && event.startsWith('dragon_')) {
            const dragon=dragons.find(d=>d.npc===Number(event.split('_')[1])); if (!dragon) return null;
            await step(state,{...vars,cond:7,dragon:dragon.npc},[[3821,1]],[[dragon.scale,1]]);
        } else if (state.isStarted() && c===7 && event===`eggs_${state.getInt('dragon')}`) {
            const dragon=dragons.find(d=>d.npc===state.getInt('dragon'));
            if (count(state,dragon.egg)<20) return page('You need all 20 eggs.');
            await step(state,{...vars,cond:8},[[dragon.egg,20],[dragon.scale,1]],[[dragon.egg,1]]);
        } else if (state.isStarted() && c===8 && ['hatch','dust'].includes(event)) {
            const dragon=dragons.find(d=>d.npc===state.getInt('dragon'));
            const take=[[dragon.egg,1]], give=[[3500+Math.floor(Math.random()*3),1]];
            if (event==='dust') { if(!count(state,3499)) return null; take.push([3499,1]); give.push(Math.random()<0.5?[3912,1]:[4038,100]); }
            else if(count(state,3499)) take.push([3499,1]);
            await step(state,{},take,give,'created');
            return page('Your hatchling is ready. Use the Dragonflute to summon it and buy Food for Hatchlings from a Pet Manager.');
        } else return null;
        return this.onTalk(state,{fetchSelfId:()=>this.eventNpc(event)});
    },
    async onKill(state,npc) {
        const c=state.getInt('cond'), id=npc.fetchSelfId();
        if (c===2 && id===231 && Math.random()<0.30) {
            const limit=state.getInt('deluxe')?20:10;
            if(count(state,3820)<limit) await step(state,state.variables,[],[[3820,1]]);
        } else if(c===7) {
            const d=dragons.find(d=>d.npc===state.getInt('dragon'));
            if(d && id===d.mob && count(state,d.egg)<20 && Math.random()<0.50) await step(state,state.variables,[],[[d.egg,1]]);
        } else if(c>=3 && c<=5 && count(state,3817) && fairyMobs.includes(id)) await step(state,{cond:1},[[3817,1]]);
    }, dragons, materials
};
