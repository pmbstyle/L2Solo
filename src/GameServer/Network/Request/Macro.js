const ReceivePacket  = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');

const MAX_MACROS = 24;
const MAX_COMMANDS = 12;
const MAX_DESCRIPTION_LENGTH = 32;
const MAX_COMMAND_LENGTH = 255;
const COMMAND_TYPES = new Set([1, 3, 4]);

function sendMacros(session, macros) {
    const revision = (session.macroRevision || 0) + 1;
    session.macroRevision = revision;
    ServerResponse.macroList(macros, revision).forEach((packet) => session.dataSendToMe(packet));
}

function readMacro(buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readD().readS().readS().readS().readC().readC();
    const [id, name, descr, acronym, icon, count] = packet.data;

    if (count > MAX_COMMANDS) return null;

    const commands = [];
    for (let index = 0; index < count; index++) {
        packet.readC().readC().readD().readC().readS();
        const [entry, type, d1, d2, command] = packet.data.slice(-5);
        commands.push({ entry, type, d1, d2, command });
    }

    return { id, name, descr, acronym, icon, commands };
}

function validMacro(macro) {
    return macro && Number.isInteger(macro.id) && macro.id >= 0 &&
        typeof macro.name === 'string' && macro.name.length > 0 &&
        typeof macro.descr === 'string' && macro.descr.length <= MAX_DESCRIPTION_LENGTH &&
        typeof macro.acronym === 'string' &&
        macro.commands.every((command) => COMMAND_TYPES.has(command.type) && typeof command.command === 'string' && command.command.length <= MAX_COMMAND_LENGTH) &&
        macro.commands.reduce((length, command) => length + command.command.length, 0) <= MAX_COMMAND_LENGTH;
}

function nextMacroId(macros) {
    return Math.max(999, ...macros.map((macro) => macro.id)) + 1;
}

function createOrUpdate(session, buffer) {
    const macro = readMacro(buffer);
    if (!validMacro(macro)) return;

    const characterId = session.actor.fetchId();
    Database.fetchMacros(characterId).then((macros) => {
        const exists = macros.some((stored) => stored.id === macro.id);
        if (!exists && macros.length >= MAX_MACROS) return;

        macro.id = macro.id || nextMacroId(macros);
        return Database.setMacro(characterId, macro).then(() => {
            const updated = macros.filter((stored) => stored.id !== macro.id);
            updated.push(macro);
            sendMacros(session, updated);
        });
    }).catch((error) => utils.infoWarn('Macro', 'failed to store macro: %s', error.message));
}

function remove(session, buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readD();
    const macroId = packet.data[0];
    const characterId = session.actor.fetchId();

    Database.deleteMacro(characterId, macroId)
        .then(() => Database.deleteMacroShortcuts(characterId, macroId))
        .then(() => Database.fetchMacros(characterId))
        .then((macros) => sendMacros(session, macros))
        .catch((error) => utils.infoWarn('Macro', 'failed to delete macro: %s', error.message));
}

function macro(session, buffer) {
    if (buffer[0] === 0xc1) createOrUpdate(session, buffer);
    else if (buffer[0] === 0xc2) remove(session, buffer);
}

module.exports = macro;
