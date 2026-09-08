const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Backpack = invoke('GameServer/Actor/Backpack');
const Runtime = invoke('GameServer/Pets/PetRuntime');
const Rules = invoke('GameServer/Pets/PetRules');
const Skills = invoke('GameServer/Npc/NpcSkills');
const Control = invoke('GameServer/Npc/SummonControl');
const AI = invoke('GameServer/Pets/BabyPetAI');
const Effects = invoke('GameServer/Effects/EffectStore');
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
function sessionFor(backpack, skill, options = {}) {
    let hp = 100;
    let mp = options.mp ?? 100;
    let casts = false;
    let destId = options.destId;
    const loc = {
        locX: options.locX ?? 1000,
        locY: options.locY ?? 2000,
        locZ: options.locZ ?? -50
    };
    const actor = {
        backpack,
        skillset: { fetchSkill: () => skill },
        summon: options.summon || null,
        fetchId: () => 2000001,
        fetchName: () => 'Summoner',
        fetchTitle: () => '',
        fetchRace: () => 0,
        fetchSex: () => 0,
        fetchClassId: () => 0,
        fetchLevel: () => 65,
        fetchExp: () => 0,
        fetchSp: () => 0,
        fetchStr: () => 40,
        fetchDex: () => 30,
        fetchCon: () => 43,
        fetchInt: () => 21,
        fetchWit: () => 11,
        fetchMen: () => 25,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        setLocXYZ(coords) {
            loc.locX = coords.locX;
            loc.locY = coords.locY;
            loc.locZ = coords.locZ;
        },
        fetchHead: () => 0,
        fetchRadius: () => 10,
        fetchDestId: () => destId,
        clearDestId() { destId = undefined; },
        setDestId(value) { destId = value; },
        fetchIsOnline: () => true,
        fetchMp: () => mp,
        setMp(value) { mp = value; },
        fetchMaxMp: () => 100,
        fetchCp: () => 0,
        fetchMaxCp: () => 0,
        fetchMaxLoad: () => 1000,
        fetchCollectivePAtk: () => 1,
        fetchCollectivePDef: () => 1,
        fetchCollectiveEvasion: () => 1,
        fetchCollectiveAccur: () => 1,
        fetchCollectiveCritical: () => 1,
        fetchCollectiveMAtk: () => 1,
        fetchCollectiveMDef: () => 1,
        fetchPvpFlag: () => 0,
        fetchKarma: () => 0,
        fetchCollectiveRunSpd: () => 1,
        fetchCollectiveWalkSpd: () => 1,
        fetchSwim: () => 0,
        fetchAtkSpdMultiplier: () => 1,
        fetchSize: () => 1,
        fetchHair: () => 0,
        fetchHairColor: () => 0,
        fetchFace: () => 0,
        fetchIsGM: () => 0,
        fetchPrivateStoreType: () => 0,
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 0,
        fetchEvalScore: () => 0,
        fetchHp: () => hp,
        setHp(value) { hp = value; },
        fetchMaxHp: () => 100,
        fetchCollectiveCastSpd: () => 333,
        fetchCollectiveAtkSpd: () => 333,
        statusUpdateVitals() {},
        isDead: () => false,
        automation: { replenishVitals() {}, abortAll() {} },
        state: {
            fetchDead: () => false,
            fetchHits: () => false,
            fetchSeated: () => false,
            fetchWalkin: () => false,
            fetchCombats: () => false,
            fetchStateInvisible: () => false,
            setHits() {},
            setCasts(value) { casts = value; },
            fetchCasts: () => casts
        }
    };

    return {
        actor,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        },
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        }
    };
}
let session;
async function main() {
    DataCache.init();
    const expectedMp = {
        4710:[3,5,7,9,12,14,17,18,18,19,20,20],
        4711:[46,76,104,139,179,220,258,275,288,298,305,309],
        4712:[6,6,7,7,8,8,9,9,10,10,11,11],
        4713:[5,9,11,15,19,23,27,28,30,30,32,32],
        4717:[5,8,12,17,20,25,29,32,33,33,34,34],
        4718:[33,59,88,122,159,195,228,242,252,259,262,262]
    };
    const data=require('../data/Pets/c4-skills.json');
    for(const template of data.skills) assert.deepStrictEqual(template.levels.map(row=>row.mp),expectedMp[template.selfId],`C4 MP table ${template.selfId}`);
    for(const [level,wanted] of [[9,1],[26,2],[35,3],[55,5],[69,6],[70,7],[74,7],[75,8],[79,8],[80,9]]) assert.strictEqual(Rules.skillLevel(level),wanted);
    for(const [npcId,wanted] of [[12077,[]],[12311,[4710,4711]],[12526,[4710,4711]],[12312,[4712,4713]],[12527,[4712,4713]],[12313,[]],[12528,[]],[12780,[4717,4718]],[12781,[4717,4718]],[12782,[4717,4718]]]) {
        assert.deepStrictEqual(Skills.forNpc({fetchSelfId:()=>npcId,fetchIsPet:()=>true,fetchLevel:()=>55}).map(s=>s.fetchSelfId()),wanted);
    }
    session=sessionFor(new Backpack({items:[],paperdoll:Array.from({length:16},()=>({}))}));
    session.persistenceMode='ephemeral';session.actor.session=session;
    session.actor.fetchMaxHp=()=>3000;session.actor.setHp(1500);
    World.user={sessions:[session]};World.npc={spawns:[],grid:{},nextId:9000001};
    async function spawn(itemId,level) {
        session.actor.backpack.insertItem(itemId,itemId,{amount:1,petData:{level}});
        session.actor.backpack.spawnPetFromItem(session,{itemObjectId:itemId,npcId:Rules.TYPES[itemId].npcId});
        const pet=session.actor.pet; assert(pet);await pet.persistTail;
        clearInterval(pet.timer.babyHeal);clearInterval(pet.timer.petFeed);Control.stop(session,pet);
        return pet;
    }
    async function dismiss() {const pet=session.actor.pet;Control.unsummon(session,session.actor,pet);await pet.teardownTail;}
    async function heal(pet,hp,skillId,cost,power) {
        pet.automation.stopReplenish();pet.skillReuseUntil.clear();pet.setMp(pet.fetchMaxMp());
        session.actor.setHp(hp);session.packets.length=0;
        const skill=Skills.forNpc(pet).find(s=>s.fetchSelfId()===skillId);
        assert.strictEqual(skill.fetchConsumedMp(),cost);assert.strictEqual(skill.fetchPower(),power);
        const ownerMp=session.actor.fetchMp();
        assert(AI.tick(pet,()=>0));
        assert.strictEqual(pet.fetchMp(),pet.fetchMaxMp(),'no initial MP cost: charged when heal lands');
        await wait(skill.fetchHitTime()*333/pet.fetchCollectiveCastSpd()+150);
        pet.automation.stopReplenish();
        assert.strictEqual(session.actor.fetchHp(),hp+power,'sourced flat heal, not percent or invented M.Atk bonus');
        assert.strictEqual(pet.fetchMp(),pet.fetchMaxMp()-cost,'exact pet MP expenditure');
        assert.strictEqual(session.actor.fetchMp(),ownerMp,'owner MP is untouched');
        const packet=session.packets.findLast(p=>p[0]===0xb5);
        assert(packet,'pet window receives immediate status');
        assert.strictEqual(packet.readInt32LE(39),pet.fetchMaxMp()-cost,'wire MP agrees with server');
        session.actor.setHp(hp);
        assert.strictEqual(AI.tick(pet,()=>0),false,'same heal cannot bypass reuse');
    }
    const cougar=await spawn(6649,26);
    assert.strictEqual(cougar.fetchMaxMp(),115);
    await heal(cougar,1500,4717,8,16);
    cougar.automation.replenishVitalsTick(cougar);assert.strictEqual(cougar.fetchMp(),112,'first 3-second regen tick');
    cougar.automation.replenishVitalsTick(cougar);assert.strictEqual(cougar.fetchMp(),115,'weak heal refills within two regen ticks');
    await heal(cougar,500,4718,59,64);
    cougar.skillReuseUntil.clear();cougar.setMp(58);session.actor.setHp(500);
    assert.strictEqual(AI.tick(cougar,()=>0),false,'no emergency heal without its full MP cost');
    cougar.setMp(7);session.actor.setHp(1500);assert.strictEqual(AI.tick(cougar,()=>0),false,'no weak heal without MP');
    await dismiss();
    const wind=await spawn(3500,35);
    const stun=Skills.forNpc(wind).find(s=>s.fetchSelfId()===4710).fetchSemantic();
    assert.strictEqual(stun.baseLandRate,15);assert.strictEqual(stun.levelDepend,1);assert.strictEqual(stun.magicLevel,30);
    assert.strictEqual(stun.ssBoost,1);assert.strictEqual(stun.durationMs,9000);assert(stun.overHit);
    assert.strictEqual(stun.castRange,40);assert.strictEqual(stun.effectRange,200);
    const before=wind.fetchMp(),pdef=wind.fetchCollectivePDef();
    Control.useSkillAction(session,session.actor,wind,1004);
    await wait(1100*333/wind.fetchCollectiveAtkSpd()+150);
    wind.automation.stopReplenish();
    assert.strictEqual(wind.fetchMp(),before-104,'manual Wild Defense consumes sourced MP');
    assert.strictEqual(wind.fetchCollectivePDef(),pdef*5);
    assert.strictEqual(invoke('GameServer/Effects/EffectRestrictions').canMove(wind),false,'ImmobileBuff prevents movement');
    const effect=Effects.list(wind).find(e=>e.id===4711);assert(effect);
    assert(effect.expiresAt-Date.now()>29000 && effect.expiresAt-Date.now()<=30000);
    await dismiss();
    const star=await spawn(3501,35);star.setHp(1);
    const healSkill=Skills.forNpc(star).find(s=>s.fetchSelfId()===4713);const mp=star.fetchMp();
    Control.useSkillAction(session,session.actor,star,1006);
    await wait(3000*333/star.fetchCollectiveCastSpd()+150);star.automation.stopReplenish();
    assert.strictEqual(star.fetchMp(),mp-11);assert.strictEqual(star.fetchHp(),99,'Bright Heal restores only its caster');
    const burst=Skills.forNpc(star).find(s=>s.fetchSelfId()===4712);
    star.markSkillReuse(burst,100);assert.strictEqual(star.canUseSkill(burst,100),true,'Bright Burst has no artificial one-second cooldown');
    await dismiss();
    console.log('C4 pet skills: species, MP tables/packets, exact cougar heals/regen, gates, manual casts, Wild Stun and ImmobileBuff passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
    session?.actor?.pet?.destructor(session);
});
