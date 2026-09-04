const NpcObjectIndex = require('../NpcObjectIndex');

function fetchNpc(id) {
    return new Promise((success, fail) => {
        const npc = NpcObjectIndex.find(this, id);
        return npc ? success(npc) : fail();
    });
}

module.exports = fetchNpc;
