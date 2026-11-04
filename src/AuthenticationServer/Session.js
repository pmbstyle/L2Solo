const ServerResponse = invoke('AuthenticationServer/Network/Response');
const Opcodes        = invoke('AuthenticationServer/Network/Opcodes');
const Frame          = invoke('Packet/Frame');

class Session {
    constructor(socket) {
        const optn = options.default.AuthServer;

        this.socket    = socket;
        this.sessionId = utils.randomNumber(0x80000000);
        this.key1      = utils.randomNumber(0x80000000);
        this.key2      = utils.randomNumber(0x80000000);
        this.protocol  = optn.protocol;
        this.blowfish  = optn.blowfishKey + '\u0000';

        // First handshake from `Server` to `Client`
        this.dataSend(
            ServerResponse.initLS(this.sessionId, this.protocol), false
        );
    }

    setAccountId(username) {
        this.accountId = username;
    }

    dataReceive(data) {
        const packet = Frame.body(data);
        const decipheredPacket = require('blowfish-ecb').decipher(this.blowfish, packet);
        return Opcodes.table[decipheredPacket[0]](this, decipheredPacket);
    }

    dataSend(data, encipher = true) {
        const encipheredPacket = encipher ? require('blowfish-ecb').encipher(this.blowfish, data) : data;
        const frame = Frame.pack(encipheredPacket);
        if (frame) this.socket.write(frame); // null: longer than a frame, not sent (counted)
    }

    error(err) {
        utils.infoWarn('AuthServer', 'exception: ' + (err ? err.stack || err.message || err : 'unknown socket error'));
    }
}

module.exports = Session;
