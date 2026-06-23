const Opcodes = invoke('GameServer/Network/Opcodes');
const Actor   = invoke('GameServer/Actor/Actor');
const World   = invoke('GameServer/World/World');

const TRACE_LIMIT = 40;

const CLIENT_PACKET_NAMES = {
    0x00: 'ProtocolVersion',
    0x01: 'MoveToLocation',
    0x03: 'EnterWorld',
    0x04: 'Action',
    0x08: 'AuthLogin',
    0x09: 'Logout',
    0x0a: 'Attack',
    0x0b: 'CreateNewChar',
    0x0c: 'CharDelete',
    0x0d: 'CharSelected',
    0x0e: 'EnterCharCreation',
    0x0f: 'ItemsList',
    0x11: 'UnequipItem',
    0x12: 'DropItem',
    0x14: 'UseItem',
    0x15: 'TradeRequest',
    0x16: 'AddTradeItem',
    0x17: 'TradeDone',
    0x1b: 'SocialAction',
    0x1e: 'Sell',
    0x1f: 'Purchase',
    0x21: 'HtmlLink',
    0x29: 'AskForTeamUp',
    0x2a: 'AnswerForTeamUp',
    0x2b: 'OustPartyMember',
    0x2c: 'DismissParty',
    0x2f: 'SkillUse',
    0x30: 'Appeared',
    0x33: 'AddShortcut',
    0x35: 'RemoveShortcut',
    0x36: 'StopMove',
    0x37: 'DestCancel',
    0x38: 'Speak',
    0x3f: 'SkillsList',
    0x45: 'ActionUse',
    0x46: 'Restart',
    0x48: 'ValidatePosition',
    0x57: 'RequestShowBoard',
    0x59: 'TrashItem',
    0x63: 'QuestList',
    0x6d: 'RestartPoint',
    0x9d: 'RequestSkillCoolTime',
    0xaa: 'UserCommand',
    0xb9: 'Recommend',
    0xc1: 'Macro',
    0xcd: 'ShowMap',
    0xd0: 'ExtendedRequest'
};

const SERVER_PACKET_NAMES = {
    0x00: 'Die',
    0x01: 'Revive',
    0x03: 'CharInfo',
    0x04: 'UserInfo',
    0x05: 'Attack',
    0x06: 'CharSelected',
    0x08: 'CharCreateFail',
    0x09: 'CharCreateSuccess',
    0x0b: 'CharDelete',
    0x0c: 'CharDelete',
    0x0d: 'NewCharacterSuccess',
    0x13: 'CharSelectInfo',
    0x15: 'CharSelected',
    0x0f: 'ItemsList',
    0x12: 'TradeStart',
    0x16: 'NpcInfo',
    0x17: 'SellList',
    0x1b: 'StatusUpdate',
    0x39: 'AskJoinParty',
    0x3a: 'JoinParty',
    0x23: 'WithdrawalParty',
    0x24: 'OustPartyMember',
    0x27: 'MoveToLocation',
    0x28: 'NpcSay',
    0x2f: 'MoveToPawn',
    0x30: 'SocialAction',
    0x31: 'ChangeMoveType',
    0x32: 'ChangeWaitType',
    0x39: 'SkillList',
    0x3a: 'VehicleInfo',
    0x3f: 'SkillStarted',
    0x44: 'ShortCutRegister',
    0x45: 'ShortCutInit',
    0x47: 'StopMove',
    0x48: 'MagicSkillCanceled',
    0x4a: 'CreatureSay',
    0x4b: 'EquipUpdate',
    0x4c: 'DoorInfo',
    0x4e: 'PartySmallWindowAll',
    0x4f: 'PartySmallWindowAdd',
    0x50: 'PartySmallWindowDeleteAll',
    0x51: 'PartySmallWindowDelete',
    0x52: 'PartySmallWindowUpdate',
    0x58: 'ActionFailed',
    0x5f: 'RestartResponse',
    0x60: 'MoveToPawn',
    0x61: 'ValidateLocation',
    0x62: 'StartRotating',
    0x63: 'FinishRotating',
    0x69: 'SetupGauge',
    0x73: 'RecipeShopManageList',
    0x76: 'SystemMessage',
    0x7a: 'QuestList',
    0x7e: 'TradeDone',
    0x87: 'PrivateStoreListSell',
    0x8b: 'PrivateStoreListBuy',
    0x8c: 'PrivateStoreMsg',
    0x8d: 'ShowMiniMap',
    0x8f: 'TutorialShowHtml',
    0x95: 'PledgeShowMemberListAll',
    0x99: 'SkillCoolTime',
    0x9d: 'ShowMap',
    0xa6: 'MyTargetSelected',
    0xb9: 'RelationChanged',
    0xc7: 'NpcHtmlMessage',
    0xc8: 'TutorialShowQuestionMark',
    0xce: 'RelationChanged',
    0xd0: 'ExtendedPacket'
};

