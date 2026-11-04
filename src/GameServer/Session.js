const Opcodes = invoke('GameServer/Network/Opcodes');
const Actor   = invoke('GameServer/Actor/Actor');
const World   = invoke('GameServer/World/World');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');
const GroundItemVisibility = invoke('GameServer/World/GroundItemVisibility');
const Frame = invoke('Packet/Frame');

const TRACE_LIMIT = 40;
const MOVEMENT_TRACE_LIMIT = 160;
const MOVEMENT_PACKET_OPCODES = new Set([0x01, 0x03, 0x2e, 0x47]);

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
    0x24: 'RequestJoinPledge',
    0x25: 'RequestAnswerJoinPledge',
    0x26: 'RequestWithdrawalPledge',
    0x27: 'RequestOustPledgeMember',
    0x29: 'AskForTeamUp',
    0x2a: 'AnswerForTeamUp',
    0x2b: 'WithdrawalParty',
    0x2c: 'OustPartyMember',
    0x2f: 'SkillUse',
    0x30: 'Appeared',
    0x33: 'AddShortcut',
    0x35: 'RemoveShortcut',
    0x36: 'StopMove',
    0x37: 'DestCancel',
    0x38: 'Speak',
    0x3c: 'RequestPledgeMemberList',
    0x3f: 'SkillsList',
    0x45: 'ActionUse',
    0x46: 'Restart',
    0x48: 'ValidatePosition',
    0x53: 'RequestSetPledgeCrest',
    0x57: 'RequestShowBoard',
    0x59: 'TrashItem',
    0x63: 'QuestList',
    0x64: 'QuestAbort',
    0x66: 'RequestPledgeInfo',
    0x68: 'RequestPledgeCrest',
    0x6d: 'RestartPoint',
    0x9d: 'RequestSkillCoolTime',
    0xaa: 'UserCommand',
    0xa7: 'MultiSellChoose',
    0xb9: 'Recommend',
    0xc0: 'RequestPledgePower',
    0xc1: 'RequestMakeMacro',
    0xc2: 'RequestDeleteMacro',
    0xcd: 'ShowMap',
    0xd0: 'ExtendedRequest'
};

