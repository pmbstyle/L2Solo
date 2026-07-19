const HEADER_SIZE = 2;

function packetReceiver(onPacket, onInvalidPacket = () => {}) {
    let pending = Buffer.alloc(0);

    return (chunk) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

        while (pending.length >= HEADER_SIZE) {
            const packetSize = pending.readUInt16LE(0);
            if (packetSize < HEADER_SIZE) {
                onInvalidPacket(packetSize);
                pending = Buffer.alloc(0);
                return;
            }

            if (pending.length < packetSize) {
                return;
            }

            const packet = pending.subarray(0, packetSize);
            pending = pending.subarray(packetSize);
            onPacket(packet);
        }
    };
}

class Server {
    constructor(name, optn, callback) {
        const parameters = { name: name, callback: callback };

        // Create a new listening `Server`
        require('net').createServer(this.onSocket.bind(parameters)).listen(optn.port, optn.hostname, () => {
            utils.infoSuccess(name, 'successful init for %s:%d', optn.hostname, optn.port);
        });
    }

    onSocket(socket) {
        utils.infoSuccess(
            this.name, 'new connection received from %s:%d', socket.remoteAddress, socket.remotePort
        );

        // Generates a new `Session` for the respective `Server`. Either `AuthSession` or `GameSession`
        const session = this.callback(socket);
        socket.on('data', packetReceiver(
            session.dataReceive.bind(session),
            (packetSize) => {
                utils.infoWarn(this.name, 'invalid packet size %d from %s:%d', packetSize, socket.remoteAddress, socket.remotePort);
                socket.destroy();
            }
        ));
        socket.on('error', session.error.bind(session));
        socket.on('close', () => session.error());
    }
}

module.exports = Server;
module.exports.packetReceiver = packetReceiver;