function packetName(map, opcode) {
    return map[opcode] || 'Unknown';
}

function packetOpcode(data) {
    return data && data.length > 0 ? data[0] : 0;
}

class Session {
    constructor(socket) {
        const optn = options.default.GameServer;

        this.socket   = socket;
        this.serverId = optn.id;
        this.packetTrace = [];
    }

    setAccountId(username) {
        this.accountId = username;
        World.insertUser(this);
    }

    setActor(properties) {
        this.actor = new Actor(this, properties);
    }

    fetchAccountId() {
        return this.accountId;
    }

    dataReceive(data) {
        // Weird, sometimes the packet is sent twofold/duplicated. I had to limit it based on the header size...
        const packet = data.slice(2, data.readInt16LE());
        this.tracePacket('in', packet, packetName(CLIENT_PACKET_NAMES, packetOpcode(packet)));
        Opcodes.table[packet[0]](this, packet);
    }

    dataSendToMe(data) {
        this.recordOutboundPacket(data);
        const packet = this.packData(data);
        this.socket.write(packet);
    }

    dataSendToOthers(data, creature) {
        const packet = this.packData(data);
        World.fetchVisibleUsers(this, creature).forEach((user) => {
            if (user.recordOutboundPacket) {
                user.recordOutboundPacket(data);
            }
            user.socket.write(packet);
        });
    }

    dataSendToMeAndOthers(data, creature) {
        this.dataSendToMe(data);
        this.dataSendToOthers(data, creature);
    }

    packData(data) {
        const header = Buffer.alloc(2);
        header.writeInt16LE(utils.size(data) + 2);
        return Buffer.concat([header, data]);
    }

    tracePacket(direction, data, name) {
        if (process.env.L2NODE_PACKET_TRACE === '0') {
            return;
        }

        this.packetTrace.push({
            at: new Date().toISOString(),
            direction,
            opcode: packetOpcode(data),
            name,
            length: utils.size(data),
            detail: data && data.__packetTrace ? data.__packetTrace : ''
        });

        if (this.packetTrace.length > TRACE_LIMIT) {
            this.packetTrace.shift();
        }
    }

    recordOutboundPacket(data) {
        this.tracePacket('out', data, packetName(SERVER_PACKET_NAMES, packetOpcode(data)));
    }

    traceLabel() {
        const actorName = this.actor && this.actor.fetchName ? this.actor.fetchName() : null;
        const accountId = this.accountId || 'anonymous';
        return actorName ? `${actorName}/${accountId}` : accountId;
    }

    dumpPacketTrace() {
        if (!this.packetTrace || this.packetTrace.length === 0) {
            utils.infoWarn('GameServer', 'packet trace for %s is empty', this.traceLabel());
            return;
        }

        utils.infoWarn('GameServer', 'last %d packets for %s:', this.packetTrace.length, this.traceLabel());
        this.packetTrace.forEach((entry) => {
            utils.infoWarn(
                'GameServer',
                '  %s %s 0x%s %s len=%d%s',
                entry.at,
                entry.direction === 'in' ? '<-' : '->',
                utils.toHex(entry.opcode),
                entry.name,
                entry.length,
                entry.detail ? ` ${entry.detail}` : ''
            );
        });
    }

    error(err) {
        if (err) {
            utils.infoWarn('GameServer', 'exception: ' + (err.stack || err.message || err));
            this.dumpPacketTrace();
        } else {
            utils.infoWarn('GameServer', 'connection closed');
        }
        if (this.actor) {
            this.actor.destructor();
            this.actor = null;
        }
        World.removeUser(this);
    }
}

module.exports = Session;
