'use strict';
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Books = invoke('GameServer/Skills/SkillBookCatalog');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
async function main() {
    const ids = [719410,719411,719412];
    const levelUpIds = [719413,719414];
    const world = await createWorld([...ids.map(id => ({ id, classId: 12, level: 40 })),
        ...levelUpIds.map(id => ({ id, classId: 46, level: 61 }))], 'cold-free-skill-authority');
    const save = Database.saveBotLifeState, learn = Database.learnBotSkill;
    let repairs = 0, spent = 0, consumed = 0;
    try {
        await Database.createAccount('bot_free_skill_authority', 'fixture');
        for (const id of ids) await Database.execute(['UPDATE characters SET username=?,sp=0 WHERE id=?', ['bot_free_skill_authority',id]]);
        assert((await Database.learnBotSkill(ids[0],1177,1)).learned);
        const owned = await Database.fetchSkills(ids[0]);
        for (const [index,id] of ids.entries()) {
            const state = { level:40, stats:{classId:12} };
            const snapshot = index === 0 ? { skillSource:'tree', version:Profile.PROFILE_VERSION,
                skills:Profile.skillSnapshotsFromRecords(Profile.skillRecordsFromTree(12,40)) }
                : index === 1 ? { skillSource:'tree', skills:[] }
                    : { skillSource:'hot', version:Profile.PROFILE_VERSION, skills:Profile.skillSnapshotsFromRecords(owned) };
            const stats = { classId:12, classProgressionClassId:12, classProgressionLevel:40, hennas:[null,null,null], coldCombat:snapshot };
            await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,sp,adena,phase,activity,
                currentRegion,hp,maxHp,mp,maxMp,statsJson,inventorySummary,updatedAt)
                VALUES(?, 'bot_free_skill_authority', ?,40,0,963130,'cold','resting','Giran',187,187,74,74,?,'{}',?)`,
                [id, `Free${id}`, JSON.stringify(stats),id]]);
            assert.equal(Profile.treeSnapshot({ ...state,stats:{...state.stats,coldCombat:snapshot} }).skills.length,
                index === 2 ? owned.length : 0, 'projection never promotes legacy eligibility to learned skills');
        }
        Database.saveBotLifeState = (...args) => { repairs++; return save(...args); };
        await Life.init();
        assert.equal(repairs,2,'only legacy profiles are persisted before readiness');
        const state = Life.cachedState(ids[0]);
        assert.equal(state.stats.coldCombat.skillSource,'database');
        assert.deepEqual(state.stats.coldCombat.skills.map(s=>[s.selfId,s.level]),owned.map(s=>[s.selfId,s.level]));
        assert(!state.stats.coldCombat.skills.some(s=>s.selfId===1171));
        assert.deepEqual(Books.missingBooks(state), [], 'missing free skills never create book demand');
        assert(Books.needsTraining(state), 'zero SP does not prevent reconciliation');
        assert.equal(state.sp,0,'repair costs no SP');
        assert.deepEqual(await Database.fetchSkills(ids[0]),owned,'repair never grants ranks');
        const row = (await Database.execute(['SELECT statsJson,sp FROM bot_life_state WHERE characterId=?',[ids[0]]]))[0];
        assert.equal(JSON.parse(row.statsJson).coldCombat.skillSource,'database','repair persisted before workers can reload');
        const empty = Life.cachedState(ids[1]);
        assert.equal(Profile.profileFor(empty).skills.length,0,'empty learned kit cannot fall back to the tree');
        assert.equal(Profile.treeSnapshot({ ...state,level:70 }).skills.length,owned.length,'projection waits for persisted automatic grants');
        assert.deepEqual(Profile.treeSnapshot({ ...state,level:1 }).skills,state.stats.coldCombat.skills,'delevel retains granted ranks');
        const legacy = { ...state, stats:{ ...state.stats,coldCombat:{ skillSource:'tree',skills:Profile.skillSnapshotsFromRecords(Profile.skillRecordsFromTree(12,40)) } } };
        assert.equal(Profile.profileFor(legacy).skills.length,0,'an unhydrated old kit is never combat authority');
        await Life.init(); assert.equal(repairs,2,'ready init never repairs twice');

        const book = Books.nextTraining(12,40,1171);
        assert.equal(book.bookId,null); assert.equal(book.sp,0);
        const bookId = Books.bookFor(1171); assert.equal(bookId,3075);
        await Database.setItem(ids[0],{selfId:bookId,name:'Spellbook: Blazing Circle',amount:2});
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
        assert.equal(consumed,0,'automatic grants never consume books'); assert.equal(spent,0);
        assert.equal(trained.sp,source.sp-spent,'kit refresh preserves SP');
        assert.equal((await Database.fetchItems(ids[0])).find(i=>i.selfId===bookId).amount,2);
        const before = { sp:trained.sp, skills:await Database.fetchSkills(ids[0]), items:await Database.fetchItems(ids[0]) };
        await Life.reviewTrainingAfterCommit(trained);
        assert.deepEqual({ sp:Life.cachedState(ids[0]).sp,skills:await Database.fetchSkills(ids[0]),items:await Database.fetchItems(ids[0]) },before,'repeated grants are idempotent');
        const migrated = await Life.migrateLegacyClassProgression();
        assert(migrated.some(row => row.characterId === ids[1]), 'startup queue fills an existing empty kit at zero SP');
        assert(Life.cachedState(ids[1]).stats.coldCombat.skills.length > 0);
        assert.equal(Life.cachedState(ids[1]).sp, 0);

        const coordinator = new ColdSimulationCoordinator();
        coordinator.economyDecisions.accept = () => {};
        coordinator.reviewCommittedEconomy = () => { throw Error('skill_grant_must_not_require_economy_plan'); };
        const answers = [];
        coordinator.worker = { postMessage: message => message.type === 'command_ack' && answers.push(...message.payload.results) };
        coordinator.workerEpoch = 'free-skill:test';
        // The training review the commit ack names, as the worker sends it.
        const review = async id => {
            coordinator.handleCommandRequest({ msgId: `skill:${answers.length}`, payload: { requests: [{ characterId: id,
                kind: 'review', commandId: `review:${id}:${answers.length}`,
                commandCheckpoint: Protocol.commandCheckpoint(Life.cachedState(id)), training: true }] } });
            await coordinator.commandTail;
            return answers.at(-1);
        };
        for (const [index,id] of levelUpIds.entries()) {
            await Database.execute(['UPDATE characters SET username=?,sp=0 WHERE id=?', ['bot_free_skill_authority',id]]);
            await Database.setSkill({ selfId:239, name:'Expertise C', level:3, passive:true },id);
            const stats = { classId:46, classProgressionClassId:46, classProgressionLevel:61,
                coldCombat:Profile.legacySnapshot({ stats:{classId:46} },await Database.fetchSkills(id)) };
            const state = await Life.upsertState({ characterId:id, accountName:'bot_free_skill_authority', name:`LevelUp${id}`,
                level:61, sp:0, phase:'cold', activity:index ? 'hunting' : 'grouped', stats,
                inventory:{}, vitals:{hp:187,maxHp:187,mp:74,maxMp:74} },'committed_level_up');
            assert(Books.needsTraining(state),'a committed level gain still needs its native grants');
            assert(Life.trainingNeeded(state),'the commit ack names its training review');
            // The ack names it for the step that moved the level fact (B13), not for one that moved nothing.
            assert.deepEqual(coordinator.reviewSteps({ durable:{ classId:46 } },state),{ review:['training'] },'a level step trains');
            assert.deepEqual(coordinator.reviewSteps({ durable:null },state),{},'a step that moved no level nor bag asks no training');
            coordinator.stopping = true;
            await review(id);
            assert.equal((await Database.fetchSkill(id,239))[0].level,3,'retired worker cannot grant ranks');
            coordinator.stopping = false;
            assert.equal((await review(id)).ok,true);
            assert.equal((await Database.fetchSkill(id,239))[0].level,4,
                `${state.activity} level-up grants skills even without an economy plan`);
            const trainedState = Life.cachedState(id);
            assert.equal(trainedState.stats.coldCombat.skills.find(skill=>skill.selfId===239).level,4);
            assert.equal(trainedState.sp,0,'postcommit grants remain free');
            assert.equal(Books.needsTraining(trainedState),false,'the entire eligible kit is published');
        }
        console.log('Cold free-skill authority: legacy repair, zero SP, no book demand, native grants and startup catch-up passed');
    } finally {
        Database.saveBotLifeState=save; Database.learnBotSkill=learn;
        await world.close();
    }
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
