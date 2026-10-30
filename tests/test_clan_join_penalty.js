'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-join-penalty');
require('../src/Global');
const Database = invoke('Database');
const Service = invoke('GameServer/Clan/ClanService');
const Rules = invoke('GameServer/Clan/ClanRules');
const Invite = invoke('GameServer/Clan/ClanInviteService');
const ClanManager = invoke('GameServer/World/Generics/NpcBypasses/Clan');
const Response = invoke('GameServer/Network/Response');
const DAY = 86400000;
const query = (sql, args = []) => Database.execute([sql, args]);
function actor(id, clanId, privileges = 0) {
    let penalty = 0;
    return { fetchId: () => id, fetchName: () => `Penalty${id}`, fetchClanId: () => clanId,
        fetchLevel: () => 40, fetchClassId: () => 1, fetchClanCreateExpiryTime: () => 0, isDead: () => false,
        setClanId: value => { clanId = value; }, fetchClanPrivileges: () => privileges,
        setClanPrivileges: value => { privileges = value; }, fetchClanJoinExpiryTime: () => penalty,
        setClanJoinExpiryTime: value => { penalty = value; }, setClanCreateExpiryTime() {}, setTitle() {} };
}
async function run() {
    Database.init();
    assert.equal(Rules.JOIN_COOLDOWN_MS, DAY);
    assert.equal(Service.JOIN_COOLDOWN_MS, DAY);
    await query("INSERT INTO accounts(username,password) VALUES('penalty_player','fixture')");
    for (let id = 1; id <= 6; id++) await query(`INSERT INTO characters
        (id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES(?,'penalty_player',?,1,0,40,500,200,0,0,0,0,0,0,0,?)`, [id, `Penalty${id}`, [1, 2, 6].includes(id) ? 10 : 0]);
    await query("INSERT INTO clans(id,name,leaderId,level) VALUES(10,'PenaltyClan',1,3)");
    await Service.reload();
    const leader = actor(1, 10, Rules.CP_ALL), member = actor(2, 10);
    const before = Date.now();
    assert((await Service.removeMember(member)).ok);
    const after = Date.now();
    const deadline = (await query('SELECT clanJoinExpiryTime FROM characters WHERE id=2'))[0].clanJoinExpiryTime;
    assert(deadline >= before + DAY && deadline <= after + DAY, 'voluntary departure persists exactly 24 real hours');
    assert.equal(member.fetchClanJoinExpiryTime(), deadline, 'the live actor uses the persisted deadline');
    assert.equal(member.fetchClanId(), 0);
    const clanCount = (await query('SELECT COUNT(*) AS count FROM clans'))[0].count;
    const bypass = await Service.create(member, 'CooldownBypass');
    if (bypass.ok) await Service.dissolve(member);
    assert.equal(bypass.code, 'join_cooldown', 'creating and dissolving a temporary clan must not bypass the join penalty');
    assert.equal((await query('SELECT COUNT(*) AS count FROM clans'))[0].count, clanCount,
        'a rejected creation must not persist a temporary clan');
    assert.equal(member.fetchClanId(), 0);
    assert.equal(member.fetchClanJoinExpiryTime(), deadline);
    assert.equal((await query('SELECT clanJoinExpiryTime FROM characters WHERE id=2'))[0].clanJoinExpiryTime, deadline);
    assert.equal(Service.canInvite(leader, member).code, 'target_join_cooldown');
    const originalHtml = Response.npcHtml, pages = [];
    try {
        Response.npcHtml = (_, body) => { pages.push(body); return Buffer.alloc(0); };
        await ClanManager({ actor: member, dataSendToMe() {} }, ['clan', 'create', 'CooldownBypass']);
        assert(pages.some(body => body.includes('24-hour real-time clan penalty expires')),
            'the Clan Manager must explain why creation is blocked');
    } finally { Response.npcHtml = originalHtml; }
    assert((await Service.removeMemberById(Service.findById(10), 6, { force: true })).ok);
    assert((await query('SELECT clanJoinExpiryTime FROM characters WHERE id=6'))[0].clanJoinExpiryTime >= before + DAY,
        'manual expulsion also has a real-time join penalty');
    const actualNow = Date.now;
    try {
        Date.now = () => deadline - DAY;
        const session = { actor: leader, sent: [], dataSendToMe(packet) { this.sent.push(packet); } };
        Invite.notifyRejection(session, 'target_join_cooldown', member);
        assert.equal(session.sent[0].readInt32LE(1), 614, 'custom text replaces the stock five-day wording');
        assert.equal(session.sent[0].toString('ucs2', 13).split('\0')[0],
            'Penalty2 cannot join another clan yet. Penalty remaining: 24h 0m (real time).');
        Date.now = () => deadline - 1;
        assert.equal(Service.canInvite(leader, member).code, 'target_join_cooldown');
        assert.equal(Service.canCreate(member, 'CooldownBypass').code, 'join_cooldown');
        Date.now = () => deadline;
        assert(Service.canInvite(leader, member).ok, 'joining becomes available exactly at the wall-clock deadline');
        assert(Service.canCreate(member, 'CooldownBypass').ok, 'clan creation becomes available at the same deadline');
    } finally { Date.now = actualNow; }
    await Database.close(); Database.init();
    assert.equal((await query('SELECT clanJoinExpiryTime FROM characters WHERE id=2'))[0].clanJoinExpiryTime, deadline,
        'restart does not restart or clear the one-day timer');

    // Recreate a legacy save before migration 83: ordinary five-day penalties
    // plus disciplinary seven-day penalties, one expired and one still active.
    const at = Date.now();
    await query('UPDATE characters SET clanJoinExpiryTime=0');
    await query('UPDATE characters SET clanJoinExpiryTime=? WHERE id=3', [at + 4 * DAY]);
    const relations = [];
    for (const [id, elapsed] of [[4, 2 * DAY], [5, 3 * 3600000]]) {
        const expelledAt = at - elapsed, banUntil = expelledAt + 7 * DAY;
        await query('UPDATE characters SET clanJoinExpiryTime=? WHERE id=?', [banUntil, id]);
        await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,statsJson,updatedAt)
            VALUES(?,'penalty_player',?,'cold','hunting',?,?)`, [id, `Penalty${id}`, JSON.stringify({ clanId: 0,
                clanDiscipline: { clanId: 10, expelledAt, banUntil, reason: 'repeated_aggression' } }), at]);
        relations.push({ kind: 'character', targetId: id, hostility: 12, trust: -6,
            discipline: { stage: 'expelled', stageAt: expelledAt, banUntil } });
    }
    await query('INSERT INTO clan_social_memory(clanId,snapshotJson,updatedAt) VALUES(10,?,?)',
        [JSON.stringify({ clanId: 10, revision: 4, relations }), at]);
    await query('DELETE FROM world_meta WHERE key=\'clanJoinPenaltyVersion\'');
    await query('DELETE FROM schema_migrations WHERE version=83');
    await Database.close(); Database.init();
    const migrated = await query('SELECT id,clanJoinExpiryTime FROM characters WHERE id IN (3,4,5) ORDER BY id');
    assert.deepEqual(migrated.map(row => row.clanJoinExpiryTime), [at, at - DAY, at + 21 * 3600000],
        'upgrade retains time already served and never starts a fresh 24-hour wait');
    const life = await query('SELECT statsJson FROM bot_life_state ORDER BY characterId');
    assert.deepEqual(life.map(row => JSON.parse(row.statsJson).clanDiscipline.banUntil),
        [at - DAY, at + 21 * 3600000], 'bot lifecycle deadlines match character deadlines');
    const memory = JSON.parse((await query('SELECT snapshotJson FROM clan_social_memory WHERE clanId=10'))[0].snapshotJson);
    assert.deepEqual(memory.relations.map(row => row.discipline.banUntil), [at - DAY, at + 21 * 3600000]);
    assert(memory.relations.every(row => row.hostility === 12 && row.trust === -6), 'shortening the timer preserves reputation');
    await Database.close(); Database.init();
    assert.deepEqual(await query('SELECT id,clanJoinExpiryTime FROM characters WHERE id IN (3,4,5) ORDER BY id'), migrated,
        'another restart cannot shorten an already migrated timer again');
    // An early deployment already shortened the timers under version 81.
    // Keep its policy marker while rerunning the newly numbered migration.
    await query(`CREATE TRIGGER bot_party_candidate_payload AFTER UPDATE OF statsJson ON bot_life_state
        BEGIN SELECT 1; END`);
    await query('DELETE FROM schema_migrations WHERE version=83');
    await Database.close(); Database.init();
    assert.deepEqual(await query('SELECT id,clanJoinExpiryTime FROM characters WHERE id IN (3,4,5) ORDER BY id'), migrated,
        'renumbering the migration must not shorten an existing one-day penalty again');
    assert.equal((await query(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'
        AND name IN ('bot_party_candidate_payload','bot_party_candidate_identity')`))[0].count, 0,
        'worlds that used version 81 for cooldowns also receive the projection-trigger upgrade');
    console.log('Clan departure, expulsion, real-time expiry, messages and legacy penalty migration passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
});