// Server packets by opcode, named after the Network/Response file that sends them
// (tests/test_server_packet_names.js checks this against those files).
const SERVER_PACKET_NAMES = {
    0x00: 'CipherInit',
    0x01: 'MoveToLocation',
    0x03: 'CharInfo',
    0x04: 'UserInfo',
    0x05: 'Attack',
    0x06: 'Die',
    0x07: 'Revive',
    0x0b: 'SpawnItem',
    0x0d: 'PickupItem',
    0x0e: 'StatusUpdate',
    0x0f: 'NpcHtml',
    0x10: 'SellList',
    0x11: 'PurchaseList',
    0x12: 'DeleteOb',
    0x13: 'CharSelectInfo',
    0x15: 'CharSelected',
    0x16: 'NpcInfo',
    0x17: 'CharTemplates',
    0x19: 'CharCreateSuccess',
    0x1a: 'CharCreateFail',
    0x1b: 'ItemsList',
    0x1c: 'Sunrise',
    0x1d: 'Sunset',
    0x1e: 'TradeStart',
    0x20: 'TradeOwnAdd',
    0x21: 'TradeOtherAdd',
    0x22: 'TradeDone',
    0x25: 'ActionFailed',
    0x28: 'TeleportToLocation',
    0x2a: 'DestDeselected',
    0x2b: 'AutoAttackStart',
    0x2c: 'AutoAttackStop',
    0x2d: 'SocialAction',
    0x2e: 'WalkAndRun',
    0x2f: 'ChangeWaitType',
    0x30: 'ManagePledgePower',
    0x32: 'AskJoinPledge',
    0x33: 'JoinPledge',
    0x39: 'AskForTeamUp',
    0x3a: 'JoinParty',
    0x41: 'WareHouseDepositList',
    0x42: 'WareHouseWithdrawalList',
    0x44: 'AddShortcut',
    0x45: 'ShortcutInit',
    0x47: 'StopMove',
    0x48: 'SkillStarted',
    0x49: 'MagicSkillCanceld',
    0x4a: 'Speak',
    0x4e: 'PartySmallWindowAll',
    0x50: 'PartySmallWindowDeleteAll',
    0x52: 'PartySmallWindowUpdate',
    0x53: 'PledgeShowMemberListAll',
    0x54: 'PledgeShowMemberListUpdate',
    0x55: 'PledgeShowMemberListAdd',
    0x56: 'PledgeShowMemberListDelete',
    0x58: 'SkillsList',
    0x5f: 'Restart',
    0x60: 'MoveToPawn',
    0x61: 'ValidateLocation',
    0x62: 'BeginRotation',
    0x63: 'StopRotation',
    0x64: 'SystemMessage',
    0x6c: 'PledgeCrest',
    0x6d: 'SkillDurationBar',
    0x6f: 'ChooseInventoryItem',
    0x76: 'MagicSkillLaunched',
    0x7e: 'LogoutSuccess',
    0x7f: 'AbnormalStatusUpdate',
    0x80: 'QuestList',
    0x81: 'EnchantResult',
    0x82: 'PledgeShowMemberListDeleteAll',
    0x83: 'PledgeInfo',
    0x86: 'Ride',
    0x88: 'PledgeShowInfoUpdate',
    0x98: 'PlaySound',
    0x9a: 'PrivateStoreManageListSell',
    0x9b: 'PrivateStoreListSell',
    0x9c: 'PrivateStoreMsg',
    0x9d: 'ShowMap',
    0xa6: 'DestSelected',
    0xa7: 'PartyMemberPosition',
    0xb0: 'PetStatusShow',
    0xb1: 'PetInfo',
    0xb2: 'PetItemList',
    0xb5: 'PetStatusUpdate',
    0xb7: 'PrivateStoreManageListBuy',
    0xb8: 'PrivateStoreListBuy',
    0xb9: 'PrivateStoreBuyMsg',
    0xc1: 'SkillCoolTime',
    0xce: 'RelationChanged',
    0xd0: 'MultiSellList',
    0xd4: 'Dice',
    0xd6: 'RecipeBookItemList',
    0xd7: 'RecipeItemMakeInfo',
    0xd8: 'RecipeShopManageList',
    0xd9: 'RecipeShopSellList',
    0xda: 'RecipeShopItemInfo',
    0xdb: 'RecipeShopMsg',
    0xdc: 'ShowCalculator',
    0xe2: 'HennaEquipList',
    0xe3: 'HennaItemInfo',
    0xe4: 'HennaInfo',
    0xe7: 'MacroList',
    0xeb: 'RadarControl',
    0xee: 'PartySpelled',
    0xf2: 'ShowXMasSeal',
    0xf3: 'EtcStatusUpdate',
    0xf4: 'ShortBuffStatusUpdate',
    0xf5: 'SSQStatus'
};

// 0xfe packets by their sub-opcode (the H after the opcode).
const EXTENDED_SERVER_PACKET_NAMES = {
    0x12: 'AutoSoulShot',
    0x2e: 'ExStorageMaxCount'
};

function packetName(map, opcode) {
    return map[opcode] || 'Unknown';
}

// A server packet's name; a 0xfe packet's comes from its sub-opcode.
function serverPacketName(opcode, sub) {
    if (opcode !== 0xfe) return packetName(SERVER_PACKET_NAMES, opcode);
    return EXTENDED_SERVER_PACKET_NAMES[sub] || `Ex0x${Number(sub || 0).toString(16).padStart(2, '0')}`;
}

function packetOpcode(data) {
    return data && data.length > 0 ? data[0] : 0;
}

