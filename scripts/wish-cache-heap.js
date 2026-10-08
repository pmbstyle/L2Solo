// Memory the wish review keeps per bot, split by layer, on real bot states from a world save (read-only).
//  - context cache (layer B, LRU 64 per thread) and the per-build gains store (layer A) measured apart.
// Run from the repo root: L2NODE_CONFIG_FILE=config/default.ini node --expose-gc <this> <world save database.sqlite> [bots=400]
require('../src/Global');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const N = Number(process.argv[3] || 400);
const json = raw => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };
invoke('GameServer/DataCache').init();
const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex; const board = new Board();
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const Econ = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
Econ.configure({ board: () => board, spots: () => spots });
const rows = db.prepare(`SELECT l.* FROM bot_life_state l ORDER BY l.characterId LIMIT ?`).all(N);
const states = rows.map(r => ({ characterId: r.characterId, name: r.characterName, level: r.level, exp: r.exp, sp: r.sp, adena: r.adena,
    phase: r.phase, activity: r.activity, currentRegion: r.currentRegion, spotId: r.spotId,
    loc: { locX: r.locX, locY: r.locY, locZ: r.locZ }, vitals: { hp: r.hp, maxHp: r.maxHp, mp: r.mp, maxMp: r.maxMp },
    timing: {}, party: { partyId: r.partyId }, stats: json(r.statsJson), inventory: json(r.inventorySummary) }));
const heap = () => { gc(); gc(); const used = process.memoryUsage(); return used.heapUsed + used.arrayBuffers; };
for (const s of states.slice(0, 20)) { try { Econ.forState(s, { timestamp: 1e12 }); } catch {} }   // warm JIT and static tables
Econ.reset(); for (const s of states) Profile.forgetBuild(s.characterId);
const h0 = heap();
const t = performance.now(); let failed = 0, keyBytes = 0;
for (const s of states) { try { keyBytes += Econ.forState(s, { timestamp: 1e12 }).inputKey.length; } catch { failed++; } }
const ms = performance.now() - t;
const h1 = heap();                                   // contexts (LRU 64) + gains store
Econ.reset();                                        // drops contexts and networks, keeps the gains store
const h2 = heap();
for (const s of states) Profile.forgetBuild(s.characterId);  // drops the gains store
const h3 = heap();
const ok = states.length - failed, kb = b => +(b / ok / 1024).toFixed(1);
console.log(JSON.stringify({ bots: ok, failed, buildMsPerBot: +(ms / ok).toFixed(1),
    allKeptKbPerBot: kb(h1 - h0), contextsKbPerBot_LRU64: kb(h1 - h2), gainsStoreKbPerBot: kb(h2 - h3),
    leftAfterForgetKbPerBot: kb(h3 - h0), inputKeyBytesPerBot: Math.round(keyBytes / ok) }));
process.exit(0);
