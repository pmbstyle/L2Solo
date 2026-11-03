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
        socket.on('data', packetReceiver((packet) => {
            // One TCP chunk can carry several packets. Once a handler error
            // has closed the connection, the rest of that chunk belongs to a
            // client we already dropped.
            if (socket.destroyed) return undefined;

            // A throwing handler used to take the whole process with it, so a
            // malformed packet only ever costs the connection that sent it.
            // A handler that fails later, through the Promise it returns, is
            // dropped the same way, not left to the process backstop
            // (NodeL2), which only counts it while the client stays on a
            // half-handled packet.
            const drop = (err) => {
                utils.infoWarn(this.name, 'dropped a packet from %s:%d: %s', socket.remoteAddress, socket.remotePort, err?.stack || err?.message || err);
                socket.destroy();
            };
            try {
                const result = session.dataReceive(packet);
                if (result && typeof result.then === 'function') result.then(null, drop);
                return result;
            } catch (err) {
                drop(err);
            }
        }, (packetSize) => {
            utils.infoWarn(this.name, 'invalid packet size %d from %s:%d', packetSize, socket.remoteAddress, socket.remotePort);
            socket.destroy();
        }));
        socket.on('error', session.error.bind(session));
        socket.on('close', () => session.error());
    }
}

module.exports = Server;
module.exports.packetReceiver = packetReceiver;
