'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
const DB = invoke('Database'), Clans = invoke('GameServer/Clan/ClanService'), War = invoke('GameServer/Clan/ClanWarRuntime');
const Journal = invoke('PvpJournal'), Config = require('../src/GameServer/Clan/ClanWarConfig');
const Policy = require('../src/GameServer/Clan/ClanWarPolicy');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-war-casualties-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
const at = Date.now(), HOUR = 3600000;
let director, clock = at, traits = { assertiveness: 1, commitment: 1, ambition: 1, caution: 0 };
const aggressive = { ...traits }, cautious = { assertiveness: 0, commitment: 0.2, ambition: 0, caution: 1 };
const actor = (id, clanId) => ({ fetchId: () => id, fetchClanId: () => clanId, fetchLevel: () => 40, fetchKarma: () => 0 });
const casualty = (victimId, stamp = at) => Journal.hotKill({ attacker: actor(51, 20), victim: actor(victimId, 10),
    pk: false, attackerKarma: 0, playerInvolved: true, at: stamp });
const command = (own, enemy, action) => War.transition(actor(own === 10 ? 1 : 51, own), enemy, action, { announce: false });
const resetReview = () => { const p = director.plans.get(10); if (p) p.nextReviewAt = 0; };
async function run() {
    DB.init();
    assert.equal(Config.quietWithdrawMs, HOUR);
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('bot_casualties','test')"]);
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'LossClan',1,3),(20,'EnemyClan',51,3)"]);
    await DB.execute(["INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson) VALUES (10,1,'autonomous',?,?,?)", [at, at, '{}']]);
    for (const clanId of [10, 20]) for (let n = 1; n <= 40; n++) {
        const id = clanId === 10 ? n : n + 50;
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
            VALUES (?,'bot_casualties',?,0,0,40,1000,1000,500,500,0,0,0,0,50000,15000,-5000,?)`, [id, `Casualty${id}`, clanId]]);
    }
    await Clans.reload(); await War.refresh(true);
    assert((await command(10, 20, 'declare')).ok); assert((await command(20, 10, 'declare')).ok);
    for (const id of [1, 2, 3]) casualty(id);
    const retry = Journal.snapshot()[0];
    Journal.record(retry); // Same journal batch/fact retried, not a second death.
    Journal.coldConflict({ key: 'rejected-attempt', fought: false, partyIds: [null, null], sideSizes: [1, 1],
        principals: [{ characterId: 51, stats: { clanId: 20 } }, { characterId: 4, stats: { clanId: 10 } }],
        outcome: 'refused', kills: [{ killerId: 51, victimId: 4, pvp: true }], at });
    Journal.coldConflict({ key: 'interrupted-before-action', fought: true, actions: 0, partyIds: [null, null], sideSizes: [1, 1],
        principals: [{ characterId: 51, stats: { clanId: 20 } }, { characterId: 4, stats: { clanId: 10 } }], outcome: 'pvp_interrupted', at });
    assert.deepEqual(Journal.snapshot().at(-1).warFacts, [], 'a scheduled encounter without an executed action is not a battle');
    await DB.execute([`CREATE TRIGGER reject_casualty BEFORE INSERT ON clan_war_combat
        BEGIN SELECT RAISE(ABORT,'fixture_casualty_failure'); END`]);
    await assert.rejects(DB.flushJournals(), /fixture_casualty_failure/);
    assert.equal((await DB.execute(['SELECT COUNT(*) AS n FROM clan_war_combat']))[0].n, 0, 'a failed journal transaction publishes no casualty facts');
    assert.equal(Journal.snapshot().length, 6, 'the journal remains available for a retry after rollback');
    await DB.execute(['DROP TRIGGER reject_casualty']);
    await DB.flushJournals();
    let pressure = await DB.fetchClanWarPressure(10, at - HOUR, at);
    assert.deepEqual(pressure, [{ enemyClanId: 20, losses: 3, kills: 0, victims: 3, combatAt: at }]);
    let queryAt = at;
    const delayedRead = DB.fetchClanWarPressure(10, () => queryAt - HOUR, () => queryAt);
    queryAt = at + HOUR + 1;
    assert.deepEqual(await delayedRead, [], 'queued combat reads evaluate the rolling window when the read executes');
    assert.equal((await DB.fetchClanWarPressure(20, at - HOUR, at))[0].kills, 3, 'both clans see the same committed deaths');
    await DB.execute(['UPDATE characters SET clanId=0 WHERE id=3']);
    assert.equal((await DB.fetchClanWarPressure(10, at - HOUR, at))[0].victims, 3, 'later membership changes cannot reassign casualties');
    await DB.execute(['UPDATE characters SET clanId=10 WHERE id=3']);
    await DB.close(); DB.init();
    assert.equal((await DB.fetchClanWarPressure(10, at - HOUR, at))[0].losses, 3, 'casualties survive SQLite reopening');
    assert.deepEqual(await DB.fetchClanWarPressure(10, at + 1, at + HOUR + 1), [], 'old deaths leave the rolling window');
    assert.equal(Policy.lossResponse({ pressure: { losses: 30, victims: 1 }, traits: cautious, members: 40, readyMembers: 8, mutual: true }), null,
        'farming one revived victim cannot simulate slaughtering the clan');
    assert.equal(Policy.lossResponse({ pressure: pressure[0], traits: cautious, members: 40, readyMembers: 8, mutual: true }), 'withdraw');
    assert.equal(Policy.lossResponse({ pressure: pressure[0], traits: aggressive, members: 40, readyMembers: 8, mutual: true }), 'counterattack');
    assert.equal(Policy.lossResponse({ pressure: { ...pressure[0], kills: 10 }, traits: {}, members: 40, readyMembers: 8, mutual: true }), 'counterattack',
        'a favorable kill exchange increases resolve instead of treating a winning clan as a routed one');
    assert.equal(Policy.lossResponse({ pressure: pressure[0], traits: aggressive, members: 40, readyMembers: 2, mutual: true }), 'withdraw');
    assert.equal(Policy.lossResponse({ pressure: pressure[0], traits: aggressive, members: 40, readyMembers: 8, mutual: false }), 'withdraw');
    const states = [1, 2, 3].map(id => ({ characterId: id, accountName: 'bot_casualties', phase: 'cold', activity: 'hunting',
        level: 40, spotId: 'home', loc: { locX: 50000, locY: 15000, locZ: -5000 },
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, stats: { clanId: 10, classId: id === 3 ? 15 : 0 } }));
    director = new ClanWarDirector({ database: DB, clans: Clans, war: War, social: { clans: new Map() },
        life: { cachedState: id => states.find(s => s.characterId === id), subscribePublications: () => () => {} },
        parties: { admitted: () => [], active: () => [] }, personaFor: () => ({ traits }), form: async () => assert.fail('no unwitnessed deployment'),
        now: () => clock, memory: {}, actions: {} });
    await director.start();
    assert.equal(director.inspect().policy.quietWithdrawMs, HOUR, 'Observer exposes the actual running withdrawal interval');
    states.forEach(s => director.index(s, s.characterId));
    assert(!Policy.available({ ...states[0], phase: 'hot' }, at), 'hot fighters are not cold formation candidates');
    assert(Policy.available({ ...states[0], phase: 'hot' }, at, { allowHot: true }), 'living visible fighters still contribute to clan resolve');
    director.plans.set(10, { revision: 0, intel: [], nextOperationAt: at + Config.operationCooldownMs });
    await director.review(Clans.findById(10), at);
    let plan = director.plans.get(10);
    assert.equal(plan.lossResponse.action, 'counterattack');
    assert.equal(plan.nextOperationAt, at + 120000, 'an aggressive clan advances its next expedition');
    assert.equal(director.operationCooldown(plan, 20, at), 120000);
    assert.equal(director.operationCooldown(plan, 30, at), 600000, 'another enemy does not inherit the retaliation bonus');
    assert.equal(director.operationCooldown(plan, 20, at + HOUR), 600000, 'the response expires');
    assert.equal(director.prepareAssembly(Clans.findById(10), { ...plan, nextOperationAt: 0 }, at).reason, 'no_fresh_intel');
    const sighting = { enemyClanId: 20, spotId: 'seen-farm', loc: { locX: 50020, locY: 15000, locZ: -5000 }, at, observerId: 1 };
    assert.equal(director.prepareAssembly(Clans.findById(10), { ...plan, intel: [sighting], nextOperationAt: 0 }, at).selected.length, 3,
        'retaliation uses the ordinary healer/roster and witnessed-target checks');
    assert.equal(director.prepareAssembly(Clans.findById(10), { ...plan, intel: [sighting], nextOperationAt: 0 }, at,
        Array.from({ length: Config.maxActiveOperations }, () => ({ stats: { warOperation: {} } }))).reason, 'operation_capacity');
    assert.equal((await DB.fetchClanWarPlans()).map(r => JSON.parse(r.stateJson))[0].lossResponse.action, 'counterattack');
    traits = cautious; resetReview(); await director.review(Clans.findById(10), at);
    assert.equal(director.plans.get(10).lastDecision.reason, 'war_casualties', 'a cautious leader attempts peace at moderate real losses');
    assert.equal(War.view.between(10, 20).outgoing, false);
    assert((await command(10, 20, 'declare')).ok);
    traits = aggressive;
    // A committed cold kill of a party member, rather than the principal, is attributed to that member's clan.
    Journal.coldConflict({ key: 'committed-party-kill', fought: true, partyIds: ['enemy', 'own'], sideSizes: [1, 2],
        principals: [{ characterId: 51, stats: { clanId: 20 } }, { characterId: 1, stats: { clanId: 10 } }],
        combatants: [{ characterId: 51, stats: { clanId: 20 } }, { characterId: 4, stats: { clanId: 10 } }],
        outcome: 'killed', kills: [{ killerId: 51, victimId: 4, pvp: true }], at });
    for (let id = 5; id <= 20; id++) casualty(id);
    await DB.flushJournals();
    assert.equal((await DB.fetchClanWarPressure(10, at - HOUR, at))[0].victims, 20);
    const sessions = Clans.onlineSessions;
    try {
        Clans.onlineSessions = () => [{ actor: { state: { fetchCombats: () => true } } }];
        resetReview(); await director.review(Clans.findById(10), at);
        assert.equal(director.plans.get(10).lastDecision.code, 'clan_in_combat', 'heavy losses request peace without bypassing active combat');
        assert(War.view.between(10, 20).mutual);
    } finally { Clans.onlineSessions = sessions; }
    resetReview(); await director.review(Clans.findById(10), at);
    assert.equal(director.plans.get(10).lastDecision.reason, 'war_casualties', 'even an aggressive leader withdraws after overwhelming losses');
    assert.equal(War.view.between(10, 20).outgoing, false);
    assert.equal(War.view.between(20, 10).outgoing, true, 'the player enemy declaration remains under its own control');
    assert((await command(10, 20, 'declare')).ok);
    assert((await command(20, 10, 'withdraw')).ok);
    resetReview(); await director.review(Clans.findById(10), at);
    assert.equal(War.view.between(10, 20).status, 'neutral', 'heavy casualties also close the remaining unilateral bot declaration');
    // Inactivity follows a successful no-kill battle too, on both sides and across restart.
    await DB.execute(['DELETE FROM clan_war_combat']);
    assert((await command(10, 20, 'declare')).ok);
    director.plans.get(10).combatAt = {}; resetReview();
    Journal.coldConflict({ key: 'no-kill-battle', fought: true, partyIds: [null, null], sideSizes: [1, 1],
        principals: [{ characterId: 51, stats: { clanId: 20 } }, { characterId: 1, stats: { clanId: 10 } }],
        outcome: 'retreated', actions: 12, at: at + HOUR + 1001 });
    clock = at + HOUR + 1001;
    await director.review(Clans.findById(10), at + HOUR + 1000);
    assert(War.view.between(10, 20).outgoing, 'a battle completed after pulse start postpones quiet withdrawal for the defending clan');
    assert.equal(Journal.snapshot().length, 0, 'the review includes a just-ended battle before the periodic journal flush');
    assert.equal(director.plans.get(10).warPressure[0].losses, 0, 'no-kill battles and retreats are not casualties');
    clock += HOUR + 1;
    resetReview(); await director.review(Clans.findById(10), clock);
    assert.equal(director.plans.get(10).lastDecision.reason, 'conflict_cooled');
    assert.equal(War.view.between(10, 20).outgoing, false, 'one hour of actual quiet ends the declaration');
    const UI = require('../src/WorldObserver/public/clanWars');
    const html = UI.render({ declarations: [], campaigns: { active: true, operations: [], plans: [{ clanId: 10,
        warPressure: [{ enemyClanId: 20, losses: 3, victims: 3, kills: 0 }],
        lossResponse: { enemyClanId: 20, action: 'counterattack', until: at + HOUR } }] } }, 10, { now: at });
    assert(html.includes('3 deaths across 3 members') && html.includes('Preparing a counterattack'));
    console.log('War casualties: native/cold facts, retry deduplication, captured clan identity, persistence, rolling window, personality response, overwhelming losses, combat refusal, lawful counterattack gates and one-hour quiet withdrawal passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    director?.stop(); Journal.drain(); War.view.replace([]); await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
