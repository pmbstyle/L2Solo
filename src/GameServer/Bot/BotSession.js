const Actor = invoke('GameServer/Actor/Actor');
const World = invoke('GameServer/World/World');

class BotSession {
    constructor(username) {
        this.accountId = username;
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
        const packet = this.packData(data);
        World.fetchVisibleUsers(this, creature).forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function' && user.accountId !== this.accountId) {
                if (user.recordOutboundPacket) {
                    user.recordOutboundPacket(data);
                }
                user.socket.write(packet);
            }
        });
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
