const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const ClanRules = invoke('GameServer/Clan/ClanRules');
const ClanService = invoke('GameServer/Clan/ClanService');
const RequestJoinPledge = invoke('GameServer/Network/Request/RequestJoinPledge');
const RequestOustPledgeMember = invoke('GameServer/Network/Request/RequestOustPledgeMember');
const RequestGiveNickName = invoke('GameServer/Network/Request/RequestGiveNickName');
const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

class PlayerSession {
    constructor(actor) {
        this.actor = actor;
        this.accountId = `player_${actor.fetchId()}`;
        this.sent = [];
        actor.session = this;
    }

    dataSendToMe(packet) {
        this.sent.push(packet);
    }

    dataSendToOthers() {
    }
}

class BotSession {
    constructor(actor) {
        this.actor = actor;
        this.accountId = `bot_${actor.fetchId()}`;
        this.sent = [];
        actor.session = this;
    }

    dataSendToMe(packet) {
        this.sent.push(packet);
    }

    dataSendToOthers() {
    }
}

function fakeActor(id, name, options = {}) {
    let clanId = Number(options.clanId || 0);
    let privileges = Number(options.clanPrivileges || 0);
    let title = String(options.title || '');
    let clanJoinExpiryTime = Number(options.clanJoinExpiryTime || 0);
    let clanCreateExpiryTime = Number(options.clanCreateExpiryTime || 0);

    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => Number(options.level || 20),
        fetchClassId: () => Number(options.classId || 10),
        fetchClanId: () => clanId,
        setClanId: (value) => { clanId = Number(value) || 0; },
        fetchClanPrivileges: () => privileges,
        setClanPrivileges: (value) => { privileges = Number(value) || 0; },
        fetchIsOnline: () => true,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchKarma: () => 0,
        fetchPvpFlag: () => 0,
        fetchTitle: () => title,
        setTitle: (value) => { title = String(value || ''); },
        fetchClanJoinExpiryTime: () => clanJoinExpiryTime,
        setClanJoinExpiryTime: (value) => { clanJoinExpiryTime = Number(value) || 0; },
        fetchClanCreateExpiryTime: () => clanCreateExpiryTime,
        setClanCreateExpiryTime: (value) => { clanCreateExpiryTime = Number(value) || 0; }
    };
}

