const assert = require('assert');

require('../src/Global');

const AuthResponse = invoke('AuthenticationServer/Network/Response');
const GameOpcodes = invoke('GameServer/Network/Opcodes');
const GameRequest = invoke('GameServer/Network/Request');
const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket = invoke('Packet/Receive');

function fakePaperdoll() {
    return Array.from({ length: 16 }, (_, slot) => ({
        id: 4000000 + slot,
        selfId: 1000 + slot
    }));
}

function fakeActor(paperdoll = fakePaperdoll()) {
    const paperdollIdSlots = [];
    const paperdollSelfIdSlots = [];

    const actor = {
        paperdollIdSlots,
        paperdollSelfIdSlots,
        backpack: {
            fetchTotalLoad: () => 123,
            fetchPaperdollId: (slot) => {
                paperdollIdSlots.push(slot);
                return paperdoll[slot]?.id || 0;
            },
            fetchPaperdollSelfId: (slot) => {
                paperdollSelfIdSlots.push(slot);
                return paperdoll[slot]?.selfId || 0;
            }
        },
        fetchLocX: () => 1,
        fetchLocY: () => 2,
        fetchLocZ: () => 3,
        fetchHead: () => 4,
        fetchId: () => 2000001,
        fetchName: () => 'C4Tester',
        fetchRace: () => 0,
        fetchSex: () => 0,
        fetchClassId: () => 10,
        fetchLevel: () => 20,
        fetchExp: () => 1000,
        fetchStr: () => 21,
        fetchDex: () => 22,
        fetchCon: () => 23,
        fetchInt: () => 24,
        fetchWit: () => 25,
        fetchMen: () => 26,
        fetchMaxHp: () => 300,
        fetchHp: () => 250,
        fetchMaxMp: () => 200,
        fetchMp: () => 150,
        fetchSp: () => 50,
        fetchMaxLoad: () => 5000,
        fetchCollectivePAtk: () => 10,
        fetchCollectiveAtkSpd: () => 20,
        fetchCollectivePDef: () => 30,
        fetchCollectiveEvasion: () => 40,
        fetchCollectiveAccur: () => 50,
        fetchCollectiveCritical: () => 60,
        fetchCollectiveMAtk: () => 70,
        fetchCollectiveCastSpd: () => 80,
        fetchCollectiveMDef: () => 90,
        fetchPvpFlag: () => 0,
        fetchKarma: () => 0,
        fetchCollectiveRunSpd: () => 120,
        fetchCollectiveWalkSpd: () => 80,
        fetchSwim: () => 0,
        fetchAtkSpdMultiplier: () => 1,
        fetchRadius: () => 8,
        fetchSize: () => 24,
        fetchHair: () => 0,
        fetchHairColor: () => 0,
        fetchFace: () => 0,
        fetchIsGM: () => 0,
        fetchTitle: () => '',
        fetchPrivateStoreType: () => 0,
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 9,
        fetchEvalScore: () => 2,
        fetchMaxCp: () => 111,
        fetchCp: () => 77,
        state: {
            fetchSeated: () => false
        }
    };

    return actor;
}

function fakeNpc() {
    return {
        fetchId: () => 3000001,
        fetchDispSelfId: () => 1007001,
        fetchAttackable: () => 0,
        fetchLocX: () => 11,
        fetchLocY: () => 22,
        fetchLocZ: () => 33,
        fetchHead: () => 44,
        fetchCollectiveCastSpd: () => 333,
        fetchCollectiveAtkSpd: () => 277,
        fetchCollectiveRunSpd: () => 120,
        fetchCollectiveWalkSpd: () => 80,
        fetchAtkSpdMultiplier: () => 1,
        fetchRadius: () => 8,
        fetchSize: () => 24,
        fetchWeapon: () => 0,
        fetchArmor: () => 0,
        fetchShield: () => 0,
        fetchStateRun: () => 1,
        fetchStateAttack: () => 0,
        fetchStateDead: () => 0,
        fetchStateInvisible: () => 0,
        fetchName: () => 'C4Npc',
        fetchTitle: () => 'Ready'
    };
}

function findUtf16Terminator(buffer, offset) {
    for (let i = offset; i + 1 < buffer.length; i += 2) {
        if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
            return i;
        }
    }
    return -1;
}

function charInfoEquipment(buffer) {
    const nameEnd = findUtf16Terminator(buffer, 21);
    const equipmentOffset = nameEnd + 2 + 16;

    return {
        head: buffer.readInt32LE(equipmentOffset),
        weapon: buffer.readInt32LE(equipmentOffset + 4),
        shield: buffer.readInt32LE(equipmentOffset + 8),
        twoHand: buffer.readInt32LE(equipmentOffset + 32)
    };
}

