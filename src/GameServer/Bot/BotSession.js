const Actor = invoke('GameServer/Actor/Actor');
const World = invoke('GameServer/World/World');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');
const GroundItemVisibility = invoke('GameServer/World/GroundItemVisibility');

class BotSession {
    constructor(username) {
        this.accountId = username;
        this.botSession = true;
        this.socket = {
            write: () => {},
            resetAndDestroy: () => {}
        };
    }

    setActor(properties) {
        World.retireUserActor(this, this.actor);
        this.actor = new Actor(this, properties);
        World.updateUserLocation(this, this.actor);
    }

    fetchAccountId() {
        return this.accountId;
    }

    dataSendToMe(data) {
        // Bots operate internally; no real socket client packets to receive
    }

    dataSendToOthers(data, creature) {
        if (this.populationStaging) return;
        const visibleUsers = typeof World.fetchVisibleRealPlayers === 'function'
            ? World.fetchVisibleRealPlayers(this, creature)
            : World.fetchVisibleUsers(this, creature);
        const recipients = visibleUsers.filter((user) => (
            user.socket &&
            typeof user.socket.write === 'function' &&
            user.accountId !== this.accountId &&
            !String(user.accountId).startsWith('bot_')
        ));
        const HotActorLodPolicy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
        if (!recipients.length) {
            HotActorLodPolicy.recordPacketBroadcast(0, data?.length || 0);
            return;
        }
        if (data?.__relationActor) {
            recipients.forEach(user => user.dataSendToMe
                ? user.dataSendToMe(data)
                : user.socket.write(this.packData(invoke('GameServer/Network/Response').relationChanged(data.__relationActor, user.actor))));
            HotActorLodPolicy.recordPacketBroadcast(recipients.length, data.length);
            return;
        }
        const packet = this.packData(data);
        recipients.forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function') {
                if (data?.__movingActor) invoke('GameServer/World/CharacterVisibility').beforeSend(user, data);
                NpcVisibility.trackNpcPacket(user, data);
                if (user.recordOutboundPacket) {
                    user.recordOutboundPacket(data);
                }
                user.socket.write(packet);
                if (data?.__characterActor && user.actor && user.dataSendToMe
                    && invoke('GameServer/Clan/ClanWarRuntime').between(user.actor, data.__characterActor).status !== 'neutral') {
                    user.dataSendToMe(invoke('GameServer/Network/Response').relationChanged(data.__characterActor, user.actor));
                }
                GroundItemVisibility.trackPacket(user, data);
                NpcVisibility.sendNpcMotionAfterInfo(user, data);
                if (data?.__characterActor || data?.[0] === 0x12) invoke('GameServer/World/CharacterVisibility').afterSend(user, data);
            }
        });
        HotActorLodPolicy.recordPacketBroadcast(recipients.length, packet.length);
    }

    dataSendToMeAndOthers(data, creature) {
        this.dataSendToOthers(data, creature);
    }

    packData(data) {
        const header = Buffer.alloc(2);
        header.writeInt16LE(utils.size(data) + 2);
        return Buffer.concat([header, data]);
    }

    error() {
        // Silent error handler
    }
}

module.exports = BotSession;
