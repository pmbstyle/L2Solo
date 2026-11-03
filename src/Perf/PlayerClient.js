'use strict';

// A scripted client of one player Session (src/Perf/HotCrowd): sends the client's packets through
// session.dataReceive, the path a real client's packets take (Network/Opcodes, the request handlers),
// and reads what the server wrote to the player's socket. No client is needed and nothing on the
// server is called directly: a step is a packet, an expectation is a packet back or a state.

const SendPacket = invoke('Packet/Send');

// What the server wrote: packet name (Session's trace table), opcode, time, the packed bytes.
const KEEP = 3000;

class PlayerClient {
    constructor(session) {
        this.session = session;
        this.received = [];
        this.waiters = new Set();
        const Session = invoke('GameServer/Session');
        const socket = session.socket;
        const write = socket.write.bind(socket);
        socket.write = (buffer) => {
            const opcode = buffer?.[2] ?? -1;
            // Named by the Network/Response file that sends it; one without a name goes by its opcode.
            const named = Session.serverPacketName(opcode, opcode === 0xfe && buffer.length > 4 ? buffer.readUInt16LE(3) : undefined);
            const entry = { name: named === 'Unknown' ? `0x${opcode.toString(16).padStart(2, '0')}` : named, opcode, at: Date.now(), buffer };
            this.received.push(entry);
            if (this.received.length > KEEP) this.received.shift();
            for (const waiter of [...this.waiters]) waiter(entry);
            return write(buffer);
        };
    }

    get actor() { return this.session.actor; }

    loc() {
        const a = this.actor;
        return { locX: a.fetchLocX(), locY: a.fetchLocY(), locZ: a.fetchLocZ() };
    }

    // One client packet: [length][opcode][fields], as packetReceiver hands it to dataReceive.
    send(packet) {
        const body = packet.buffer;
        const frame = Buffer.alloc(body.length + 2);
        frame.writeInt16LE(body.length + 2, 0);
        body.copy(frame, 2);
        return Promise.resolve(this.session.dataReceive(frame));
    }

    // 0x01 MoveToLocation: destination, then where the client is.
    walk(to) {
        const from = this.loc();
        return this.send(new SendPacket(0x01).writeD(to.locX).writeD(to.locY).writeD(to.locZ)
            .writeD(from.locX).writeD(from.locY).writeD(from.locZ));
    }

    // 0x04 Action: click an object (first click targets, the second on the target interacts).
    action(objectId, shift = false) {
        const at = this.loc();
        return this.send(new SendPacket(0x04).writeD(objectId).writeD(at.locX).writeD(at.locY).writeD(at.locZ).writeC(shift ? 1 : 0));
    }

    // 0x0a Attack.
    attack(objectId, shift = false) {
        const at = this.loc();
        return this.send(new SendPacket(0x0a).writeD(objectId).writeD(at.locX).writeD(at.locY).writeD(at.locZ).writeC(shift ? 1 : 0));
    }

    // 0x38 Say: text and chat kind (0 all, 1 shout, 2 tell with the target's name, 3 party, ...).
    say(text, kind = 0, target = null) {
        const packet = new SendPacket(0x38).writeS(String(text)).writeD(kind);
        if (kind === 2) packet.writeS(String(target || ''));
        return this.send(packet);
    }

    // 0x29 AskForTeamUp: invite by name.
    invite(name, distribution = 0) {
        return this.send(new SendPacket(0x29).writeS(String(name)).writeD(distribution));
    }

    // 0x21 HtmlLink: a bypass the player clicked in an NPC window (the text after "bypass -h ").
    bypass(command) {
        return this.send(new SendPacket(0x21).writeS(String(command)));
    }

    // The next server packet named `name` (written from `since` on), or a timeout.
    packet(name, { since = 0, timeoutMs = 10000, match = () => true } = {}) {
        const found = this.received.find(entry => entry.at >= since && entry.name === name && match(entry));
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new Error(`no ${name} from the server in ${timeoutMs} ms`));
            }, timeoutMs);
            const waiter = (entry) => {
                if (entry.at < since || entry.name !== name || !match(entry)) return;
                clearTimeout(timer);
                this.waiters.delete(waiter);
                resolve(entry);
            };
            this.waiters.add(waiter);
        });
    }

    // Names of what the server wrote since a time, in order: the context of a failed step.
    namesSince(since, limit = 40) {
        return this.received.filter(entry => entry.at >= since).slice(-limit).map(entry => entry.name);
    }
}

// The HTML of an NpcHtml packet (0x0f: object id, then the text as UTF-16, null-terminated).
function npcHtml(entry) {
    const buffer = entry.buffer;
    let end = 7;
    while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) end += 2;
    return { npcId: buffer.readInt32LE(3), html: buffer.toString('ucs2', 7, end) };
}

// Whether a packet carries a text (strings go as UTF-16): a chat line, a system text.
function carries(entry, text) {
    return entry.buffer.includes(Buffer.from(String(text), 'ucs2'));
}

// The commands of an NPC window's links ("bypass -h <command>").
function bypasses(html) {
    return [...String(html).matchAll(/bypass\s+(?:-h\s+)?([^"]+)"/g)].map(match => match[1].trim());
}

// A condition that holds within the time: the expectation for whatever bot AI does when it will.
async function within(timeoutMs, condition, { everyMs = 250, what = 'condition' } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await condition();
        if (value) return value;
        if (Date.now() >= end) throw new Error(`${what} did not hold within ${timeoutMs} ms`);
        await new Promise(resolve => setTimeout(resolve, everyMs));
    }
}

module.exports = { PlayerClient, npcHtml, bypasses, carries, within };
