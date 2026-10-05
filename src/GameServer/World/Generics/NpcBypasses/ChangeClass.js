const ServerResponse = invoke('GameServer/Network/Response');
const ClassTransfer = invoke('GameServer/ClassTransfer');

const RACES = new Set(['human', 'elven', 'darkelven', 'orcdwarf']);
const DEFAULT_PRIEST = 7070;

function npcObjectId(session) {
    return Number(session?.activeNpcTalk?.objectId) || DEFAULT_PRIEST;
}

function priestSelfId(session) {
    return Number(session?.activeNpcTalk?.selfId) || DEFAULT_PRIEST;
}

function html(session, body) {
    session.dataSendToMe(ServerResponse.npcHtml(npcObjectId(session), body));
}

// Temple priests render their own data/Html/<selfId>.html; race menus are
// shared pages so the ritual text never repeats per priest.
function showFile(session, filename) {
    if (!utils.fileExists(filename)) {
        utils.infoWarn('GameServer', 'html file "%s" does not exist', filename);
        return;
    }
    html(session, utils.parseRawFile(filename));
    session.dataSendToMe(ServerResponse.actionFailed());
}

module.exports = async function changeClass(session, parts) {
    if (parts[1] === 'menu' && RACES.has(parts[2])) {
        showFile(session, `data/Html/Gatekeeper/class-transfer-${parts[2]}.html`);
        return;
    }
    if (parts[1] === 'main') {
        showFile(session, `data/Html/${priestSelfId(session)}.html`);
        return;
    }

    const targetClassId = Number(parts[1]);
    if (!Number.isFinite(targetClassId)) return;

    // Keep ordinary bypass rejections immediate. NpcTalkResponse deliberately
    // does not await handlers, while the actual persisted transfer remains
    // asynchronous below.
    const preflight = ClassTransfer.eligibility(session?.actor, targetClassId);
    if (!preflight.ok) {
        if (preflight.reason === 'wrong_profession') {
            html(session, '<html><body>Class Transfer:<br>This class transfer is not available for your current profession.</body></html>');
        }
        return preflight;
    }
    if (Number(session.actor.fetchLevel()) < preflight.requiredLevel) {
        html(session, `<html><body>Class Transfer:<br>You must be at least level <font color="LEVEL">${preflight.requiredLevel}</font> to perform this class transfer.</body></html>`);
        return { ok: false, reason: 'level', requiredLevel: preflight.requiredLevel };
    }

    // Both entry points share the character's quest queue so a simultaneous
    // level-only transfer cannot race a hand-in of the three trial marks.
    const result = await invoke('GameServer/Quest/QuestService').mutate(session,
        () => ClassTransfer.transfer(session, targetClassId));
    if (!result.ok) {
        if (result.reason === 'level') {
            html(session, `<html><body>Class Transfer:<br>You must be at least level <font color="LEVEL">${result.requiredLevel}</font> to perform this class transfer.</body></html>`);
        } else if (result.reason === 'wrong_profession') {
            html(session, '<html><body>Class Transfer:<br>This class transfer is not available for your current profession.</body></html>');
        } else if (result.reason === 'persistence') {
            html(session, '<html><body>Class Transfer:<br>The class transfer could not be completed. Your previous profession was restored.</body></html>');
        }
        return result;
    }

    const className = parts.slice(2).join(' ') || 'new profession';
    html(session, `<html><body>Class Transfer:<br>Congratulations! You have successfully advanced your path and became a <font color="LEVEL">${className}</font>!<br><br><a action="bypass -h change-class main">Return</a></body></html>`);
    return result;
};

module.exports.statusParams = ClassTransfer.statusParams;
