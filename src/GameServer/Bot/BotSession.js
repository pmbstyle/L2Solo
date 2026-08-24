const Actor = invoke('GameServer/Actor/Actor');
const World = invoke('GameServer/World/World');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');

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
        this.actor = new Actor(this, properties);
    }

    fetchAccountId() {
        return this.accountId;
    }

    dataSendToMe(data) {
        // Bots operate internally; no real socket client packets to receive
    }

    dataSendToOthers(data, creature) {
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
        const packet = this.packData(data);
        recipients.forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function') {
                NpcVisibility.trackNpcPacket(user, data);
                if (user.recordOutboundPacket) {
                    user.recordOutboundPacket(data);
                }
                user.socket.write(packet);
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