class Session {
    constructor(socket) {
        const optn = options.default.GameServer;

        this.socket   = socket;
        this.serverId = optn.id;
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true && process.env.L2NODE_PACKET_TRACE !== '0') {
            this.packetTrace = [];
            this.movementPacketTrace = [];
        }
    }

    setAccountId(username) {
        this.accountId = username;
        World.insertUser(this);
    }

    setActor(properties) {
        World.retireUserActor(this, this.actor);
        // The connection survives returning to character selection.
        invoke('GameServer/World/Generics/NativeUiSession').reset(this);
        this.questStates = new Map();
        this.questStatesLoaded = false;
        this.activeNpcTalk = null;
        this.actor = new Actor(this, properties);
        World.updateUserLocation(this, this.actor);
    }

    persistCharacterStatus({ currentOnly = false } = {}) {
        if (!this.actor?.fetchId) return Promise.resolve();
        if (currentOnly && !(World.user?.sessions || []).includes(this)) return Promise.resolve();

        const Database = invoke('Database');
        const CharacterStatus = invoke('GameServer/Actor/CharacterStatus');
        return Database.updateCharacterStatus(this.actor.fetchId(), CharacterStatus.persistenceRecord(this.actor))
            .catch((error) => utils.infoWarn('DB', 'failed to save character status: %s', error.message));
    }

    fetchAccountId() {
        return this.accountId;
    }

    dataReceive(data) {
        const packet = Frame.body(data);
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) this.tracePacket('in', packet, packetName(CLIENT_PACKET_NAMES, packetOpcode(packet)));
        if (this.enterWorldReady) {
            const actor = this.actor;
            return this.enterWorldReady.then(() => {
                if (this.actor === actor) return Opcodes.table[packet[0]](this, packet);
            }).catch(error => utils.infoWarn('Character', 'login packet deferred: %s', error.message));
        }
        return Opcodes.table[packet[0]](this, packet);
    }

    dataSendToMe(data) {
        if (data?.__relationActor && this.actor) data = invoke('GameServer/Network/Response').relationChanged(data.__relationActor, this.actor);
        if (data?.__movingActor) invoke('GameServer/World/CharacterVisibility').beforeSend(this, data);
        const packet = this.packData(data);
        if (!packet) return; // longer than a frame: not sent (counted, Frame.pack)
        NpcVisibility.trackNpcPacket(this, data);
        this.recordOutboundPacket(data);
        this.socket.write(packet);
        if (data?.__characterActor && this.actor && invoke('GameServer/Clan/ClanWarRuntime').between(this.actor, data.__characterActor).status !== 'neutral') {
            this.dataSendToMe(invoke('GameServer/Network/Response').relationChanged(data.__characterActor, this.actor));
        }
        GroundItemVisibility.trackPacket(this, data);
        NpcVisibility.sendNpcMotionAfterInfo(this, data);
        if (data?.__characterActor || data?.[0] === 0x12) invoke('GameServer/World/CharacterVisibility').afterSend(this, data);
    }

    dataSendToOthers(data, creature) {
        if (data?.__relationActor) {
            const recipients = typeof World.fetchVisibleRealPlayers === 'function' ? World.fetchVisibleRealPlayers(this, creature) : World.fetchVisibleUsers(this, creature);
            recipients.forEach(user => user.dataSendToMe(data));
            return;
        }
        const packet = this.packData(data);
        if (!packet) return; // longer than a frame: not sent (counted, Frame.pack)
        const visibleUsers = typeof World.fetchVisibleRealPlayers === 'function'
            ? World.fetchVisibleRealPlayers(this, creature)
            : World.fetchVisibleUsers(this, creature);
        visibleUsers.forEach((user) => {
            if (data?.__movingActor) invoke('GameServer/World/CharacterVisibility').beforeSend(user, data);
            NpcVisibility.trackNpcPacket(user, data);
            if (user.recordOutboundPacket) {
                user.recordOutboundPacket(data);
            }
            user.socket.write(packet);
            if (data?.__characterActor && user.actor && invoke('GameServer/Clan/ClanWarRuntime').between(user.actor, data.__characterActor).status !== 'neutral') {
                user.dataSendToMe(invoke('GameServer/Network/Response').relationChanged(data.__characterActor, user.actor));
            }
            GroundItemVisibility.trackPacket(user, data);
            NpcVisibility.sendNpcMotionAfterInfo(user, data);
            if (data?.__characterActor || data?.[0] === 0x12) invoke('GameServer/World/CharacterVisibility').afterSend(user, data);
        });
    }

    dataSendToMeAndOthers(data, creature) {
        this.dataSendToMe(data);
        this.dataSendToOthers(data, creature);
    }

    // The framed packet, or null when it is longer than a frame (Frame.pack).
    packData(data) {
        return Frame.pack(data);
    }

    tracePacket(direction, data, name) {
        if (!(invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) || process.env.L2NODE_PACKET_TRACE === '0') {
            return;
        }

        this.packetTrace ||= [];
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
        if (!(invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) || process.env.L2NODE_PACKET_TRACE === '0') return;
        const opcode = packetOpcode(data);
        const name = serverPacketName(opcode, opcode === 0xfe && data.length > 2 ? data.readUInt16LE(1) : undefined);
        this.tracePacket('out', data, name);

        if (!MOVEMENT_PACKET_OPCODES.has(opcode)) return;
        this.movementPacketTrace ||= [];
        this.movementPacketTrace.push({
            at: new Date().toISOString(),
            opcode,
            name,
            length: utils.size(data),
            detail: data && data.__packetTrace ? data.__packetTrace : ''
        });
        if (this.movementPacketTrace.length > MOVEMENT_TRACE_LIMIT) {
            this.movementPacketTrace.shift();
        }
    }

    traceLabel() {
        const actorName = this.actor && this.actor.fetchName ? this.actor.fetchName() : null;
        const accountId = this.accountId || 'anonymous';
        return actorName ? `${actorName}/${accountId}` : accountId;
    }

    dumpPacketTrace() {
        if (!(invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) || process.env.L2NODE_PACKET_TRACE === '0') return;
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
        invoke('GameServer/World/Generics/NativeUiSession').reset(this);
        if (err) {
            utils.infoWarn('GameServer', 'exception: ' + (err.stack || err.message || err));
            this.dumpPacketTrace();
        } else {
            utils.infoWarn('GameServer', 'connection closed');
        }
        if (this.actor) {
            invoke('GameServer/World/ArenaDuelService').release(this, 'disconnect');
            invoke('GameServer/Bot/BotTradeService').cleanup(this, 'disconnect');
            // Companion social events are persisted asynchronously. Preserve
            // the identity before the actor is destroyed so a normal network
            // disconnect cannot overwrite the remembered player name.
            this.characterId = this.characterId || this.actor.fetchId?.();
            this.characterName = this.characterName || this.actor.fetchName?.();
            this.persistCharacterStatus({ currentOnly: true });
            invoke('GameServer/Effects/EffectTicker').clearAll(this.actor);
            const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
            PartyCompanionService.detachAll(this, {
                // A connection close is not the player dismissing companions.
                // It must not lower trust or trigger the abandonment cooldown.
                event: 'party_disconnected',
                source: 'leader_disconnect',
                message: 'My companion disconnected. Returning to hunt.',
                rebuildWindow: false,
                refreshPanel: false
            });
            this.actor.destructor();
            this.actor = null;
        }
        World.removeUser(this);
    }
}

module.exports = Session;
// A written packet's name from the trace table (src/Perf/PlayerClient reads what a player was sent).
module.exports.serverPacketName = serverPacketName;
module.exports.SERVER_PACKET_NAMES = SERVER_PACKET_NAMES;
module.exports.EXTENDED_SERVER_PACKET_NAMES = EXTENDED_SERVER_PACKET_NAMES;
