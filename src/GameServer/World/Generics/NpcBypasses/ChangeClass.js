const ServerResponse = invoke('GameServer/Network/Response');
const ClassTransfer = invoke('GameServer/ClassTransfer');

function html(session, body) {
    session.dataSendToMe(ServerResponse.npcHtml(7070, body));
}

module.exports = async function changeClass(session, parts) {
    const targetClassId = Number(parts[1]);
    if (!Number.isFinite(targetClassId)) return;

    // Keep ordinary bypass rejections immediate. NpcTalkResponse deliberately
    // does not await handlers, while the actual persisted transfer remains
    // asynchronous below.
    const preflight = ClassTransfer.eligibility(session?.actor, targetClassId);
    if (!preflight.ok) {
        if (preflight.reason === 'wrong_profession') {
            html(session, '<html><body>Gatekeeper Sylvain:<br>This class transfer is not available for your current profession.</body></html>');
        }
        return preflight;
    }
    if (Number(session.actor.fetchLevel()) < preflight.requiredLevel) {
        html(session, `<html><body>Gatekeeper Sylvain:<br>You must be at least level <font color="LEVEL">${preflight.requiredLevel}</font> to perform this class transfer.</body></html>`);
        return { ok: false, reason: 'level', requiredLevel: preflight.requiredLevel };
    }

    const result = await ClassTransfer.transfer(session, targetClassId);
    if (!result.ok) {
        if (result.reason === 'level') {
            html(session, `<html><body>Gatekeeper Sylvain:<br>You must be at least level <font color="LEVEL">${result.requiredLevel}</font> to perform this class transfer.</body></html>`);
        } else if (result.reason === 'wrong_profession') {
            html(session, '<html><body>Gatekeeper Sylvain:<br>This class transfer is not available for your current profession.</body></html>');
        } else if (result.reason === 'persistence') {
            html(session, '<html><body>Gatekeeper Sylvain:<br>The class transfer could not be completed. Your previous profession was restored.</body></html>');
        }
        return result;
    }

    const className = parts.slice(2).join(' ') || 'new profession';
    html(session, `<html><body>Gatekeeper Sylvain:<br>Congratulations! You have successfully advanced your path and became a <font color="LEVEL">${className}</font>!<br><br><a action="bypass -h html 7070">Return</a></body></html>`);
    return result;
};

module.exports.statusParams = ClassTransfer.statusParams;
