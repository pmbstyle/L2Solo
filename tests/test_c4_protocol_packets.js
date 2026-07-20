const assert = require('assert');

require('../src/Global');

const AuthResponse = invoke('AuthenticationServer/Network/Response');
const GameOpcodes = invoke('GameServer/Network/Opcodes');
const GameRequest = invoke('GameServer/Network/Request');
const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');

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
        fetchClanId: () => 6000001,
        fetchClanPrivileges: () => 2047,
        fetchPrivateStoreType: () => 0,
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 9,
        fetchEvalScore: () => 2,
        fetchMaxCp: () => 111,
        fetchCp: () => 77,
        fetchCharges: () => 3,
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

function fakeItem(overrides = {}) {
    return {
        fetchClass1: () => overrides.class1 ?? 4,
        fetchClass2: () => overrides.class2 ?? 5,
        fetchId: () => overrides.id ?? 1000001,
        fetchSelfId: () => overrides.selfId ?? 1835,
        fetchAmount: () => overrides.amount ?? 1,
        fetchSlot: () => overrides.slot ?? 0,
        fetchPrice: () => overrides.price ?? 7,
        isWearable: () => overrides.wearable === true
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
assert.strictEqual(GameOpcodes.table[0x96], GameRequest.privateStoreSell, 'C4 RequestPrivateStoreSell opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x73], GameRequest.privateStoreManageSell, 'C4 private sell action should open the native manage window');
assert.strictEqual(GameOpcodes.table[0x74], GameRequest.privateStoreListSell, 'C4 private sell list should publish the configured rows');
assert.strictEqual(GameOpcodes.table[0x90], GameRequest.privateStoreManageBuy, 'C4 private buy action should open the native manage window');
assert.strictEqual(GameOpcodes.table[0x91], GameRequest.privateStoreListBuy, 'C4 private buy list should publish the configured rows');
const privateStoreSellWithC4Tail = Buffer.alloc(22);
privateStoreSellWithC4Tail[0] = 0x74;
privateStoreSellWithC4Tail.writeInt32LE(0, 1);
privateStoreSellWithC4Tail.writeInt32LE(1, 5);
privateStoreSellWithC4Tail.writeInt32LE(70001, 9);
privateStoreSellWithC4Tail.writeInt32LE(1, 13);
privateStoreSellWithC4Tail.writeInt32LE(1000, 17);
let capturedPrivateStoreSell = null;
const originalPublishPrivateStoreSell = invoke('GameServer/PrivateStore').publishSell;
invoke('GameServer/PrivateStore').publishSell = (_session, packaged, rows) => { capturedPrivateStoreSell = { packaged, rows }; return true; };
GameRequest.privateStoreListSell({}, privateStoreSellWithC4Tail);
invoke('GameServer/PrivateStore').publishSell = originalPublishPrivateStoreSell;
assert.deepStrictEqual(capturedPrivateStoreSell, { packaged: false, rows: [{ objectId: 70001, count: 1, price: 1000 }] }, 'C4 private sell publish should accept optional trailing fields');
assert.strictEqual(GameOpcodes.table[0xb6], GameRequest.recipeShopMakeItem, 'C4 RequestRecipeShopMakeItem opcode should be wired');
assert.strictEqual(GameOpcodes.table[0xb7], GameRequest.recipeShopManagePrev, 'C4 RequestRecipeShopManagePrev opcode should be wired');
assert.strictEqual(GameOpcodes.table[0x2b], GameRequest.dismissParty, 'C4 RequestWithDrawalParty should be wired to 0x2b');
assert.strictEqual(GameOpcodes.table[0x2c], GameRequest.oustPartyMember, 'C4 RequestOustPartyMember should be wired to 0x2c');

const partySession = { actor: { fetchName: () => 'C4Tester' } };
const originalDismissParty = World.dismissParty;
const originalOustPartyMember = World.oustPartyMember;
let partyAction = null;
World.dismissParty = (session, actor) => { partyAction = { type: 'withdraw', session, actor }; };
World.oustPartyMember = (session, actor, data) => { partyAction = { type: 'oust', session, actor, data }; };
try {
    GameOpcodes.table[0x2b](partySession, Buffer.from([0x2b]));
    assert.strictEqual(partyAction.type, 'withdraw', 'C4 /leave packet must not attempt to read a member name');

    const oustPacket = Buffer.concat([Buffer.from([0x2c]), Buffer.from('Mina', 'ucs2'), Buffer.alloc(2)]);
    GameOpcodes.table[0x2c](partySession, oustPacket);
    assert.deepStrictEqual(partyAction, {
        type: 'oust', session: partySession, actor: partySession.actor, data: { name: 'Mina' }
    }, 'C4 oust packet should pass the named party member');
} finally {
    World.dismissParty = originalDismissParty;
    World.oustPartyMember = originalOustPartyMember;
}

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

const chooseInventoryItem = ServerResponse.chooseInventoryItem(731);
assert.strictEqual(chooseInventoryItem[0], 0x6f, 'C4 ChooseInventoryItem response opcode should be 0x6f');
assert.strictEqual(chooseInventoryItem.readInt32LE(1), 731, 'C4 ChooseInventoryItem should send the selected scroll item id');

const actor = fakeActor();
const etcStatusUpdate = ServerResponse.etcStatusUpdate(actor);
assert.strictEqual(etcStatusUpdate[0], 0xf3, 'C4 EtcStatusUpdate response opcode should be 0xf3');
assert.strictEqual(etcStatusUpdate.readInt32LE(1), 3, 'C4 EtcStatusUpdate should send current charges first');
assert.strictEqual(etcStatusUpdate.readInt32LE(5), 0, 'C4 EtcStatusUpdate should default weight penalty to zero');

const userInfo = ServerResponse.userInfo(actor);
assert.strictEqual(userInfo[0], 0x04);
assert.deepStrictEqual(actor.paperdollIdSlots, [7, ...Array.from({ length: 14 }, (_, i) => i)]);
assert.deepStrictEqual(actor.paperdollSelfIdSlots, [7, ...Array.from({ length: 14 }, (_, i) => i)]);
assert.ok(userInfo.includes(0xff), 'C4 UserInfo should include trailing name-color bytes');

const fullBodyActor = fakeActor();
const fullBodyUserInfo = ServerResponse.userInfo(fullBodyActor);
assert.ok(fullBodyUserInfo, 'full-body equipment should still produce UserInfo');
assert.ok(!fullBodyActor.paperdollIdSlots.includes(15), 'internal full-body slot must not be serialized as a C4 equipment field');
assert.ok(!fullBodyActor.paperdollSelfIdSlots.includes(15), 'internal full-body item slot must not be serialized as a C4 equipment field');
const userInfoEquipmentOffset = 1 + 20 + Buffer.byteLength('C4Tester\0', 'ucs2') + (19 * 4);
assert.strictEqual(userInfo.readInt32LE(userInfoEquipmentOffset + (14 * 4)), 4000007, 'C4 UserInfo must repeat the right-hand weapon before the hair field');
assert.strictEqual(userInfo.readInt32LE(userInfoEquipmentOffset + (15 * 4)), 0, 'C4 UserInfo hair field must not receive a weapon or full-body armor');
assert.strictEqual(userInfo.readInt32LE(userInfoEquipmentOffset + (30 * 4)), 1007, 'C4 UserInfo must repeat the right-hand weapon display id before the hair field');
assert.strictEqual(userInfo.readInt32LE(userInfoEquipmentOffset + (31 * 4)), 0, 'C4 UserInfo hair display id must remain empty');
actor.effects = { stun: { key: 'stun', id: 100, type: 'debuff', expiresAt: Date.now() + 10000 } };
assert.ok(ServerResponse.userInfo(actor).includes(0x40), 'C4 UserInfo should expose the stun abnormal-effect mask');

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

const privateStoreSell = ServerResponse.privateStoreMsg(actor, 'Cheap C-Grade gear');
assert.strictEqual(privateStoreSell[0], 0x9c, 'C4 PrivateStoreMsgSell should use opcode 0x9c');
assert.strictEqual(privateStoreSell.readInt32LE(1), actor.fetchId(), 'C4 PrivateStoreMsgSell should include the seller object id');
assert.strictEqual(privateStoreSell.toString('ucs2', 5, findUtf16Terminator(privateStoreSell, 5)), 'Cheap C-Grade gear', 'C4 PrivateStoreMsgSell should carry only the shop title after the object id');

const privateStoreBuy = ServerResponse.privateStoreBuyMsg(actor, 'Buying mats');
assert.strictEqual(privateStoreBuy[0], 0xb9, 'C4 PrivateStoreMsgBuy should use opcode 0xb9');
assert.strictEqual(privateStoreBuy.readInt32LE(1), actor.fetchId(), 'C4 PrivateStoreMsgBuy should include the buyer object id');
assert.strictEqual(privateStoreBuy.toString('ucs2', 5, findUtf16Terminator(privateStoreBuy, 5)), 'Buying mats', 'C4 PrivateStoreMsgBuy should carry only the shop title after the object id');

const wantedItem = {
    fetchId: () => 70001,
    fetchSelfId: () => 1864,
    fetchPrice: () => 75,
    fetchClass2: () => 5,
    fetchSlot: () => 0,
    isWearable: () => false
};
const privateBuyList = ServerResponse.privateStoreListBuy(actor, [{ item: wantedItem, amount: 12, price: 62 }], 5000);
assert.strictEqual(privateBuyList[0], 0xb8, 'C4 private buyer should open PrivateStoreListBuy, not the NPC SellList');
assert.strictEqual(privateBuyList.readInt32LE(1), actor.fetchId(), 'C4 PrivateStoreListBuy should identify the buyer merchant');
assert.strictEqual(privateBuyList.readInt32LE(9), 1, 'C4 PrivateStoreListBuy should include the wanted row count');
assert.strictEqual(privateBuyList.readInt32LE(13), 70001, 'C4 PrivateStoreListBuy should use the seller inventory object id');
assert.strictEqual(privateBuyList.readInt32LE(39), 62, 'C4 PrivateStoreListBuy should expose the buyer offer price');

const originalConsumeMerchant = GameRequest.sell.consumeMerchant;
let capturedPrivateSell = null;
GameRequest.sell.consumeMerchant = (session, list, options) => {
    capturedPrivateSell = { session, list, options };
};
const privateSellSession = {
    activeMerchantTrade: {
        merchant: { fetchId: () => 50001 },
        store: { storeType: 3 }
    },
    dataSendToMe: () => assert.fail('valid C4 RequestPrivateStoreSell should not fail before trade execution')
};
const privateSellRequest = Buffer.alloc(29);
privateSellRequest[0] = 0x96;
privateSellRequest.writeInt32LE(50001, 1);
privateSellRequest.writeInt32LE(1, 5);
privateSellRequest.writeInt32LE(70001, 9);
privateSellRequest.writeInt32LE(1864, 13);
privateSellRequest.writeInt16LE(0, 17);
privateSellRequest.writeInt16LE(0, 19);
privateSellRequest.writeInt32LE(4, 21);
privateSellRequest.writeInt32LE(62, 25);
GameRequest.privateStoreSell(privateSellSession, privateSellRequest);
GameRequest.sell.consumeMerchant = originalConsumeMerchant;
assert.strictEqual(capturedPrivateSell.session, privateSellSession, 'C4 private sale should execute against the selected buyer store');
assert.deepStrictEqual(capturedPrivateSell.list, [{ objectId: 70001, selfId: 1864, amount: 4, price: 62 }], 'C4 private sale should parse object id, amount, and advertised price exactly');
assert.deepStrictEqual(capturedPrivateSell.options, { native: true }, 'C4 private sale should preserve the native refresh path');

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

const magicUse = ServerResponse.skillStarted(actor, actor.fetchId(), {
    fetchSelfId: () => 2047,
    fetchCalculatedHitTime: () => 0,
    fetchReuseTime: () => 0
});
assert.strictEqual(magicUse[0], 0x48, 'C4 MagicSkillUse opcode should be 0x48');
assert.strictEqual(magicUse.readInt32LE(9), 2047, 'MagicSkillUse should include shot skill id');
assert.strictEqual(magicUse.readInt32LE(37), 0, 'MagicSkillUse should write the final critical flag as a D');

const magicLaunched = ServerResponse.magicSkillLaunched(actor, {
    fetchSelfId: () => 1177,
    fetchLevel: () => 1
}, [{ fetchId: () => 3000001 }]);
assert.strictEqual(magicLaunched[0], 0x76, 'C4 MagicSkillLaunched opcode should be 0x76');
assert.strictEqual(magicLaunched.readInt32LE(1), actor.fetchId(), 'MagicSkillLaunched should include caster id');
assert.strictEqual(magicLaunched.readInt32LE(5), 1177, 'MagicSkillLaunched should include skill id');
assert.strictEqual(magicLaunched.readInt32LE(13), 1, 'MagicSkillLaunched should include target count');
assert.strictEqual(magicLaunched.readInt32LE(17), 3000001, 'MagicSkillLaunched should include target id');

const shopShot = fakeItem({ class1: 4, class2: 5, id: 500001, selfId: 1835, amount: 1, price: 7 });
const shopWand = fakeItem({ class1: 0, class2: 0, id: 500002, selfId: 6, amount: 1, price: 138, slot: 7, wearable: true });
const purchaseList = ServerResponse.purchaseList([shopShot, shopWand], 1000);
assert.strictEqual(purchaseList[0], 0x11, 'C4 BuyList opcode should be 0x11');
assert.strictEqual(purchaseList.readInt16LE(9), 2, 'BuyList should include item count');
assert.strictEqual(purchaseList.readInt32LE(29), 0, 'BuyList non-wearable rows should still include empty body part');
assert.strictEqual(purchaseList.readInt32LE(39), 7, 'BuyList non-wearable price should follow the full C4 item tuple');
assert.strictEqual(purchaseList.readInt32LE(49), 6, 'BuyList second row should not be shifted after a non-wearable item');
assert.strictEqual(purchaseList.readInt32LE(61), 2 ** 7, 'BuyList wearable body part should use the paperdoll bitmask');
assert.strictEqual(purchaseList.readInt32LE(71), 138, 'BuyList wearable price should follow body part/enchant fields');

const sellList = ServerResponse.sellList([{ item: shopShot, amount: 3, price: 10 }], 1000);
assert.strictEqual(sellList[0], 0x10, 'C4 SellList opcode should be 0x10');
assert.strictEqual(sellList.readInt32LE(21), 3, 'SellList should include sellable amount');
assert.strictEqual(sellList.readInt32LE(29), 0, 'SellList non-wearable rows should still include empty body part');
assert.strictEqual(sellList.readInt32LE(39), 10, 'SellList non-wearable price should follow the full C4 item tuple');

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