const authGG = AuthResponse.authGG(0x12345678);
assert.strictEqual(authGG[0], 0x0b, 'C4 AuthGG response opcode should be 0x0b');
assert.strictEqual(authGG.readInt32LE(1), 0x12345678);

assert.strictEqual(GameOpcodes.table[0xcd], GameRequest.showMap, 'C4 map request opcode should be wired');

const joinPartyRequest = Buffer.concat([
    Buffer.from([0x29]),
    Buffer.from('Mina', 'ucs2'),
    Buffer.alloc(2),
    Buffer.from([0x01, 0x00, 0x00, 0x00])
]);
const joinPartyPacket = new ReceivePacket(joinPartyRequest);
joinPartyPacket.readS().readD();
assert.strictEqual(joinPartyPacket.data[0], 'Mina', 'C4 RequestJoinParty should read target name');
assert.strictEqual(joinPartyPacket.data[1], 1, 'C4 RequestJoinParty should read distribution after target name');

const askJoinParty = ServerResponse.askForTeamUp('Embri', 1);
assert.strictEqual(askJoinParty[0], 0x39, 'C4 AskJoinParty response opcode should be 0x39');
const askJoinPartyEnd = findUtf16Terminator(askJoinParty, 1);
assert.strictEqual(askJoinParty.toString('ucs2', 1, askJoinPartyEnd), 'Embri');
assert.strictEqual(askJoinParty.readInt32LE(askJoinPartyEnd + 2), 1);

let mapPacket = null;
GameRequest.showMap({
    dataSendToMe(packet) {
        mapPacket = packet;
    }
});
assert.ok(mapPacket, 'show map request should send a response packet');
assert.strictEqual(mapPacket[0], 0x9d, 'C4 ShowMap response opcode should be 0x9d');
assert.strictEqual(mapPacket.readInt32LE(1), 1665, 'default world map id should be sent');

const actor = fakeActor();
const userInfo = ServerResponse.userInfo(actor);
assert.strictEqual(userInfo[0], 0x04);
assert.deepStrictEqual(actor.paperdollIdSlots, Array.from({ length: 16 }, (_, i) => i));
assert.deepStrictEqual(actor.paperdollSelfIdSlots, Array.from({ length: 16 }, (_, i) => i));
assert.ok(userInfo.includes(0xff), 'C4 UserInfo should include trailing name-color bytes');

const charInfo = ServerResponse.charInfo(actor);
assert.strictEqual(charInfo[0], 0x03);
assert.ok(charInfo.includes(0xff), 'C4 CharInfo should include trailing name-color bytes');
assert.strictEqual(charInfoEquipment(charInfo).weapon, 1007, 'C4 CharInfo should display right-hand weapons');
const nameColorOffset = charInfo.lastIndexOf(Buffer.from([0xff, 0xff, 0xff, 0x00]));
assert.ok(nameColorOffset > 0, 'C4 CharInfo should end its meaningful payload with name color');
const charInfoTail = charInfo.subarray(nameColorOffset + 4 - 37, nameColorOffset + 4);
assert.strictEqual(charInfoTail.readInt32LE(0), 0, 'C4 CharInfo should send mount NPC id before class id');
assert.strictEqual(charInfoTail.readInt32LE(4), 10, 'C4 CharInfo should send class id after mount NPC id');
assert.strictEqual(charInfoTail.readInt32LE(8), 0, 'C4 CharInfo should not send CP in the public tail');

const dualPaperdoll = fakePaperdoll();
dualPaperdoll[7] = {};
dualPaperdoll[8] = {};
dualPaperdoll[14] = { id: 4000014, selfId: 999014 };
const dualCharInfo = ServerResponse.charInfo(fakeActor(dualPaperdoll));
const dualEquipment = charInfoEquipment(dualCharInfo);
assert.strictEqual(dualEquipment.weapon, 999014, 'C4 CharInfo should display slot 14 two-hand weapons in the weapon field');
assert.strictEqual(dualEquipment.twoHand, 999014, 'C4 CharInfo should display slot 14 two-hand weapons in the two-hand field');