(async () => {
    const clan = {
        id: 6000001,
        name: 'Nocturne',
        level: 2,
        leaderId: 2000001,
        crestId: 0,
        crestLargeId: 0,
        allyId: 0,
        allyName: '',
        allyCrestId: 0,
        charPenaltyExpiryTime: 0,
        members: [
            { id: 2000001, name: 'Leader', level: 40, classId: 10, clanId: 6000001, clanPrivileges: ClanRules.CP_ALL }
        ]
    };

    const leader = fakeActor(2000001, 'Leader', { clanId: clan.id, clanPrivileges: ClanRules.CP_ALL, level: 40 });
    const bot = fakeActor(2000002, 'MinaBot', { level: 22, classId: 11 });
    const leaderSession = new PlayerSession(leader);
    const botSession = new BotSession(bot);

    const originalWorldSessions = World.user?.sessions;
    const originalFindById = ClanService.findById;
    const originalCanInvite = ClanService.canInvite;
    const originalAddMember = ClanService.addMember;
    const originalOnlineSessions = ClanService.onlineSessions;
    const originalBotTell = BotManager.botTell;
    let botTellText = null;

    try {
        World.user = { sessions: [leaderSession, botSession] };
        ClanService.findById = (id) => (Number(id) === Number(clan.id) ? clan : null);
        ClanService.canInvite = (requestor, target) => (
            requestor === leader && target === bot
                ? { ok: true, clan }
                : { ok: false, code: 'unexpected_invite' }
        );
        ClanService.addMember = (targetClan, actor, privileges) => {
            assert.strictEqual(targetClan, clan);
            assert.strictEqual(actor, bot);
            assert.strictEqual(privileges, 0);
            actor.setClanId(clan.id);
            actor.setClanPrivileges(privileges);
            const member = { id: actor.fetchId(), name: actor.fetchName(), level: actor.fetchLevel(), classId: actor.fetchClassId(), clanId: clan.id, clanPrivileges: privileges };
            clan.members.push(member);
            return Promise.resolve({ ok: true, clan, member });
        };
        ClanService.onlineSessions = () => [leaderSession, botSession];
        BotManager.botTell = (sourceSession, targetSession, text) => {
            assert.strictEqual(sourceSession, botSession);
            assert.strictEqual(targetSession, leaderSession);
            botTellText = text;
        };

        const result = await RequestJoinPledge.consume(leaderSession, { targetId: bot.fetchId() });

        assert.strictEqual(result.ok, true, 'bot should accept clan invite');
        assert.strictEqual(bot.fetchClanId(), clan.id, 'bot actor should join invited clan');
        assert.strictEqual(botSession.pendingClanInvite, null, 'bot invite should be consumed');
        assert.ok(leaderSession.sent.some((packet) => packet[0] === 0x55), 'leader should receive PledgeShowMemberListAdd');
        assert.strictEqual(botTellText, `I'll join Nocturne.`, 'bot should acknowledge the clan invite to the player');
    } finally {
        World.user = { sessions: originalWorldSessions || [] };
        ClanService.findById = originalFindById;
        ClanService.canInvite = originalCanInvite;
        ClanService.addMember = originalAddMember;
        ClanService.onlineSessions = originalOnlineSessions;
        BotManager.botTell = originalBotTell;
    }

    // Lisvus CheckClanJoinCondition sends CLAN_IS_FULL (233) to the inviter,
    // both when inviting and when rechecking the accepted invitation.
    {
        const RequestAnswerJoinPledge = invoke('GameServer/Network/Request/RequestAnswerJoinPledge');
        const fullClan = { ...clan };
        const inviterSession = new PlayerSession(leader);
        const playerSession = new PlayerSession(fakeActor(2000020, 'Candidate'));
        const candidateBotSession = new BotSession(fakeActor(2000021, 'CandidateBot'));
        const fullMessage = Buffer.alloc(16); // Native packet padding, no message arguments.
        fullMessage[0] = 0x64;
        fullMessage.writeInt32LE(233, 1);
        let added = 0;
        try {
            World.user = { sessions: [inviterSession, playerSession, candidateBotSession] };
            ClanService.findById = (id) => (Number(id) === Number(clan.id) ? fullClan : null);
            ClanService.addMember = () => { added += 1; return Promise.resolve({ ok: false }); };

            for (const [level, limit] of [[0, 10], [1, 15], [2, 20], [3, 30], [4, 40], [5, 40]]) {
                fullClan.level = level;
                fullClan.members = Array.from({ length: limit }, (_, index) => ({ id: 2000100 + index }));
                for (const candidate of [playerSession, candidateBotSession]) {
                    inviterSession.sent = [];
                    await RequestJoinPledge.consume(inviterSession, { targetId: candidate.actor.fetchId() });
                    assert.deepStrictEqual(inviterSession.sent, [fullMessage, ServerResponse.actionFailed()],
                        `a full level ${level} clan should report CLAN_IS_FULL to the inviter`);
                    assert.deepStrictEqual(candidate.sent, [], 'a full clan must not send an invitation');
                    assert.ok(!candidate.pendingClanInvite, 'a rejected invitation must not become pending');
                    assert.strictEqual(candidate.actor.fetchClanId(), 0, 'the candidate must remain clanless');
                }
            }

            // There is room at request time, but another member joins before the answer.
            fullClan.members.pop();
            inviterSession.sent = [];
            RequestJoinPledge.consume(inviterSession, { targetId: playerSession.actor.fetchId() });
            assert.ok(playerSession.pendingClanInvite, 'the last free slot should allow an invitation');
            assert.strictEqual(playerSession.sent[0][0], 0x32, 'the candidate should receive AskJoinPledge');
            fullClan.members.push({ id: 2000200 });
            playerSession.sent = [];
            const result = await RequestAnswerJoinPledge.consume(playerSession, { answer: 1 });
            assert.strictEqual(result.code, 'clan_full');
            assert.deepStrictEqual(inviterSession.sent, [fullMessage], 'the inviter should learn why joining failed');
            assert.deepStrictEqual(playerSession.sent, [ServerResponse.actionFailed()]);
            assert.strictEqual(playerSession.pendingClanInvite, null, 'the rejected answer should consume the invitation');
            assert.strictEqual(playerSession.actor.fetchClanId(), 0);
            assert.strictEqual(added, 0, 'a full clan must never attempt to persist another member');

            // A clanless target can still have a join penalty. Report its real
            // remaining time before CLAN_IS_FULL instead of the stock five days.
            playerSession.actor.setClanJoinExpiryTime(Date.now() + 86400000);
            for (const stage of ['request', 'answer']) {
                inviterSession.sent = [];
                playerSession.sent = [];
                if (stage === 'request') {
                    const packet = Buffer.alloc(5);
                    packet[0] = 0x24;
                    packet.writeInt32LE(playerSession.actor.fetchId(), 1);
                    RequestJoinPledge(inviterSession, packet);
                } else {
                    playerSession.pendingClanInvite = { requestorSession: inviterSession,
                        invitedActor: playerSession.actor, clanId: fullClan.id };
                    const rejected = await RequestAnswerJoinPledge.consume(playerSession, { answer: 1 });
                    assert.strictEqual(rejected.code, 'target_join_cooldown');
                }
                const message = inviterSession.sent[0];
                assert.strictEqual(message[0], 0x64);
                assert.strictEqual(message.readInt32LE(1), 614, `${stage}: the leader should see the actual remaining penalty`);
                assert.strictEqual(message.readInt32LE(5), 1, 'the native message requires one argument');
                assert.strictEqual(message.readInt32LE(9), 0, 'the argument must be TYPE_TEXT');
                assert.strictEqual(message.toString('ucs2', 13).split('\0')[0],
                    'Candidate cannot join another clan yet. Penalty remaining: 24h 0m (real time).');
                assert.strictEqual(playerSession.pendingClanInvite, null);
                assert.strictEqual(added, 0);
            }
        } finally {
            World.user = { sessions: originalWorldSessions || [] };
            ClanService.findById = originalFindById;
            ClanService.addMember = originalAddMember;
        }
    }

    // E255: the invite belongs to the invited character, not to the connection.
    // After Restart and another character, an answer must not join that character.
    {
        const RequestAnswerJoinPledge = invoke('GameServer/Network/Request/RequestAnswerJoinPledge');
        const invitedPlayer = fakeActor(2000003, 'Invited', { level: 22 });
        const replacement = fakeActor(2000004, 'Replacement', { level: 22 });
        const inviterSession = new PlayerSession(leader);
        const invitedSession = new PlayerSession(invitedPlayer);
        let added = 0;
        try {
            World.user = { sessions: [inviterSession, invitedSession] };
            ClanService.findById = (id) => (Number(id) === Number(clan.id) ? clan : null);
            ClanService.canInvite = (requestor, target) => (
                requestor === leader && (target === invitedPlayer || target === replacement)
                    ? { ok: true, clan }
                    : { ok: false, code: 'unexpected_invite' }
            );
            ClanService.addMember = () => { added += 1; return Promise.resolve({ ok: true, clan, member: {} }); };
            ClanService.onlineSessions = () => [];

            RequestJoinPledge.consume(inviterSession, { targetId: invitedPlayer.fetchId() });
            assert.ok(invitedSession.pendingClanInvite, 'player target should get a pending invite');
            invitedSession.actor = replacement;
            const answer = await RequestAnswerJoinPledge.consume(invitedSession, { answer: 1 });
            assert.strictEqual(answer.code, 'missing_invite', 'an answer from another character is refused like an expired invite');
            assert.strictEqual(added, 0, 'the replacement character must not join the clan');
            assert.strictEqual(invitedSession.pendingClanInvite, null, 'the stale invite is consumed');

            // E256: the join write is held; meanwhile the connection selects another
            // character. The write stays the invited character's; the session gets no join UI.
            invitedSession.actor = invitedPlayer;
            let releaseJoin;
            const joined = [];
            ClanService.addMember = (_clan, actor) => new Promise((resolve) => {
                joined.push(actor.fetchId());
                releaseJoin = () => resolve({ ok: true, clan, member: { id: actor.fetchId() } });
            });
            RequestJoinPledge.consume(inviterSession, { targetId: invitedPlayer.fetchId() });
            invitedSession.sent = [];
            const pending = RequestAnswerJoinPledge.consume(invitedSession, { answer: 1 });
            invitedSession.actor = replacement;
            releaseJoin();
            const heldAnswer = await pending;
            assert.strictEqual(heldAnswer.ok, true, 'the invited character joined');
            assert.deepStrictEqual(joined, [invitedPlayer.fetchId()], 'the write is for the invited character');
            assert.deepStrictEqual(invitedSession.sent, [], 'no join UI reaches the session of another character');
        } finally {
            World.user = { sessions: originalWorldSessions || [] };
            ClanService.findById = originalFindById;
            ClanService.canInvite = originalCanInvite;
            ClanService.addMember = originalAddMember;
            ClanService.onlineSessions = originalOnlineSessions;
        }
    }

    const originalFetchClans = Database.fetchClans;
    const originalFetchClanCharacters = Database.fetchClanCharacters;
    const originalUpdateCharacterTitle = Database.updateCharacterTitle;
    const originalIsAutonomousBotMember = Database.isAutonomousBotMember;
    const originalRemoveCharacterFromClan = Database.removeCharacterFromClan;
    const originalDissolveClan = Database.dissolveClan;
    const originalUserInfo = ServerResponse.userInfo;
    const originalCharInfo = ServerResponse.charInfo;
    const originalRelationChanged = ServerResponse.relationChanged;
    const managedClanRow = {
        id: 6000010,
        name: 'Wardens',
        level: 3,
        leaderId: 2000010,
        crestId: 0,
        crestLargeId: 0,
        allyId: 0,
        allyName: '',
        allyCrestId: 0,
        charPenaltyExpiryTime: 0
    };
    const managedMembers = [
        { id: 2000010, name: 'Warden', title: 'Chief', level: 40, classId: 10, clanId: 6000010, clanPrivileges: ClanRules.CP_ALL, isOnline: 1 },
        { id: 2000011, name: 'ColdMina', title: 'Scout', level: 22, classId: 11, clanId: 6000010, clanPrivileges: 0, isOnline: 0 }
    ];

    try {
        Database.fetchClans = () => Promise.resolve([managedClanRow]);
        Database.fetchClanCharacters = () => Promise.resolve(managedMembers);
        await ClanService.reload();

        const managedClan = ClanService.findById(managedClanRow.id);
        const warden = fakeActor(2000010, 'Warden', {
            clanId: managedClan.id,
            clanPrivileges: ClanRules.CP_ALL,
            level: 40,
            title: 'Chief'
        });
        const hotMina = fakeActor(2000011, 'ColdMina', {
            clanId: managedClan.id,
            level: 22,
            title: 'Scout'
        });
        const wardenSession = new PlayerSession(warden);
        const hotMinaSession = new BotSession(hotMina);
        World.user = { sessions: [wardenSession, hotMinaSession] };

        let titleWrite = null;
        Database.updateCharacterTitle = (id, title) => {
            titleWrite = { id, title };
            return Promise.resolve({ affectedRows: 1 });
        };
        const titleResult = await ClanService.setMemberTitle(warden, hotMina, 'Guardian');
        assert.strictEqual(titleResult.ok, true, 'authorized level 3 clan member title should be accepted');
        assert.deepStrictEqual(titleWrite, { id: 2000011, title: 'Guardian' }, 'title should be persisted for players and hot bots');
        assert.strictEqual(hotMina.fetchTitle(), 'Guardian', 'hot actor title should refresh immediately');

        let titleBroadcasts = 0;
        hotMinaSession.dataSendToOthers = () => { titleBroadcasts += 1; };
        ServerResponse.userInfo = () => Buffer.from([0x04]);
        ServerResponse.charInfo = () => Buffer.from([0x03]);
        ServerResponse.relationChanged = () => Buffer.from([0xce]);
        const titleRequestResult = await RequestGiveNickName.consume(wardenSession, { name: 'ColdMina', title: 'Vanguard' });
        assert.strictEqual(titleRequestResult.ok, true, 'RequestGiveNickName should update an online bot clan member');
        assert.strictEqual(hotMina.fetchTitle(), 'Vanguard');
        assert.strictEqual(titleBroadcasts, 2, 'title change should broadcast CharInfo and RelationChanged');

        World.user = { sessions: [wardenSession] };
        let removedId = 0;
        Database.isAutonomousBotMember = () => Promise.resolve(false);
        Database.removeCharacterFromClan = (id) => {
            removedId = Number(id);
            return Promise.resolve({ affectedRows: 1 });
        };
        const coldOustResult = await RequestOustPledgeMember.consume(wardenSession, { name: 'ColdMina' });
        assert.strictEqual(coldOustResult.ok, true, 'clan leader should be able to oust a cold bot without a hot session');
        assert.strictEqual(removedId, 2000011, 'cold member removal should target the persisted character id');
        assert.strictEqual(managedClan.members.some((member) => member.id === 2000011), false, 'cold member should be removed from clan cache');

        Database.fetchClanCharacters = () => Promise.resolve(managedMembers);
        await ClanService.reload();
        const dissolveClan = ClanService.findById(managedClanRow.id);
        const dissolvingLeader = fakeActor(2000010, 'Warden', {
            clanId: dissolveClan.id,
            clanPrivileges: ClanRules.CP_ALL,
            title: 'Chief',
            clanJoinExpiryTime: 123,
            clanCreateExpiryTime: 456
        });
        const dissolvingBot = fakeActor(2000011, 'ColdMina', {
            clanId: dissolveClan.id,
            title: 'Scout',
            clanJoinExpiryTime: 789,
            clanCreateExpiryTime: 987
        });
        World.user = { sessions: [new PlayerSession(dissolvingLeader), new BotSession(dissolvingBot)] };
        let dissolveWrite = null;
        Database.dissolveClan = (data) => {
            dissolveWrite = data;
            return Promise.resolve({ ok: true, memberIds: [2000010, 2000011] });
        };

        const dissolveResult = await ClanService.dissolve(dissolvingLeader);
        assert.strictEqual(dissolveResult.ok, true, 'leader should dissolve the clan immediately');
        assert.deepStrictEqual(dissolveWrite, { clanId: 6000010, leaderId: 2000010 });
        assert.strictEqual(ClanService.findById(6000010), null, 'dissolved clan should leave the runtime cache');
        [dissolvingLeader, dissolvingBot].forEach((actor) => {
            assert.strictEqual(actor.fetchClanId(), 0, 'dissolve should clear hot player and bot clan ids');
            assert.strictEqual(actor.fetchTitle(), '', 'dissolve should clear clan titles');
            assert.strictEqual(actor.fetchClanJoinExpiryTime(), 0, 'dissolve should not apply a join penalty');
            assert.strictEqual(actor.fetchClanCreateExpiryTime(), 0, 'dissolve should not apply a create penalty');
        });

        // E265: the dissolve write is held while a member connection selects a
        // character of another clan. Only the dissolved clan's characters are cleared.
        Database.fetchClanCharacters = () => Promise.resolve(managedMembers);
        await ClanService.reload();
        const heldClan = ClanService.findById(managedClanRow.id);
        const heldLeader = fakeActor(2000010, 'Warden', { clanId: heldClan.id, clanPrivileges: ClanRules.CP_ALL, title: 'Chief' });
        const heldMember = fakeActor(2000011, 'ColdMina', { clanId: heldClan.id, title: 'Scout' });
        const otherClanActor = fakeActor(2000012, 'Captain', { clanId: 6000008, clanPrivileges: 2047, title: 'Captain' });
        const heldLeaderSession = new PlayerSession(heldLeader);
        const heldMemberSession = new PlayerSession(heldMember);
        World.user = { sessions: [heldLeaderSession, heldMemberSession] };
        let releaseDissolve;
        Database.dissolveClan = () => new Promise((resolve) => {
            releaseDissolve = () => resolve({ ok: true, memberIds: [2000010, 2000011] });
        });
        const heldDissolve = ClanService.dissolve(heldLeader);
        heldMemberSession.actor = otherClanActor;
        releaseDissolve();
        const heldResult = await heldDissolve;
        assert.strictEqual(heldResult.ok, true);
        assert.strictEqual(otherClanActor.fetchClanId(), 6000008, 'the other character keeps its clan');
        assert.strictEqual(otherClanActor.fetchTitle(), 'Captain', 'the other character keeps its title');
        assert.strictEqual(otherClanActor.fetchClanPrivileges(), 2047, 'the other character keeps its privileges');
        assert.strictEqual(heldMember.fetchClanId(), 0, 'the dissolved clan member is cleared');
        assert.strictEqual(heldLeader.fetchClanId(), 0, 'the leader is cleared');
        assert.deepStrictEqual(heldResult.sessions, [heldLeaderSession], 'dissolve UI goes only to sessions still on a dissolved member');

        // E265: the member connection switches to an alt of the SAME clan during
        // the write; the alt is a member of the dissolved clan and is cleared too.
        Database.fetchClanCharacters = () => Promise.resolve(managedMembers);
        await ClanService.reload();
        const altClan = ClanService.findById(managedClanRow.id);
        const altLeader = fakeActor(2000010, 'Warden', { clanId: altClan.id, clanPrivileges: ClanRules.CP_ALL, title: 'Chief' });
        const altFirst = fakeActor(2000011, 'ColdMina', { clanId: altClan.id, title: 'Scout' });
        const altSecond = fakeActor(2000013, 'MinaAlt', { clanId: altClan.id, clanPrivileges: 8, title: 'Alt' });
        const altLeaderSession = new PlayerSession(altLeader);
        const altMemberSession = new PlayerSession(altFirst);
        World.user = { sessions: [altLeaderSession, altMemberSession] };
        let releaseAlt;
        Database.dissolveClan = () => new Promise((resolve) => {
            releaseAlt = () => resolve({ ok: true, memberIds: [2000010, 2000011, 2000013] });
        });
        const altDissolve = ClanService.dissolve(altLeader);
        altMemberSession.actor = altSecond;
        releaseAlt();
        const altResult = await altDissolve;
        assert.strictEqual(altSecond.fetchClanId(), 0, 'an alt of the dissolved clan selected during the write is cleared');
        assert.strictEqual(altSecond.fetchTitle(), '', 'the alt loses the clan title');
        assert.strictEqual(altSecond.fetchClanPrivileges(), 0, 'the alt loses the clan privileges');
        assert.strictEqual(altFirst.fetchClanId(), 0, 'the remembered member is cleared');
        assert.deepStrictEqual(altResult.sessions, [altLeaderSession, altMemberSession], 'the alt session gets the dissolve UI');
    } finally {
        Database.fetchClans = originalFetchClans;
        Database.fetchClanCharacters = originalFetchClanCharacters;
        Database.updateCharacterTitle = originalUpdateCharacterTitle;
        Database.isAutonomousBotMember = originalIsAutonomousBotMember;
        Database.removeCharacterFromClan = originalRemoveCharacterFromClan;
        Database.dissolveClan = originalDissolveClan;
        ServerResponse.userInfo = originalUserInfo;
        ServerResponse.charInfo = originalCharInfo;
        ServerResponse.relationChanged = originalRelationChanged;
        World.user = { sessions: originalWorldSessions || [] };
    }

    const rootDir = path.resolve(__dirname, '..');
    const databasePath = path.join(rootDir, 'tmp', 'test-clan-member-management.sqlite');
    const removeDatabaseFiles = () => {
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    };
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('clan_management', 'secret');
    const insertCharacter = seed.prepare(`INSERT INTO characters
        (id, username, name, title, classId, race, maxHp, maxMp, sex, face, hair, hairColor,
         clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime, locX, locY, locZ)
        VALUES (?, 'clan_management', ?, ?, 10, 0, 50, 25, 0, 0, 0, 0, 6000099, ?, ?, ?, 0, 0, 0)`);
    insertCharacter.run(2000091, 'SqlLeader', 'Chief', ClanRules.CP_ALL, 111, 222);
    insertCharacter.run(2000092, 'SqlColdBot', 'Scout', 0, 333, 444);
    seed.prepare('INSERT INTO clans(id, name, leaderId, level) VALUES (6000099, ?, 2000091, 3)').run('SqlWardens');
    seed.prepare("INSERT INTO clan_actions(clanId, actionKey, actionType) VALUES (6000099, 'dissolve-test', 'goal_plan')").run();
    seed.prepare("INSERT INTO clan_crests(clanId, kind, data) VALUES (6000099, 'pledge', ?)").run(Buffer.from([1, 2, 3]));
    seed.close();

    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    try {
        const rejected = await Database.dissolveClan({ clanId: 6000099, leaderId: 2000092 });
        assert.deepStrictEqual(rejected, { ok: false, code: 'not_leader' }, 'database dissolve should verify the leader atomically');

        const dissolved = await Database.dissolveClan({ clanId: 6000099, leaderId: 2000091 });
        assert.deepStrictEqual(dissolved, { ok: true, clanId: 6000099, memberIds: [2000091, 2000092] });
        const rows = await Database.execute([`SELECT id, clanId, clanPrivileges, clanJoinExpiryTime,
            clanCreateExpiryTime, title FROM characters ORDER BY id`, []]);
        rows.forEach((row) => {
            assert.strictEqual(Number(row.clanId), 0);
            assert.strictEqual(Number(row.clanPrivileges), 0);
            assert.strictEqual(Number(row.clanJoinExpiryTime), 0, 'database dissolve should not write a join penalty');
            assert.strictEqual(Number(row.clanCreateExpiryTime), 0, 'database dissolve should not write a create penalty');
            assert.strictEqual(row.title, '', 'database dissolve should clear persisted clan titles');
        });
        const remnants = await Database.execute([`SELECT
            (SELECT COUNT(*) FROM clans WHERE id = 6000099) AS clans,
            (SELECT COUNT(*) FROM clan_actions WHERE clanId = 6000099) AS actions,
            (SELECT COUNT(*) FROM clan_crests WHERE clanId = 6000099) AS crests`, []]);
        assert.deepStrictEqual(remnants[0], { clans: 0, actions: 0, crests: 0 }, 'dissolve should cascade clan-owned data');
    } finally {
        await Database.close();
        removeDatabaseFiles();
    }

    console.log('Clan bot invite and member management checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
