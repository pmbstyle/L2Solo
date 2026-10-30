'use strict';
const { randomUUID } = require('node:crypto');
const HOUR = 3600000;
const id = n => Number.isSafeInteger(n) && n > 0;
const clan = s => Number(s?.fetchClanId?.() ?? s?.stats?.clanId ?? s?.clanId ?? 0);
const character = s => Number(s?.fetchId?.() ?? s?.characterId ?? 0);
function fact(key, attacker, victim, at, killed) {
    const fromClanId = clan(attacker), toClanId = clan(victim);
    const attackerId = character(attacker), victimId = character(victim);
    if (![fromClanId, toClanId, attackerId, victimId].every(id) || fromClanId === toClanId || attackerId === victimId
        || !Number.isSafeInteger(at) || at <= 0) return null;
    return { key, fromClanId, toClanId, attackerId, victimId, at, killed: killed ? 1 : 0 };
}
function hot(attacker, victim, at) {
    return [fact(`hot:${randomUUID()}`, attacker, victim, at, true)].filter(Boolean);
}
function cold({ key, at, fought, actions = 0, principals, combatants = principals, kills = [] }) {
    if (!fought || !(actions > 0) && !kills.length) return [];
    const roster = new Map(combatants.map(s => [character(s), s]));
    const prefix = `cold:${key}:${at}`;
    return [fact(`${prefix}:contact`, principals[0], principals[1], at, false),
        ...kills.map(k => fact(`${prefix}:${k.killerId}:${k.victimId}`, roster.get(k.killerId), roster.get(k.victimId), at, true))]
        .filter(Boolean);
}
function install(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS clan_war_combat (
        eventKey TEXT PRIMARY KEY, fromClanId INTEGER NOT NULL, toClanId INTEGER NOT NULL,
        attackerId INTEGER NOT NULL, victimId INTEGER NOT NULL, at INTEGER NOT NULL,
        killed INTEGER NOT NULL CHECK(killed IN (0,1)));
        CREATE INDEX IF NOT EXISTS clan_war_combat_from ON clan_war_combat(fromClanId,at);
        CREATE INDEX IF NOT EXISTS clan_war_combat_to ON clan_war_combat(toClanId,at);
        CREATE INDEX IF NOT EXISTS clan_war_combat_age ON clan_war_combat(at);`);
}
// Called inside the journal transaction: retries cannot count a casualty twice.
function persist(write, conflicts, at) {
    for (const conflict of conflicts) for (const r of conflict.warFacts || []) {
        write(`INSERT OR IGNORE INTO clan_war_combat(eventKey,fromClanId,toClanId,attackerId,victimId,at,killed)
            VALUES (?,?,?,?,?,?,?)`, [r.key, r.fromClanId, r.toClanId, r.attackerId, r.victimId, r.at, r.killed]);
    }
    write('DELETE FROM clan_war_combat WHERE at<?', [at - 24 * HOUR]);
}
function pressure(all, clanId, since, until) {
    return all(`SELECT enemyClanId,SUM(losses) AS losses,SUM(kills) AS kills,
        COUNT(DISTINCT lostId) AS victims,MAX(at) AS combatAt FROM (
        SELECT fromClanId AS enemyClanId,killed AS losses,0 AS kills,
            CASE WHEN killed=1 THEN victimId END AS lostId,at FROM clan_war_combat WHERE toClanId=? AND at>=? AND at<=?
        UNION ALL SELECT toClanId AS enemyClanId,0 AS losses,killed AS kills,NULL AS lostId,at
            FROM clan_war_combat WHERE fromClanId=? AND at>=? AND at<=?) GROUP BY enemyClanId`,
    [clanId, since, until, clanId, since, until]);
}
module.exports = { hot, cold, install, persist, pressure };
