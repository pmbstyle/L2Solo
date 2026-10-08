'use strict';
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Books = invoke('GameServer/Skills/SkillBookCatalog');
async function main() {
    const ids = [719410,719411,719412];
    const world = await createWorld(ids.map(id => ({ id, classId: 12, level: 40 })), 'cold-paid-skill-authority');
    const save = Database.saveBotLifeState, learn = Database.learnBotSkill;
    let repairs = 0, spent = 0, consumed = 0;
    try {
        await Database.createAccount('bot_paid_skill_authority', 'fixture');
        for (const id of ids) await Database.execute(['UPDATE characters SET username=?,sp=10000000 WHERE id=?', ['bot_paid_skill_authority',id]]);
        assert((await Database.learnBotSkill(ids[0],1177,1)).learned);
        const paid = await Database.fetchSkills(ids[0]);
        for (const [index,id] of ids.entries()) {
            const state = { level:40, stats:{classId:12} };
            const snapshot = index === 0 ? { skillSource:'tree', version:Profile.PROFILE_VERSION,
                skills:Profile.skillSnapshotsFromRecords(Profile.skillRecordsFromTree(12,40)) }
                : index === 1 ? { skillSource:'tree', skills:[] }
                    : { skillSource:'hot', version:Profile.PROFILE_VERSION, skills:Profile.skillSnapshotsFromRecords(paid) };
            const stats = { classId:12, classProgressionClassId:12, classProgressionLevel:40, coldCombat:snapshot };
            await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,sp,adena,phase,activity,
                currentRegion,hp,maxHp,mp,maxMp,statsJson,inventorySummary,updatedAt)
                VALUES(?, 'bot_paid_skill_authority', ?,40,10000000,963130,'cold','resting','Giran',187,187,74,74,?,'{}',?)`,
                [id, `Paid${id}`, JSON.stringify(stats),id]]);
            assert.equal(Profile.treeSnapshot({ ...state,stats:{...state.stats,coldCombat:snapshot} }).skills.length,
                index === 2 ? paid.length : 0, 'projection never promotes legacy eligibility to learned skills');
        }
        Database.saveBotLifeState = (...args) => { repairs++; return save(...args); };
        await Life.init();
        assert.equal(repairs,2,'only legacy profiles are persisted before readiness');
        const state = Life.cachedState(ids[0]);
        assert.equal(state.stats.coldCombat.skillSource,'database');
        assert.deepEqual(state.stats.coldCombat.skills.map(s=>[s.selfId,s.level]),paid.map(s=>[s.selfId,s.level]));
        assert(!state.stats.coldCombat.skills.some(s=>s.selfId===1171));
        assert(Books.missingBooks(state).some(b=>b.skillId===1171),'unpaid Blazing Circle becomes a book wish again');
        assert.equal(state.sp,10000000,'repair costs no SP');
        assert.deepEqual(await Database.fetchSkills(ids[0]),paid,'repair never grants ranks');
        const row = (await Database.execute(['SELECT statsJson,sp FROM bot_life_state WHERE characterId=?',[ids[0]]]))[0];
        assert.equal(JSON.parse(row.statsJson).coldCombat.skillSource,'database','repair persisted before workers can reload');
        const empty = Life.cachedState(ids[1]);
        assert.equal(Profile.profileFor(empty).skills.length,0,'empty learned kit cannot fall back to the tree');
        assert.equal(Profile.treeSnapshot({ ...state,level:70 }).skills.length,paid.length,'levelling requires paid learning');
        assert.deepEqual(Profile.treeSnapshot({ ...state,level:1 }).skills,state.stats.coldCombat.skills,'delevel retains paid ranks');
        const legacy = { ...state, stats:{ ...state.stats,coldCombat:{ skillSource:'tree',skills:Profile.skillSnapshotsFromRecords(Profile.skillRecordsFromTree(12,40)) } } };
        assert.equal(Profile.profileFor(legacy).skills.length,0,'an unhydrated old kit is never combat authority');
        await Life.init(); assert.equal(repairs,2,'ready init never repairs twice');

        const book = Books.nextTraining(12,40,1171);
        assert.equal(book.bookId,3075);
        await Database.setItem(ids[0],{selfId:book.bookId,name:'Spellbook: Blazing Circle',amount:2});
        const inventory = Life.inventorySummaryFromItems(await Database.fetchItems(ids[0]));
        await Database.execute(['UPDATE bot_life_state SET inventorySummary=? WHERE characterId=?',[JSON.stringify(inventory),ids[0]]]);
        const source = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?',[ids[0]]]))[0]);
        Database.learnBotSkill = async (...args) => {
            const result = await learn(...args);
            if(result.learned){spent+=result.spentSp;consumed+=(result.consumedBooks||[]).reduce((n,b)=>n+b.amount,0);}
            return result;
        };
        const trained = await Life.reviewTrainingAfterCommit(source);
        assert(trained.stats.coldCombat.skills.some(s=>s.selfId===1171&&s.level===2));
        assert.equal(consumed,1,'first rank consumes exactly one book; rank upgrade uses no second book');
        assert.equal(trained.sp,source.sp-spent,'kit refresh preserves the actual SP debit');
        assert.equal((await Database.fetchItems(ids[0])).find(i=>i.selfId===book.bookId).amount,1);
        const before = { sp:trained.sp, skills:await Database.fetchSkills(ids[0]), items:await Database.fetchItems(ids[0]) };
        await Life.reviewTrainingAfterCommit(trained);
        assert.deepEqual({ sp:Life.cachedState(ids[0]).sp,skills:await Database.fetchSkills(ids[0]),items:await Database.fetchItems(ids[0]) },before,'repeated training cannot charge twice');
        console.log('Cold paid-skill authority: legacy startup repair, restored book demand, empty/hot/delevel kits, native SP/book once passed');
    } finally {
        Database.saveBotLifeState=save; Database.learnBotSkill=learn;
        await world.close();
    }
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
