const assert = require('assert');
const fs = require('fs');
const path = require('path');

const npcs = require('../data/Npcs/npcs.json');
const spawns = require('../data/Npcs/Spawns/spawns.json');
const helperIds = npcs
    .filter((npc) => npc.template?.name === 'Newbie Helper')
    .map((npc) => npc.selfId)
    .sort((left, right) => left - right);

assert.deepStrictEqual(helperIds, [7009, 7019, 7131, 7400, 7530, 7575],
    'all six racial starting-zone Newbie Helpers must remain covered');

const spawnedIds = new Set(spawns.flatMap((group) => group.spawns || []).map((spawn) => spawn.selfId));
for (const selfId of helperIds) {
    assert(spawnedIds.has(selfId), `Newbie Helper ${selfId} must be spawned in its racial starting zone`);

    const html = fs.readFileSync(path.join(__dirname, '..', 'data', 'Html', `${selfId}.html`), 'utf8');
    for (const buff of ['windwalk', 'shield', 'haste']) {
        assert(html.includes(`newbie_buff ${buff}`), `Newbie Helper ${selfId} must offer ${buff}`);
    }
    assert(html.includes('newbie_buff heal'), `Newbie Helper ${selfId} must offer recovery`);
}
