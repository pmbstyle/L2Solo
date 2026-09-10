const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Policy = require('../src/GameServer/Clan/ClanSocialPolicy');
const View = require('../src/GameServer/Clan/ClanSocialView');
const Interaction = require('../src/GameServer/Social/InteractionMemory');
const Personal = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Competition = require('../src/GameServer/Social/ResourceCompetitionPolicy');
const { attach } = require('../src/GameServer/Clan/ClanSocialEvidence');
const at = Date.now() - 5 * Policy.DAY;
const event = (n, source = 3, target = 2, type = 'attacked', time = at + n * Policy.HOUR * 2, responsibility = 'aggression') => Personal.event(attach({
    key: `clan-test:${n}:${source}:${target}:${type}`, sourceId: source, targetId: target, type, at: time
}, { clanId: source <= 2 ? 10 : 20 }, { clanId: target <= 2 ? 10 : 20 }, `episode:${n}`, responsibility, true));
let s = Policy.empty(20);
s = Policy.apply(s, event(0), at);
assert.strictEqual(s.relations.filter(r => r.kind === 'clan').length, 0, 'one offender does not condemn the clan');
const once = JSON.stringify(s);
assert.strictEqual(JSON.stringify(Policy.apply(s, event(0), at)), once, 'replay is idempotent');
assert.strictEqual(JSON.stringify(Policy.apply(s, event(1, 3, 2, 'attacked', at, 'defense'), at)), once, 'self defense does not create collective guilt');
assert.strictEqual(JSON.stringify(Policy.apply(s, event(1, 3, 2, 'attacked', at, 'unknown'), at)), once, 'unknown responsibility is not inferred');
for (let i = 1; i < 5; i++) s = Policy.apply(s, event(i), at + i * 2 * Policy.HOUR);
assert(!s.relations.some(r => r.kind === 'clan'), 'one repeated troublemaker remains personally responsible');
s = Policy.apply(s, event(5, 4, 1), at + 10 * Policy.HOUR);
assert(s.relations.some(r => r.kind === 'clan' && r.targetId === 10), 'independent offenders and encounters support collective responsibility');
const outside = Policy.relation(s.relations.find(r => r.kind === 'character' && r.targetId === 2), at + 10 * Policy.HOUR);
assert(Policy.relation(outside, at + 60 * Policy.DAY).hostility < outside.hostility, 'old grievances decay');
let group = Policy.empty(20);
for (let id = 3; id < 12; id++) group = Policy.apply(group, event(0, id), at);
assert.strictEqual(group.relations.find(r => r.kind === 'character').hostility, 6, 'nine witnesses are one episode');
const rescued = event(12, 3, 2, 'resurrected', at + Policy.DAY, 'cooperation');
let positive = Policy.apply(Policy.empty(20), rescued, rescued.at);
assert(positive.relations[0].trust > 0);
for (let i = 0; i < 100; i++) positive = Policy.apply(positive, { ...rescued, key: `gift:${i}`, clan: { ...rescued.clan, episode: `gift:${i}` } }, rescued.at);
assert(positive.relations[0].trust <= 6, 'repeated cheap positives cannot wash reputation');

const main = new Interaction(), worker = new Interaction();
for (const memory of [main, worker]) {
    memory.clanSocial = new View(); memory.accept(Personal.empty(3));
    memory.clanSocial.acceptMemberships([{ id: 3, clanId: 20 }, { id: 2, clanId: 10 }], 1);
    memory.clanSocial.accept(JSON.parse(JSON.stringify(s)));
}
const mainRelation = main.assess({ id: 3 }, { id: 2 }, {}, at + Policy.DAY);
assert.deepStrictEqual(mainRelation, worker.assess({ id: 3 }, { id: 2 }, {}, at + Policy.DAY), 'hot and cold read the same shared projection');
assert(mainRelation.effective.hostility > 0 && mainRelation.personal === null);
const persona = { traits: { assertiveness: 0.7, caution: 0.2, empathy: 0.2, resilience: 0.2 } };
assert(Competition.escalationChance(persona, mainRelation) > Competition.escalationChance(persona, { ready: true, personal: null }));
const probation = { ...mainRelation, clanSocial: { ...mainRelation.clanSocial, selfDiscipline: { stage: 'probation' } } };
assert(Competition.escalationChance(persona, probation) < Competition.escalationChance(persona, mainRelation), 'probation changes the member\'s actual escalation decision');
const cappedTrust = positive.relations[0].trust;
const later = rescued.at + Policy.HOUR;
for (let i = 0; i < 10; i++) positive = Policy.apply(positive, { ...rescued, at: later, key: `later-help:${i}`,
    clan: { ...rescued.clan, episode: `later-help:${i}` } }, later);
