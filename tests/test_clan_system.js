const assert = require('assert');

require('../src/Global');

const ClanRules = invoke('GameServer/Clan/ClanRules');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');
const GameOpcodes = invoke('GameServer/Network/Opcodes');
const GameRequest = invoke('GameServer/Network/Request');
const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');

function findUtf16Terminator(buffer, offset) {
    for (let i = offset; i + 1 < buffer.length; i += 2) {
        if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
            return i;
        }
    }
    return -1;
}

assert.deepStrictEqual(ClanRules.validateClanName('A'), { ok: false, code: 'name_too_short' });
assert.deepStrictEqual(ClanRules.validateClanName('TooLongClanName17'), { ok: false, code: 'name_too_long' });
assert.deepStrictEqual(ClanRules.validateClanName('Bad Name'), { ok: false, code: 'name_invalid' });
assert.deepStrictEqual(ClanRules.validateClanName('Nocturne'), { ok: true, name: 'Nocturne' });

assert.strictEqual(ClanRules.memberLimit(0), 10);
assert.strictEqual(ClanRules.memberLimit(1), 15);
assert.strictEqual(ClanRules.memberLimit(2), 20);
assert.strictEqual(ClanRules.memberLimit(3), 30);
assert.strictEqual(ClanRules.memberLimit(4), 40);

assert.deepStrictEqual(ClanRules.LEVEL_REQUIREMENTS[0], { nextLevel: 1, sp: 30000, adena: 650000 });
assert.strictEqual(ClanRules.LEVEL_REQUIREMENTS[2].itemId, 1419, 'Clan level 3 should require Proof of Blood');
assert.strictEqual(ClanRules.LEVEL_REQUIREMENTS[3].itemId, 3874, 'Clan level 4 should require Proof of Alliance');
assert.strictEqual(ClanRules.LEVEL_REQUIREMENTS[4].itemId, 3870, 'Clan level 5 should require Proof of Aspiration');

assert.strictEqual(GameOpcodes.table[0x24], GameRequest.requestJoinPledge, 'C4 RequestJoinPledge opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x25], GameRequest.requestAnswerJoinPledge, 'C4 RequestAnswerJoinPledge opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x26], GameRequest.requestWithdrawalPledge, 'C4 RequestWithdrawalPledge opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x27], GameRequest.requestOustPledgeMember, 'C4 RequestOustPledgeMember opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x3c], GameRequest.requestPledgeMemberList, 'C4 RequestPledgeMemberList opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x53], GameRequest.requestSetPledgeCrest, 'C4 RequestSetPledgeCrest opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x66], GameRequest.requestPledgeInfo, 'C4 RequestPledgeInfo opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x68], GameRequest.requestPledgeCrest, 'C4 RequestPledgeCrest opcode should be wired');
assert.strictEqual(GameOpcodes.table[0xc0], GameRequest.requestPledgePower, 'C4 RequestPledgePower opcode should be wired');

const originalPledgeInfoUpdate = ServerResponse.pledgeShowInfoUpdate;
const originalPledgeAllResponse = ServerResponse.pledgeShowMemberListAll;
const pledgeRequestPackets = [];
ServerResponse.pledgeShowInfoUpdate = (targetClan) => {
    pledgeRequestPackets.push(['info', targetClan.id]);
    return originalPledgeInfoUpdate(targetClan);
};
ServerResponse.pledgeShowMemberListAll = (targetClan, targetActor) => {
    pledgeRequestPackets.push(['all', targetClan.id, targetActor.fetchId()]);
    return originalPledgeAllResponse(targetClan, targetActor);
};

const joinPledgeRequest = Buffer.concat([
    Buffer.from([0x24]),
    Buffer.from([0x78, 0x56, 0x34, 0x12])
]);
const joinPledgePacket = new ReceivePacket(joinPledgeRequest);
joinPledgePacket.readD();
assert.strictEqual(joinPledgePacket.data[0], 0x12345678, 'RequestJoinPledge should read target object id');

