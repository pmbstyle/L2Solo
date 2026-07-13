const Database = invoke('Database');
const CalculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ServerResponse = invoke('GameServer/Network/Response');

function html(session, body) {
    session.dataSendToMe(ServerResponse.npcHtml(7070, body));
}

function statusParams(actor) {
    const d = (value) => Math.round(Number(value) || 0);

    return [
        { id: 0x01, value: d(actor.fetchLevel()) },
        { id: 0x09, value: d(actor.fetchHp()) },
        { id: 0x0a, value: d(actor.fetchMaxHp()) },
        { id: 0x0b, value: d(actor.fetchMp()) },
        { id: 0x0c, value: d(actor.fetchMaxMp()) },
        { id: 0x11, value: d(actor.fetchCollectivePAtk()) },
        { id: 0x12, value: d(actor.fetchCollectiveAtkSpd()) },
        { id: 0x13, value: d(actor.fetchCollectivePDef()) },
        { id: 0x14, value: d(actor.fetchCollectiveEvasion()) },
        { id: 0x15, value: d(actor.fetchCollectiveAccur()) },
        { id: 0x16, value: d(actor.fetchCollectiveCritical()) },
        { id: 0x17, value: d(actor.fetchCollectiveMAtk()) },
        { id: 0x18, value: d(actor.fetchCollectiveCastSpd()) },
        { id: 0x19, value: d(actor.fetchCollectiveMDef()) }
    ];
}

module.exports = async function(session, parts) {
    const actor = session.actor;
    if (!actor || actor.isDead()) return;

    const targetClassId = Number(parts[1]);
    if (isNaN(targetClassId)) return;

    const currentClassId = actor.fetchClassId();
    const currentLevel = actor.fetchLevel();

    // Define transition mappings
    const firstProfMap = {
        0: [1, 4, 7],
        10: [11, 15],
        18: [19, 22],
        25: [26, 29],
        31: [32, 35],
        38: [39, 42],
        44: [45, 47],
        49: [50],
        53: [54, 56]
    };

    const secondProfMap = {
        1: [2, 3],
        4: [5, 6],
        7: [8, 9],
        11: [12, 13, 14],
        15: [16, 17],
        19: [20, 21],
        22: [23, 24],
        26: [27, 28],
        29: [30],
        32: [33, 34],
        35: [36, 37],
        39: [40, 41],
        42: [43],
        45: [46],
        47: [48],
        50: [51, 52],
        54: [55],
        56: [57]
    };

    let isAllowed = false;
    let requiredLevel = 20;

    if (firstProfMap[currentClassId] && firstProfMap[currentClassId].includes(targetClassId)) {
        isAllowed = true;
        requiredLevel = 20;
    } else if (secondProfMap[currentClassId] && secondProfMap[currentClassId].includes(targetClassId)) {
        isAllowed = true;
        requiredLevel = 40;
    }

    if (!isAllowed) {
        html(session, `<html><body>Gatekeeper Sylvain:<br>This class transfer is not available for your current profession.</body></html>`);
        return;
    }

    if (currentLevel < requiredLevel) {
        html(session, `<html><body>Gatekeeper Sylvain:<br>You must be at least level <font color="LEVEL">${requiredLevel}</font> to perform this class transfer. You are currently level ${currentLevel}.</body></html>`);
        return;
    }

    // Execute class change
    actor.setClassId(targetClassId);

    try {
        await Database.updateCharacterClassId(actor.fetchId(), targetClassId);
        await actor.skillset.awardSkills(actor.fetchId(), targetClassId, currentLevel);
        CalculateStats(session, actor);
        actor.fillupVitals();

        // Send social effect (Social ID 15 is Level Up, very shiny and appropriate)
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 15), actor);
        session.dataSendToMe(ServerResponse.skillsList(actor.skillset.fetchSkills()));
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.statusUpdate(actor.fetchId(), statusParams(actor)));
        session.dataSendToOthers(ServerResponse.charInfo(actor), actor);

        // Notify
        const className = parts.slice(2).join(' ') || 'new profession';
        const html = `<html><body>Gatekeeper Sylvain:<br>Congratulations! You have successfully advanced your path and became a <font color="LEVEL">${className}</font>!<br><br><a action="bypass -h html 7070">Return</a></body></html>`;
        session.dataSendToMe(ServerResponse.npcHtml(7070, html));
    } catch (err) {
        actor.setClassId(currentClassId);
        await Database.updateCharacterClassId(actor.fetchId(), currentClassId).catch(() => {});
        utils.infoWarn('Character', 'class change failed for %s: %s', actor.fetchName(), err.message);
        html(session, '<html><body>Gatekeeper Sylvain:<br>The class transfer could not be completed. Your previous profession was restored.</body></html>');
    }
};

module.exports.statusParams = statusParams;