assert(Math.abs(positive.relations[0].trust - cappedTrust * 0.5 ** (Policy.HOUR / (7 * Policy.DAY))) < 1e-9,
    'rate-limited events cannot apply decay repeatedly to an old timestamp');
assert.strictEqual(main.clanSocial.accept({ ...s, revision: s.revision - 1 }), false);
main.clanSocial.acceptMemberships([{ id: 3, clanId: 20 }, { id: 2, clanId: 30 }], 2);
assert.strictEqual(main.assess({ id: 3 }, { id: 2 }, {}, at + Policy.DAY).clanSocial.collective, null, 'old clan guilt does not transfer to a new clan');
assert(main.assess({ id: 3 }, { id: 2 }, {}, at + Policy.DAY).clanSocial.individual, 'personal reputation follows the offender');

require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-clan-social-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
async function run() {
    DB.init();
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('bot_pop_social','test')", []]);
    for (let id = 1; id <= 4; id++) {
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,'bot_pop_social',?,1,0,20,500,200,0,0,0,0,1,1,1)`, [id, `Social${id}`]]);
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,statsJson,updatedAt)
            VALUES (?,'bot_pop_social',?,'cold','hunting',?,?)`, [id, `Social${id}`, JSON.stringify({ generatedCold: true, clanId: id <= 2 ? 10 : 20 }), at]]);
    }
    await DB.execute(["INSERT INTO clans(id,name,leaderId) VALUES (10,'SocialA',1),(20,'SocialB',3)", []]);
    await DB.execute(['UPDATE characters SET clanId = CASE WHEN id <= 2 THEN 10 ELSE 20 END', []]);
    await DB.execute([`INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson)
        VALUES (10,1,'autonomous',?,?,?)`, [at, at, JSON.stringify({ clanId: 10, leaderId: 1, memberIds: [1,2] })]]);
    const load = async id => JSON.parse((await DB.execute(['SELECT snapshotJson FROM clan_social_memory WHERE clanId = ?', [id]]))[0].snapshotJson);
    const first = event(0);
    assert((await DB.commitInteractionMemory([first])).ok);
    const saved = await load(10);
    await DB.commitInteractionMemory([first]);
    assert.deepStrictEqual(await load(10), saved, 'SQL replay does not increment clan memory');
    const beforeBad = JSON.stringify(await load(20));
    const bad = await DB.commitInteractionMemory([event(1), event(2, 3, 2, 'attacked', Date.now() + 60000)]);
    assert(!bad.ok);
    assert.strictEqual(JSON.stringify(await load(20)), beforeBad, 'rejected batch has no clan consequences');
    let snapshot = saved;
    const stages = new Set();
    for (let n = 1; n < 48; n++) {
        const result = await DB.commitInteractionMemory([event(n)]);
        assert(result.ok, JSON.stringify(result));
        snapshot = await load(10);
        const d = snapshot.relations.find(r => r.targetId === 2 && r.kind === 'character').discipline;
        stages.add(d.stage);
        if (d.stage === 'expulsion_pending') break;
    }
    assert(stages.has('warned') && stages.has('probation') && stages.has('expulsion_pending'), [...stages].join(','));
    await DB.close(); DB.init();
    assert.deepStrictEqual(await load(10), snapshot, 'warning/probation survive a real SQLite reopen');
    assert(!(await DB.expelDisciplinedClanMember(10, 2, snapshot.revision - 1)).ok, 'stale discipline cannot expel');
    await DB.execute(["UPDATE bot_life_state SET simulationLeaseId='busy' WHERE characterId=2", []]);
    assert.strictEqual((await DB.expelDisciplinedClanMember(10, 2, snapshot.revision)).reason, 'member_busy');
    await DB.execute(['UPDATE bot_life_state SET simulationLeaseId=NULL WHERE characterId=2', []]);
    const expelled = await DB.expelDisciplinedClanMember(10, 2, snapshot.revision);
    assert(expelled.ok, JSON.stringify(expelled));
    assert.strictEqual((await DB.execute(['SELECT clanId FROM characters WHERE id=2', []]))[0].clanId, 0);
    assert.strictEqual(JSON.parse(expelled.row.statsJson).clanId, 0);
    assert(expelled.memorySnapshots[0].relations.some(r => r.kind === 'clan' && r.targetId === 10), 'expelled bot remembers the clan');
    assert(!(await DB.expelDisciplinedClanMember(10, 2, expelled.snapshot.revision)).ok, 'expulsion is idempotent');
    assert.strictEqual((await DB.joinAutonomousClan({ clanId: 10, characterId: 2 })).code, 'clan_discipline_cooldown');
    await DB.close(); DB.init();
    assert.strictEqual((await DB.joinAutonomousClan({ clanId: 10, characterId: 2 })).code, 'clan_discipline_cooldown', 'restart cannot bypass rejoin cooldown');
    await DB.execute(['UPDATE characters SET clanJoinExpiryTime=0 WHERE id=2', []]);
    assert.strictEqual((await DB.joinAutonomousClan({ clanId: 10, characterId: 2 })).code, 'clan_distrust', 'expiry alone does not repair trust');
    await DB.execute([`INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson)
        VALUES (20,1,'autonomous',?,?,?)`, [at, at, JSON.stringify({ clanId: 20, leaderId: 3, memberIds: [3,4] })]]);
    for (let n = 0; n < 48; n++) {
        assert((await DB.commitInteractionMemory([event(n, 1, 4)])).ok);
        const d = (await load(20)).relations.find(r => r.kind === 'character' && r.targetId === 4)?.discipline;
        if (d?.stage === 'expulsion_pending') break;
    }
    await Life.init();
    const Service = invoke('GameServer/Clan/ClanService'), Runtime = invoke('GameServer/Clan/ClanSocialRuntime');
    await Service.reload(); await Runtime.refresh(true);
    const notified = [], fenced = [];
    const coordinator = { competitionActions: { canRun: () => true }, stopping: false,
        fenceBot: async id => { fenced.push(id); return { ok: true }; }, notifyState: state => notified.push(state.characterId) };
    await Runtime.enforceOne(coordinator);
    assert.deepStrictEqual(fenced, [4], 'runtime fences the actual pending member');
    assert(notified.includes(4));
    assert.strictEqual(Life.cachedState(4).stats.clanId, 0);
    assert(!Service.findById(20).members.some(m => m.id === 4));
    assert.strictEqual(Runtime.view.identity({ id: 4, clanId: 20 }).clanId, 0, 'authoritative absence overrides stale membership');
    const sent = [];
    Runtime.send({ workerEpoch: 'social-test', post: (type, payload) => { sent.push({ type, payload: JSON.parse(JSON.stringify(payload)) }); return true; } });
    assert(sent.length >= 2);
    const remote = new View();
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    for (const { type, payload } of sent) {
        assert(Protocol.validateEnvelope(Protocol.envelope(type, 'social-test', payload), 'main').ok);
        payload.rows.forEach(s => remote.accept(s));
        if (payload.memberships) remote.acceptMemberships(payload.memberships, payload.membershipVersion, payload.activeClanIds);
    }
    const assessedAt = Date.now();
    assert.deepStrictEqual(remote.assess({ id: 3 }, { id: 4 }, null, assessedAt), Runtime.view.assess({ id: 3 }, { id: 4 }, null, assessedAt));
    let repeatPages = 0;
    Runtime.send({ workerEpoch: 'social-test', post: () => { repeatPages++; return true; } });
    assert.strictEqual(repeatPages, 0, 'unchanged shared memory is not sent once per bot');
    const Help = invoke('GameServer/Social/CombatHelpMemory'), Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const oldEnqueue = Memory.events.enqueue, helps = [];
    Memory.events.enqueue = e => { helps.push(e); return true; };
    try {
        const helper = { fetchId: () => 1, fetchClanId: () => 10 };
        const victim = { fetchId: () => 3, fetchClanId: () => 20, state: { fetchDead: () => false }, session: { accountId: 'bot_pop_test' } };
        assert(!Help.record(helper, victim, { heal: 20 }, { hp: 90, maxHp: 100, combat: true }, Date.now()));
        assert(Help.record(helper, victim, { heal: 20 }, { hp: 10, maxHp: 100, combat: true }, Date.now()));
        assert(!Help.record(helper, victim, { heal: 20 }, { hp: 10, maxHp: 100, combat: true }, Date.now()));
        assert.strictEqual(helps.length, 1);
        assert.strictEqual(helps[0].clan.responsibility, 'cooperation');
    } finally { Memory.events.enqueue = oldEnqueue; }
    console.log('Clan social: attribution, bounded episodes, independence, decay, cooperation, hot/cold parity, SQLite atomicity, staged discipline, expulsion and rejoin protection passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
