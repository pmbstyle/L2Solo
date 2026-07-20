const ClientRequest = invoke('GameServer/Network/Request');

// Establishes an `Opcode` table to handle client packets
const Opcodes = {
    table: (() => {
        const table = utils.tupleAlloc(0xff, (_, packet) => {
            utils.infoWarn('GameServer', 'unknown Opcode 0x%s', utils.toHex(packet[0]));
        });

        table[0x00] = ClientRequest.protocolVersion;
        table[0x01] = ClientRequest.moveToLocation;
        table[0x03] = ClientRequest.enterWorld;
        table[0x04] = ClientRequest.action;
        table[0x08] = ClientRequest.authLogin;
        table[0x09] = ClientRequest.logout;
        table[0x0a] = ClientRequest.attack;
        table[0x0b] = ClientRequest.createNewChar;
        table[0x0c] = ClientRequest.charDelete;
        table[0x0d] = ClientRequest.charSelected;
        table[0x0e] = ClientRequest.enterCharCreation;
        table[0x0f] = ClientRequest.itemsList;
        table[0x11] = ClientRequest.unequipItem;
        table[0x12] = ClientRequest.dropItem;
        table[0x14] = ClientRequest.useItem;
        table[0x15] = ClientRequest.tradeRequest;
        table[0x16] = ClientRequest.addTradeItem;
        table[0x17] = ClientRequest.tradeDone;
        table[0x1b] = ClientRequest.socialAction;
        table[0x1e] = ClientRequest.sell;
        table[0x1f] = ClientRequest.purchase;
        table[0x21] = ClientRequest.htmlLink;
        table[0x24] = ClientRequest.requestJoinPledge;
        table[0x25] = ClientRequest.requestAnswerJoinPledge;
        table[0x26] = ClientRequest.requestWithdrawalPledge;
        table[0x27] = ClientRequest.requestOustPledgeMember;
        table[0x29] = ClientRequest.askForTeamUp;
        table[0x2a] = ClientRequest.answerForTeamUp;
        // C4: 0x2b is RequestWithDrawalParty (no payload); 0x2c carries the
        // member name for RequestOustPartyMember.
        table[0x2b] = ClientRequest.dismissParty;
        table[0x2c] = ClientRequest.oustPartyMember;
        table[0x2f] = ClientRequest.skillUse;
        table[0x30] = ClientRequest.appeared;
        table[0x31] = ClientRequest.warehouseDeposit;
        table[0x32] = ClientRequest.warehouseWithdraw;
        table[0x33] = ClientRequest.addShortcut;
        table[0x35] = ClientRequest.removeShortcut;
        table[0x36] = ClientRequest.stopMove;
        table[0x37] = ClientRequest.destCancel;
        table[0x38] = ClientRequest.speak;
        table[0x3c] = ClientRequest.requestPledgeMemberList;
        table[0x3f] = ClientRequest.skillsList;
        table[0x45] = ClientRequest.actionUse;
        table[0x46] = ClientRequest.restart;
        table[0x48] = ClientRequest.validatePosition;
        table[0x53] = ClientRequest.requestSetPledgeCrest;
        table[0x59] = ClientRequest.trashItem;
        table[0x63] = ClientRequest.questList;
        table[0x64] = ClientRequest.questAbort;
        table[0x66] = ClientRequest.requestPledgeInfo;
        table[0x68] = ClientRequest.requestPledgeCrest;
        table[0x6d] = ClientRequest.restartPoint;
        table[0x72] = ClientRequest.crystallizeItem;
        table[0x73] = ClientRequest.privateStoreManageSell;
        table[0x74] = ClientRequest.privateStoreListSell;
        table[0x76] = ClientRequest.privateStoreQuit(1);
        table[0x77] = ClientRequest.privateStoreTitle(1);
        table[0x90] = ClientRequest.privateStoreManageBuy;
        table[0x91] = ClientRequest.privateStoreListBuy;
        table[0x93] = ClientRequest.privateStoreQuit(3);
        table[0x94] = ClientRequest.privateStoreTitle(3);
        table[0x96] = ClientRequest.privateStoreSell;
        table[0xaa] = ClientRequest.userCommand;
        table[0xac] = ClientRequest.recipeBookOpen;
        table[0xae] = ClientRequest.recipeItemMakeInfo;
        table[0xaf] = ClientRequest.recipeItemMakeSelf;
        table[0xb0] = ClientRequest.recipeShopManageList;
        table[0xb1] = ClientRequest.recipeShopMessageSet;
        table[0xb2] = ClientRequest.recipeShopListSet;
        table[0xb3] = ClientRequest.recipeShopManageQuit;
        table[0xb5] = ClientRequest.recipeShopMakeInfo;
        table[0xb6] = ClientRequest.recipeShopMakeItem;
        table[0xb7] = ClientRequest.recipeShopManagePrev;
        table[0xc0] = ClientRequest.requestPledgePower;
        table[0xc1] = ClientRequest.macro;
        table[0xc2] = ClientRequest.macro;
        table[0xcd] = ClientRequest.showMap;

        table[0x57] = (session) => { invoke(path.actor).adminPanel(session, session.actor); }; // Board
        table[0x9d] = () => {}; // Skill Cool Time, not needed?
        table[0xb9] = () => {}; // Recommend button
        table[0x4a] = () => {}; // StartRotating
        table[0x4b] = () => {}; // FinishRotating
        table[0xd0] = ClientRequest.extendedRequest;

        return table;
    })()
};

module.exports = Opcodes;