const oustPledgeRequest = Buffer.concat([
    Buffer.from([0x27]),
    Buffer.from('Mina', 'ucs2'),
    Buffer.alloc(2)
]);
const oustPledgePacket = new ReceivePacket(oustPledgeRequest);
oustPledgePacket.readS();
assert.strictEqual(oustPledgePacket.data[0], 'Mina', 'RequestOustPledgeMember should read target name');

const askJoinPledge = ServerResponse.askJoinPledge(2000001, 'Nocturne');
assert.strictEqual(askJoinPledge[0], 0x32);
assert.strictEqual(askJoinPledge.readInt32LE(1), 2000001);
const askClanNameEnd = findUtf16Terminator(askJoinPledge, 5);
assert.strictEqual(askJoinPledge.toString('ucs2', 5, askClanNameEnd), 'Nocturne');

const joinPledge = ServerResponse.joinPledge(6000001);
assert.strictEqual(joinPledge[0], 0x33);
assert.strictEqual(joinPledge.readInt32LE(1), 6000001);

const managePledgePower = ServerResponse.managePledgePower(ClanRules.CP_ALL);
assert.strictEqual(managePledgePower[0], 0x30);
assert.strictEqual(managePledgePower.readInt32LE(9), ClanRules.CP_ALL);

const clan = {
    id: 6000001,
    name: 'Nocturne',
    level: 2,
    leaderId: 2000001,
    crestId: 12,
    crestLargeId: 34,
    allyId: 0,
    allyName: '',
    allyCrestId: 0,
    dissolvingExpiryTime: 0,
    members: [
        { id: 2000001, name: 'Leader', level: 40, classId: 10 },
        { id: 2000002, name: 'Mina', level: 22, classId: 11 }
    ]
};
const activeActor = {
    fetchId: () => 2000001,
    fetchName: () => 'Leader',
    fetchLevel: () => 40,
    fetchClanId: () => 6000001
};

const originalClanForActor = ClanService.clanForActor;
const originalRefreshOnlineMembers = ClanService.refreshOnlineMembers;
pledgeRequestPackets.length = 0;
ClanService.clanForActor = () => clan;
ClanService.refreshOnlineMembers = (targetClan) => targetClan;
const pledgeRequestSession = {
    actor: activeActor,
    sent: [],
    dataSendToMe(packet) {
        this.sent.push(packet);
    }
};
GameRequest.requestPledgeMemberList(pledgeRequestSession);
assert.deepStrictEqual(
    pledgeRequestPackets,
    [['info', 6000001], ['all', 6000001, 2000001]],
    'RequestPledgeMemberList should refresh clan info and full member list'
);
assert.deepStrictEqual(
    pledgeRequestSession.sent.map((packet) => packet[0]),
    [0x88, 0x53],
    'RequestPledgeMemberList should send PledgeShowInfoUpdate before PledgeShowMemberListAll'
);
ClanService.clanForActor = originalClanForActor;
ClanService.refreshOnlineMembers = originalRefreshOnlineMembers;

const pledgeInfo = ServerResponse.pledgeShowInfoUpdate(clan);
assert.strictEqual(pledgeInfo[0], 0x88);
assert.strictEqual(pledgeInfo.readInt32LE(1), 6000001);
assert.strictEqual(pledgeInfo.readInt32LE(9), 2, 'PledgeShowInfoUpdate should include clan level');

const pledgeInfoTarget = ServerResponse.pledgeInfo(clan);
assert.strictEqual(pledgeInfoTarget[0], 0x83);
assert.strictEqual(pledgeInfoTarget.readInt32LE(1), 6000001);
const pledgeInfoNameEnd = findUtf16Terminator(pledgeInfoTarget, 5);
assert.strictEqual(pledgeInfoTarget.toString('ucs2', 5, pledgeInfoNameEnd), 'Nocturne');

const crestPayload = Buffer.from([0x42, 0x4d, 0x01, 0x02]);
const pledgeCrest = ServerResponse.pledgeCrest(12, crestPayload);
assert.strictEqual(pledgeCrest[0], 0x6c);
assert.strictEqual(pledgeCrest.readInt32LE(1), 12);
assert.strictEqual(pledgeCrest.readInt32LE(5), crestPayload.length);
assert.deepStrictEqual(pledgeCrest.slice(9, 9 + crestPayload.length), crestPayload);

