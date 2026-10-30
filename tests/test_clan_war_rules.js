const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Rules = require('../src/GameServer/Clan/ClanWarRules');
const View = require('../src/GameServer/Clan/ClanWarView');
const view = new View();
const a = { fromClanId: 10, toClanId: 20, active: 1, revision: 1 };
assert(view.accept(a));
assert.equal(view.between(10, 20).status, 'outgoing');
assert.equal(view.between(20, 10).status, 'incoming');
view.accept({ ...a, fromClanId: 20, toClanId: 10, revision: 2 });
assert(view.between(10, 20).mutual);
assert(view.hasMutual(10) && view.hasMutual(20));
view.accept({ ...a, active: 0, revision: 3 });
assert.equal(view.between(10, 20).status, 'incoming');
assert(!view.hasMutual(10) && !view.hasMutual(20), 'ordinary bots can skip war perception after withdrawal');
assert(!view.accept(a), 'stale delivery cannot resurrect a withdrawn declaration');
assert(!view.between(10, 10).mutual);
assert.throws(() => view.accept({ ...a, active: true }), /invalid/);
const multi = new View();
multi.replace([a, { ...a, fromClanId: 20, toClanId: 10, revision: 2 },
    { ...a, toClanId: 30, revision: 3 }, { ...a, fromClanId: 30, toClanId: 10, revision: 4 }]);
multi.accept({ ...a, active: 0, revision: 5 });
assert(multi.hasMutual(10) && multi.hasMutual(30) && !multi.hasMutual(20), 'ending one front retains other active war perception');
multi.replace([]); assert(!multi.hasMutual(10));
const clan = { id: 10, level: 3, members: 15, allyId: 0 };
assert.equal(Rules.declaration(clan, { ...clan, id: 20 }), null);
assert.equal(Rules.declaration(clan, { ...clan, id: 20, level: 2 }), 'clan_level');
assert.equal(Rules.declaration(clan, { ...clan, id: 20, members: 14 }), 'clan_members');
assert.equal(Rules.declaration({ ...clan, members: 1 }, { ...clan, id: 20, members: 1 }, 0, { manual: true }), null,
    'manual player commands have no member minimum on either clan');
assert.equal(Rules.declaration(clan, { ...clan, id: 20, members: 1 }, 0, { replying: true }), null,
    'a ready bot clan may answer a declaration from a small clan');
assert.equal(Rules.declaration({ ...clan, members: 14 }, { ...clan, id: 20 }, 0, { replying: true }), 'clan_members',
    'answering a declaration does not waive the bot clan own member minimum');
assert.equal(Rules.declaration({ ...clan, members: 1 }, { ...clan, id: 20, level: 2 }, 0, { manual: true }), 'clan_level',
    'the player exception does not waive the clan level requirement');

require('../src/Global');
const DB = invoke('Database');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-war-rules-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
async function run() {
    DB.init();
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('bot_war_test','test')"]);
    for (let n = 1; n <= 30; n++) await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,'bot_war_test',?,1,0,40,100,100,0,0,0,0,1,1,1,?)`, [n, `War${n}`, n <= 15 ? 10 : 20]]);
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'WarA',1,3),(20,'WarB',16,3)"]);
    const command = (actorId, targetClanId, action = 'declare', extra = {}) => DB.transitionClanWar({ actorId, targetClanId, action, ...extra });
    assert.equal((await command(2, 20)).code, 'not_authorized');
    assert.equal((await command(1, 10)).code, 'own_clan');
    assert.equal((await command(1, 20, 'declare', { autonomous: true })).code, 'not_autonomous_leader');
    assert.equal((await DB.transitionClanWar({ actorId: 1, targetClanId: 20, action: 'declare' }, () => false)).code, 'actor_changed');
    assert.equal((await DB.fetchClanWars()).length, 0, 'refused transaction has no declaration');
    const first = await command(1, 20);
    assert(first.ok && first.changed && !first.state.mutual);
    assert.equal((await command(1, 20)).changed, false, 'duplicate command is idempotent');
    assert.equal((await command(16, 10, 'declare', { expectedRevision: 0 })).code, 'war_changed');
    const second = await command(16, 10, 'declare', { expectedRevision: first.row.revision });
    assert(second.ok && second.state.mutual);
    await DB.close(); DB.init();
    const restored = new View(); (await DB.fetchClanWars()).forEach(r => restored.accept(r));
    assert(restored.between(10, 20).mutual, 'mutual war survives SQLite reopen');
    const stopped = await command(1, 20, 'withdraw');
    assert(stopped.ok && stopped.state.status === 'incoming');
    assert.equal((await command(1, 20, 'declare', { expectedRevision: second.row.revision })).code, 'war_changed');
    assert((await command(16, 10, 'withdraw')).ok);
    await DB.execute(['UPDATE clans SET allyId=7']);
    assert.equal((await command(1, 20)).code, 'same_alliance');
    await DB.execute(['UPDATE clans SET allyId=0']);
    await DB.execute(['UPDATE characters SET clanId=0 WHERE id=30']);
    await DB.execute(["INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson) VALUES (10,1,'autonomous',?,?,?)", [Date.now(), Date.now(), '{}']]);
    assert.equal((await command(1, 20, 'declare', { autonomous: true })).code, 'clan_members');
    assert.equal((await DB.fetchClanWars()).filter(r => r.active).length, 0);
    assert.equal((await DB.execute(['SELECT COUNT(*) AS n FROM clan_war_events']))[0].n, 4, 'only accepted changes enter history');
    await DB.execute(['UPDATE characters SET clanId=20 WHERE id=30']);
    assert((await command(1, 20)).ok);
    await DB.execute(['DELETE FROM clans WHERE id=20']);
    assert.equal(await DB.reconcileClanWars(), 1);
    assert.equal((await DB.fetchClanWars()).filter(r => r.active).length, 0, 'dissolving a clan releases its declarations and outgoing slots');
    console.log('Clan war rules: eligibility, authority, directed declarations, withdrawal, stale commands, replay and persistence passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await DB.close(); fs.rmSync(dir, { recursive: true, force: true }); });
