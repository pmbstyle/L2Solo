const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const scratch = path.join(process.cwd(), 'tmp', 'test-group-f-spoil');
fs.mkdirSync(scratch, { recursive: true });
const tmpdir = os.tmpdir;
os.tmpdir = () => scratch;
const { createWorld, enableQuestSpawns, Service, DataCache } = require('./helpers/c4QuestHarness');
const H = invoke('GameServer/Quest/SecondProfessionQuest');
const Quest = invoke('GameServer/Quest/quests/Q216_TrialOfGuildsman');
const Spoil = invoke('GameServer/Npc/SpoilSweep');
const Skill = invoke('GameServer/Model/Skill');

async function run() {
    const world = await createWorld([{ id: 710061, classId: 54, race: 4, level: 35 }], 'failed-spoil');
    const runtime = enableQuestSpawns();
    const random = Math.random;
    try {
        const session = await world.session(710061);
        const state = Service.stateFor(session, Quest);
        await H.step(state, 5, { status: 'started', variables: { pinter: '1' }, gives: [[3122, 1], [3135, 1]] });
        let casting = false;
        Object.assign(session.actor, {
            state: { fetchCasts: () => casting, setCasts(value) { casting = value; } },
            attack: { queueTimer(callback) { callback(); } },
            fetchMp() { return this.mp; }, setMp(value) { this.mp = value; },
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0,
            statusUpdateVitals() {}, automation: { replenishVitals() {} }
        });
        session.actor.mp = 1000;
        const npc = (id) => ({ model: {}, fetchSelfId: () => 79, fetchId: () => id,
            fetchLevel: () => 35, fetchAttackable: () => true, isDead: () => false, enterCombatState() {} });
        const target = npc(790061);
        runtime.npc.spawns.push(target);
        const template = DataCache.skills.find(row => Number(row.selfId) === 254);
        const skill = new Skill({ ...utils.crushOb(template), ...template.levels.find(row => Number(row.level) === 4),
            selfId: 254, level: 4 });
        Math.random = () => 0.005;
        Spoil.castSpoil(session, session.actor, target, skill);
        await session.questMutationTail;
        assert.equal(!!target.model.spoil?.spoiled, false, 'exercise an actual failed Spoil roll');
        assert.equal(await world.amount(710061, 3136), 0, 'failed Spoil grants no Q216 Amber Beads');
        await Service.onSkillSee(session, target, skill);
        assert.equal(await world.amount(710061, 3136), 0, 'a direct callback without a landed Spoil grants nothing');
        const foreign = npc(790062);
        foreign.model.spoil = { spoiled: true, spoilerId: 710062 };
        runtime.npc.spawns.push(foreign);
        await Service.onSkillSee(session, foreign, skill);
        assert.equal(await world.amount(710061, 3136), 0, 'another caster owns the successful Spoil');
        Math.random = () => 0.5;
        Spoil.castSpoil(session, session.actor, target, skill);
        await session.questMutationTail;
        assert.equal(target.model.spoil?.spoilerId, 710061, 'the successful real cast belongs to the quest actor');
        assert.equal(await world.amount(710061, 3136), 5, 'successful Spoil grants the authored five beads');
        await Service.onSkillSee(session, target, skill);
        assert.equal(await world.amount(710061, 3136), 5, 'duplicate callback grants no second reward');
        console.log('Q216: failed/foreign Spoil grants nothing; landed own Spoil grants five beads once');
    } finally {
        Math.random = random;
        os.tmpdir = tmpdir;
        await world.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
