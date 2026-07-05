const assert = require('assert');

require('../src/Global');

const ClanRules = invoke('GameServer/Clan/ClanRules');
const ClanService = invoke('GameServer/Clan/ClanService');
const RequestJoinPledge = invoke('GameServer/Network/Request/RequestJoinPledge');
const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');

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
        fetchTitle: () => ''
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

    console.log('Clan bot invite checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
