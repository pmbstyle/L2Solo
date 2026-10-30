const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Clans = invoke('GameServer/Clan/ClanService'), War = invoke('GameServer/Clan/ClanWarRuntime');
const Policy = require('../src/GameServer/Clan/ClanWarPolicy');
const Config = require('../src/GameServer/Clan/ClanWarConfig');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-war-ceasefire-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
let clock = Date.now(), director;
const traits = { assertiveness: 1, commitment: 1, ambition: 1, caution: 0 };
const actor = clanId => ({ fetchId: () => ({ 10: 1, 20: 16, 30: 31 }[clanId]), fetchClanId: () => clanId });
const command = (own, enemy, action) => War.transition(actor(own), enemy, action, { announce: false });
const social = { clans: new Map() };
const states = [1, 2, 3].map(characterId => ({ characterId, accountName: 'bot_ceasefire', phase: 'cold',
    activity: 'hunting', spotId: 'home', loc: { locX: 50000, locY: 15000, locZ: -5000 },
    vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, stats: { clanId: 10 } }));
const createDirector = () => new ClanWarDirector({ database: DB, clans: Clans, war: War, social,
    life: { cachedState: id => states.find(s => s.characterId === id), subscribePublications: () => () => {} },
    parties: { admitted: () => [] }, personaFor: () => ({ traits }), now: () => clock });
async function review() { director.plans.get(10).nextReviewAt = 0; await director.review(Clans.findById(10), clock); }
async function run() {
    DB.init();
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('bot_ceasefire','test')"]);
    for (let id = 1; id <= 45; id++) await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,
        sex,face,hair,hairColor,locX,locY,locZ,clanId) VALUES (?,'bot_ceasefire',?,0,0,40,1000,1000,500,500,0,0,0,0,50000,15000,-5000,?)`,
    [id, `Ceasefire${id}`, id <= 15 ? 10 : id <= 30 ? 20 : 30]]);
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'Own',1,3),(20,'OldEnemy',16,3),(30,'NewEnemy',31,3)"]);
    await DB.execute(["INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson) VALUES (10,1,'autonomous',?,?,'{}')", [clock, clock]]);
    await Clans.reload(); await War.refresh(true);
    assert((await command(10, 20, 'declare')).ok); assert((await command(20, 10, 'declare')).ok);
    // Backdate only this isolated fixture to exercise a normal quiet withdrawal.
    await DB.execute(['UPDATE clan_war_declarations SET declaredAt=?', [clock - Config.quietWithdrawMs - 1]]);
    War.view.replace(await DB.fetchClanWars());
    director = createDirector(); await director.start(); states.forEach(s => director.index(s, s.characterId));
    await director.review(Clans.findById(10), clock);
    assert(!War.view.between(10, 20).outgoing);
    let plan = director.plans.get(10);
    assert(plan.ceasefires[20].until > clock && !plan.ceasefireUntil, 'withdrawal creates an opponent pause, not a global one');
    assert(!Policy.canDeclare(plan, 20, clock), 'the clan cannot immediately restart the old conflict itself');
    assert(Policy.canDeclare(plan, 30, clock), 'another opponent is unaffected');
    await review();
    assert(!War.view.between(10, 20).outgoing, 'the old unchanged incoming declaration does not immediately undo withdrawal');
    assert((await command(30, 10, 'declare')).ok);
    await review();
    assert(War.view.between(10, 30).mutual, 'a new enemy declaration is accepted during the old opponent pause');
    assert(!War.view.between(10, 20).outgoing);
    director.stop(); director = createDirector(); await director.start(); states.forEach(s => director.index(s, s.characterId));
    assert(director.plans.get(10).ceasefires[20], 'the old opponent pause survives restart after answering another clan');
    await review(); assert(!War.view.between(10, 20).outgoing);
    assert((await command(20, 10, 'withdraw')).ok); assert((await command(20, 10, 'declare')).ok);
    await review();
    assert(War.view.between(10, 20).mutual, 'a fresh declaration by the old enemy can also be answered');
    plan = director.plans.get(10);
    assert(Policy.canDeclare(plan, 20, plan.ceasefires[20].until), 'the old initiation pause expires at its boundary');
    const legacy = { ceasefireUntil: clock + Config.redeclareCooldownMs,
        lastDecision: { accepted: true, action: 'withdraw', targetClanId: 20, at: clock - 1000 } };
    const saved = (await DB.fetchClanWarPlans()).find(r => r.clanId === 10);
    assert((await DB.saveClanWarPlan(10, saved.revision, legacy)).ok);
    director.stop(); director = createDirector(); await director.start();
    plan = director.plans.get(10);
    assert.deepEqual(plan.ceasefires[20], { until: legacy.ceasefireUntil, withdrawnAt: legacy.lastDecision.at });
    assert(!plan.ceasefireUntil && !Policy.canDeclare(plan, 20, clock) && Policy.canDeclare(plan, 30, clock),
        'legacy plans are migrated without applying their pause to unrelated enemies');
    assert(Policy.canDeclare(plan, 20, clock, { declaredAt: clock, revision: 999 }), 'fresh incoming declarations override migrated pauses');
    console.log('War ceasefire: opponent scope, old declaration suppression, new enemy and renewed enemy replies, restart, expiry and legacy migration passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    director?.stop(); War.view.replace([]); await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
