const Database = invoke('Database');
const CalculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ServerResponse = invoke('GameServer/Network/Response');

module.exports = function(session, parts) {
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
        session.dataSendToMe(ServerResponse.htmlPacket(7070, `<html><body>Gatekeeper Sylvain:<br>This class transfer is not available for your current profession.</body></html>`));
        return;
    }

    if (currentLevel < requiredLevel) {
        session.dataSendToMe(ServerResponse.htmlPacket(7070, `<html><body>Gatekeeper Sylvain:<br>You must be at least level <font color="LEVEL">${requiredLevel}</font> to perform this class transfer. You are currently level ${currentLevel}.</body></html>`));
        return;
    }

    // Execute class change
    actor.setClassId(targetClassId);
    
    Database.updateCharacterClassId(actor.fetchId(), targetClassId).then(() => {
        actor.skillset.awardSkills(actor.fetchId(), targetClassId, currentLevel).then(() => {
            CalculateStats(session, actor);
            actor.fillupVitals();

            // Send social effect (Social ID 15 is Level Up, very shiny and appropriate)
            session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 15), actor);
            
            // Notify
            const className = parts.slice(2).join(' ') || 'new profession';
            const html = `<html><body>Gatekeeper Sylvain:<br>Congratulations! You have successfully advanced your path and became a <font color="LEVEL">${className}</font>!<br><br><a action="bypass -h html 7070">Return</a></body></html>`;
            session.dataSendToMe(ServerResponse.htmlPacket(7070, html));
        });
    }).catch((err) => {
        console.error("Database class change error:", err);
    });
};