const originalWorldSessions = World.user?.sessions;
World.user = {
    sessions: [{
        actor: {
            fetchId: () => 2000002,
            fetchName: () => 'Mina',
            fetchLevel: () => 25,
            fetchClassId: () => 11,
            fetchClanId: () => 6000001,
            fetchClanPrivileges: () => 0,
            fetchIsOnline: () => true
        }
    }]
};

const pledgeAll = ServerResponse.pledgeShowMemberListAll(ClanService.refreshOnlineMembers(clan), activeActor);
World.user = { sessions: originalWorldSessions || [] };
assert.strictEqual(pledgeAll[0], 0x53);
assert.strictEqual(pledgeAll.readInt32LE(1), 6000001);
const clanNameEnd = findUtf16Terminator(pledgeAll, 5);
assert.strictEqual(pledgeAll.toString('ucs2', 5, clanNameEnd), 'Nocturne');
const leaderNameOffset = clanNameEnd + 2;
const leaderNameEnd = findUtf16Terminator(pledgeAll, leaderNameOffset);
assert.strictEqual(pledgeAll.toString('ucs2', leaderNameOffset, leaderNameEnd), 'Leader');
const memberCountOffset = leaderNameEnd + 2 + (4 * 9) + 2 + (4 * 2);
assert.strictEqual(pledgeAll.readInt32LE(memberCountOffset), 1, 'PledgeShowMemberListAll should skip the active actor');
const memberNameOffset = memberCountOffset + 4;
const memberNameEnd = findUtf16Terminator(pledgeAll, memberNameOffset);
assert.strictEqual(pledgeAll.toString('ucs2', memberNameOffset, memberNameEnd), 'Mina');
assert.strictEqual(pledgeAll.readInt32LE(memberNameEnd + 2), 25, 'PledgeShowMemberListAll should use live online member level');

const pledgeAdd = ServerResponse.pledgeShowMemberListAdd(clan.members[1]);
assert.strictEqual(pledgeAdd[0], 0x55);
const addNameEnd = findUtf16Terminator(pledgeAdd, 1);
assert.strictEqual(pledgeAdd.toString('ucs2', 1, addNameEnd), 'Mina');

const pledgeUpdate = ServerResponse.pledgeShowMemberListUpdate({ id: 2000002, name: 'Mina', level: 23, classId: 11 });
assert.strictEqual(pledgeUpdate[0], 0x54);
const updateNameEnd = findUtf16Terminator(pledgeUpdate, 1);
assert.strictEqual(pledgeUpdate.toString('ucs2', 1, updateNameEnd), 'Mina');
assert.strictEqual(pledgeUpdate.readInt32LE(updateNameEnd + 2), 23);

const pledgeDelete = ServerResponse.pledgeShowMemberListDelete('Mina');
assert.strictEqual(pledgeDelete[0], 0x56);
const deleteNameEnd = findUtf16Terminator(pledgeDelete, 1);
assert.strictEqual(pledgeDelete.toString('ucs2', 1, deleteNameEnd), 'Mina');

const relationActor = {
    fetchId: () => 2000001,
    fetchName: () => 'Leader',
    fetchClanId: () => 6000001,
    fetchClan: () => clan,
    fetchKarma: () => 0,
    fetchPvpFlag: () => 0
};
const relation = ServerResponse.relationChanged(relationActor);
assert.strictEqual(relation[0], 0xce);
assert.strictEqual(relation.readInt32LE(1), 2000001);
assert.strictEqual(relation.readInt32LE(5) & ServerResponse.relationChanged.RELATION_CLAN_MEMBER, ServerResponse.relationChanged.RELATION_CLAN_MEMBER);
assert.strictEqual(relation.readInt32LE(5) & ServerResponse.relationChanged.RELATION_LEADER, ServerResponse.relationChanged.RELATION_LEADER);

ServerResponse.pledgeShowInfoUpdate = originalPledgeInfoUpdate;
ServerResponse.pledgeShowMemberListAll = originalPledgeAllResponse;

console.log('Clan system checks passed');
