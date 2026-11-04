'use strict';

// The 2-byte length in front of every L2 packet (game and login server, both
// ways). The length counts itself and is unsigned: a frame is 2..65535 bytes.
// A packet that does not fit is refused with a counted reason, never cut.
// Callers: GameServer/Session, AuthenticationServer/Session (both ways),
// Bot/BotSession (out), Perf/PlayerClient (a scripted client's packets);
// Server.packetReceiver splits the stream on the same length. Packet/Receive
// counts a string without its terminator here too.
const HEADER_SIZE = 2;
const MAX_FRAME = 0xffff;

// Since start, on the status line (PopulationStatus.packetRefusedText).
const refused = { inbound: 0, outbound: 0, unterminated: 0 };
const loggedOpcodes = new Set();

function refusal(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// The packet inside an inbound frame. A length below the header or past the
// frame fails the packet (the connection drops it, Server.onSocket).
function body(frame) {
    const size = frame.length >= HEADER_SIZE ? frame.readUInt16LE(0) : 0;
    if (size < HEADER_SIZE || size > frame.length) {
        refused.inbound += 1;
        throw refusal(`packet frame of ${size} B in ${frame.length} B`, 'PACKET_FRAME_SIZE');
    }
    return frame.subarray(HEADER_SIZE, size);
}

// The frame for an outbound packet, or null when it is longer than a frame
// can say: the packet is not sent (the first per opcode logged). Not a throw:
// many sends run in timers, where a throw ends the process.
function pack(data) {
    const size = data.length + HEADER_SIZE;
    if (size > MAX_FRAME) {
        refused.outbound += 1;
        const opcode = data[0];
        if (!loggedOpcodes.has(opcode)) {
            loggedOpcodes.add(opcode);
            utils.infoWarn('Packet', 'packet 0x%s of %d B is over the %d B frame: not sent (first for this opcode)',
                Number(opcode).toString(16), size, MAX_FRAME);
        }
        return null;
    }
    const frame = Buffer.allocUnsafe(size);
    frame.writeUInt16LE(size, 0);
    (Buffer.isBuffer(data) ? data : Buffer.from(data)).copy(frame, HEADER_SIZE);
    return frame;
}

// A string field with no terminator before the end of the packet: the packet
// fails instead of shifting every later field.
function unterminated(offset) {
    refused.unterminated += 1;
    return refusal(`string at ${offset} has no terminator`, 'PACKET_STRING_UNTERMINATED');
}

function refusals() {
    return { ...refused };
}

module.exports = { HEADER_SIZE, MAX_FRAME, body, pack, unterminated, refusals };