const partyAll = ServerResponse.partySmallWindowAll(actor.fetchId(), 1, [actor]);
assert.strictEqual(partyAll[0], 0x4e);
assert.strictEqual(partyAll.readInt32LE(1), actor.fetchId(), 'C4 PartySmallWindowAll should include leader id');
assert.strictEqual(partyAll.readInt32LE(5), 1, 'C4 PartySmallWindowAll should include loot distribution');
assert.strictEqual(partyAll.readInt32LE(9), 1, 'C4 PartySmallWindowAll should include member count after leader and loot');
const partyMemberOffset = 13;
const partyNameEnd = findUtf16Terminator(partyAll, partyMemberOffset + 4);
const partyVitalsOffset = partyNameEnd + 2;
assert.strictEqual(partyAll.readInt32LE(partyVitalsOffset), actor.fetchCp(), 'C4 party member tuple should send CP before HP');
assert.strictEqual(partyAll.readInt32LE(partyVitalsOffset + 4), actor.fetchMaxCp(), 'C4 party member tuple should send max CP before HP');
assert.strictEqual(partyAll.readInt32LE(partyVitalsOffset + 8), actor.fetchHp(), 'C4 party member tuple should send HP after CP');

const partyUpdate = ServerResponse.partySmallWindowUpdate(actor);
assert.strictEqual(partyUpdate[0], 0x52);
const updateNameEnd = findUtf16Terminator(partyUpdate, 5);
const updateVitalsOffset = updateNameEnd + 2;
assert.strictEqual(partyUpdate.readInt32LE(updateVitalsOffset), actor.fetchCp(), 'C4 party update should send CP before HP');
assert.strictEqual(partyUpdate.readInt32LE(updateVitalsOffset + 8), actor.fetchHp(), 'C4 party update should send HP after CP');
assert.strictEqual(ServerResponse.partySmallWindowDeleteAll()[0], 0x50, 'C4 party delete all opcode should be 0x50');
assert.strictEqual(ServerResponse.partySmallWindowDelete(actor.fetchId(), actor.fetchName())[0], 0x51, 'C4 party delete opcode should be 0x51');

const partySpelled = ServerResponse.partySpelled(actor.fetchId(), [{ id: 1040, level: 2, duration: 120 }]);
assert.strictEqual(partySpelled[0], 0xee, 'C4 PartySpelled opcode should be 0xee');
assert.strictEqual(partySpelled.readInt32LE(1), 0, 'PartySpelled should mark normal party member effects');
assert.strictEqual(partySpelled.readInt32LE(5), actor.fetchId(), 'PartySpelled should include member object id');
assert.strictEqual(partySpelled.readInt32LE(9), 1, 'PartySpelled should include effect count');
assert.strictEqual(partySpelled.readInt32LE(13), 1040, 'PartySpelled should include effect skill id');
assert.strictEqual(partySpelled.readInt16LE(17), 2, 'PartySpelled should include effect level');
assert.strictEqual(partySpelled.readInt32LE(19), 120, 'PartySpelled should include remaining duration');

const attack = ServerResponse.attack(actor, 3000001, {
    damage: 123,
    flags: ServerResponse.attack.HITFLAG_USESS | 1
});
assert.strictEqual(attack[0], 0x05, 'C4 Attack opcode should be 0x05');
assert.strictEqual(attack.readInt32LE(1), actor.fetchId(), 'C4 Attack should include attacker id');
assert.strictEqual(attack.readInt32LE(5), 3000001, 'C4 Attack should include target id');
assert.strictEqual(attack.readInt32LE(9), 123, 'C4 Attack should include actual damage');
assert.strictEqual(attack[13], 0x11, 'C4 Attack should include soulshot flag and grade');
assert.strictEqual(attack.readInt32LE(14), actor.fetchLocX(), 'C4 Attack should include attacker X');
assert.strictEqual(attack.readInt16LE(26), 0, 'C4 Attack should send no extra hits for a single target');

const npcInfo = ServerResponse.npcInfo(fakeNpc());
assert.strictEqual(npcInfo[0], 0x16);
assert.ok(npcInfo.length >= 208, 'C4 NpcInfo should include team/collision tail fields');

const charSelectInfo = ServerResponse.charSelectInfo([{
    name: 'C4Tester',
    id: 2000001,
    username: 'tester',
    sex: 0,
    race: 0,
    classId: 10,
    locX: 1,
    locY: 2,
    locZ: 3,
    hp: 250,
    mp: 150,
    maxHp: 300,
    maxMp: 200,
    sp: 50,
    exp: 1000,
    level: 20,
    karma: 0,
    hair: 0,
    hairColor: 0,
    face: 0,
    paperdoll: fakePaperdoll()
}]);
assert.strictEqual(charSelectInfo[0], 0x13);

console.log('C4 protocol packet checks passed');
