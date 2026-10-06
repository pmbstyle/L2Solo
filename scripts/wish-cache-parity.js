'use strict';
// Read a fixed world save without opening the game's database writer.
// Usage: L2NODE_CONFIG_FILE=config/default.ini node scripts/wish-cache-parity.js <save.sqlite> [300]
require('../src/Global');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
invoke('GameServer/DataCache').init();
const board = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
Economy.configure({ board: () => board, spots: () => spots });
const json = raw => JSON.parse(raw || '{}');
const rows = db.prepare('SELECT * FROM bot_life_state ORDER BY characterId LIMIT ?').all(Number(process.argv[3] || 300));
const decisions = rows.map(row => {
    const state = { characterId: row.characterId, name: row.characterName, level: row.level, exp: row.exp,
        sp: row.sp, adena: row.adena, phase: row.phase, activity: row.activity, currentRegion: row.currentRegion,
        spotId: row.spotId, loc: { locX: row.locX, locY: row.locY, locZ: row.locZ },
        vitals: { hp: row.hp, maxHp: row.maxHp, mp: row.mp, maxMp: row.maxMp }, timing: {},
        party: { partyId: row.partyId }, stats: json(row.statsJson), inventory: json(row.inventorySummary) };
    const network = Economy.forState(state, { timestamp: 1e12 }).network;
    return { id: row.characterId, queue: network.queue.map(wish => [wish.key, wish.price, wish.funded]), focus: network.focus };
});
console.log(JSON.stringify({ bots: decisions.length,
    digest: crypto.createHash('sha256').update(JSON.stringify(decisions)).digest('hex'), decisions }));
db.close();
process.exit(0);
