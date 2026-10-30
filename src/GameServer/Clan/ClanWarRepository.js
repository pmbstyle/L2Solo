'use strict';
const Rules = require('./ClanWarRules');
function install(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS clan_war_declarations (
        fromClanId INTEGER NOT NULL, toClanId INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
        revision INTEGER NOT NULL, declaredAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(fromClanId,toClanId), CHECK(fromClanId<>toClanId));
        CREATE INDEX IF NOT EXISTS clan_war_changes ON clan_war_declarations(revision);
        CREATE INDEX IF NOT EXISTS clan_war_incoming ON clan_war_declarations(toClanId,active);
        CREATE TABLE IF NOT EXISTS clan_war_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, fromClanId INTEGER NOT NULL, toClanId INTEGER NOT NULL,
        actorId INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS clan_war_plans (
        clanId INTEGER PRIMARY KEY, revision INTEGER NOT NULL, stateJson TEXT NOT NULL, updatedAt INTEGER NOT NULL);`);
}
function authorisedEvidence(one, event) {
    const fact = event.clan;
    if (!Rules.id(fact?.warRevision) || !fact.sourceClanId || !fact.targetClanId || fact.sourceClanId === fact.targetClanId) return false;
    return [[fact.sourceClanId, fact.targetClanId], [fact.targetClanId, fact.sourceClanId]].every(([a, b]) =>
        one('SELECT action FROM clan_war_events WHERE fromClanId=? AND toClanId=? AND id<=? AND createdAt<=? ORDER BY id DESC LIMIT 1',
            [a, b, fact.warRevision, event.at])?.action === 'declare');
}
function create({ one, all, write, enqueue, inTransaction, withCharacterFlushes, flushJournals, now }) {
    const row = (from, to) => one('SELECT * FROM clan_war_declarations WHERE fromClanId=? AND toClanId=?', [from, to]);
    const clan = id => one(`SELECT c.*, (SELECT COUNT(*) FROM characters p WHERE p.clanId=c.id) AS members FROM clans c WHERE c.id=?`, [id]);
    return {
        reconcileClanWars() {
            return inTransaction(() => {
                const expired = all(`SELECT d.* FROM clan_war_declarations d LEFT JOIN clans a ON a.id=d.fromClanId
                    LEFT JOIN clans b ON b.id=d.toClanId WHERE d.active=1 AND (a.id IS NULL OR b.id IS NULL)`);
                for (const declaration of expired) {
                    const at = now();
                    write("INSERT INTO clan_war_events(fromClanId,toClanId,actorId,action,reason,createdAt) VALUES (?,?,0,'withdraw','clan_dissolved',?)",
                        [declaration.fromClanId, declaration.toClanId, at]);
                    const revision = Number(one('SELECT last_insert_rowid() AS id').id);
                    write('UPDATE clan_war_declarations SET active=0,revision=?,updatedAt=? WHERE fromClanId=? AND toClanId=?',
                        [revision, at, declaration.fromClanId, declaration.toClanId]);
                }
                return expired.length;
            }, 'clan-war:reconcile');
        },
        fetchClanWarPlans() {
            return enqueue(() => all('SELECT * FROM clan_war_plans'), { operation: 'clan-war:plans', read: true });
        },
        fetchClanWarPressure(clanId, since, until = now()) {
            // A just-ended battle must be visible before deciding that the war
            // was quiet. Flush only when this clan has pending actual combat.
            const pending = require('../../PvpJournal').snapshot().some(r => r.warFacts?.some(f => f.fromClanId === clanId || f.toClanId === clanId));
            return (pending ? flushJournals() : Promise.resolve()).then(() =>
                enqueue(() => require('./ClanWarCombat').pressure(all, clanId,
                    typeof since === 'function' ? since() : since, typeof until === 'function' ? until() : until),
                    { operation: 'clan-war:pressure', read: true }));
        },
        saveClanWarPlan(clanId, expectedRevision, state) {
            const json = JSON.stringify(state);
            if (!Rules.id(clanId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || json.length > 16384) return Promise.reject(Error('invalid war plan'));
            return inTransaction(() => {
                if (!one("SELECT clanId FROM clan_simulation_clans WHERE clanId=? AND mode='autonomous'", [clanId])) return { ok: false, code: 'not_autonomous' };
                const previous = one('SELECT * FROM clan_war_plans WHERE clanId=?', [clanId]);
                if (Number(previous?.revision || 0) !== expectedRevision) return { ok: false, code: 'plan_changed' };
                write(`INSERT INTO clan_war_plans(clanId,revision,stateJson,updatedAt) VALUES (?,?,?,?)
                    ON CONFLICT(clanId) DO UPDATE SET revision=excluded.revision,stateJson=excluded.stateJson,updatedAt=excluded.updatedAt`,
                [clanId, expectedRevision + 1, json, now()]);
                return { ok: true, row: one('SELECT * FROM clan_war_plans WHERE clanId=?', [clanId]) };
            }, 'clan-war:plan');
        },
        setClanWarPartyOperation(partyId, expectedRevision, operation, spotId = null) {
            return inTransaction(() => {
                const party = one('SELECT * FROM bot_background_parties WHERE partyId=?', [partyId]);
                if (!party || !['active', 'hot'].includes(party.status) || party.revision !== expectedRevision) return { ok: false, reason: 'party_changed' };
                const stats = JSON.parse(party.statsJson || '{}');
                if (operation && stats.warOperation && stats.warOperation.id !== operation.id) return { ok: false, reason: 'operation_changed' };
                if (operation) {
                    const ids = JSON.parse(party.memberIdsJson);
                    if (operation.status !== 'returning' && !ids.every(id => one('SELECT clanId FROM characters WHERE id=?', [id])?.clanId === operation.clanId)
                        || !one("SELECT clanId FROM clan_simulation_clans WHERE clanId=? AND mode='autonomous'", [operation.clanId])) return { ok: false, reason: 'roster_changed' };
                    if (operation.status !== 'returning' && !Rules.relation(row(operation.clanId, operation.enemyClanId), row(operation.enemyClanId, operation.clanId)).mutual) return { ok: false, reason: 'war_changed' };
                }
                stats.warOperation = operation;
                write('UPDATE bot_background_parties SET statsJson=?,spotId=?,revision=revision+1,nextResolveAt=?,updatedAt=? WHERE partyId=?',
                    [JSON.stringify(stats), spotId || party.spotId, now() + 1000, now(), partyId]);
                return { ok: true, row: one('SELECT * FROM bot_background_parties WHERE partyId=?', [partyId]) };
            }, 'clan-war:party-operation');
        },
        fetchClanWars(afterRevision = 0) {
            return enqueue(() => all('SELECT * FROM clan_war_declarations WHERE revision>? ORDER BY revision', [afterRevision]), { operation: 'clan-war:read', read: true });
        },
        transitionClanWar(request, beforeWrite = () => true) {
            if (!request || !Rules.id(request.actorId) || !Rules.id(request.targetClanId)
                || !['declare', 'withdraw'].includes(request.action)
                || request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) {
                return Promise.resolve({ ok: false, code: 'invalid_war_request' });
            }
            return withCharacterFlushes([request.actorId], () => inTransaction(() => {
                const actor = one('SELECT id,clanId,clanPrivileges FROM characters WHERE id=?', [request.actorId]);
                const own = actor && clan(Number(actor.clanId)), target = clan(request.targetClanId);
                if (!own || !target) return { ok: false, code: 'clan_not_found' };
                if (request.autonomous && (!one("SELECT clanId FROM clan_simulation_clans WHERE clanId=? AND mode='autonomous'", [own.id])
                    || own.leaderId !== actor.id)) return { ok: false, code: 'not_autonomous_leader' };
                if (own.leaderId !== actor.id && !(actor.clanPrivileges & Rules.CLAN_WAR_PRIVILEGE)) return { ok: false, code: 'not_authorized' };
                const outgoing = row(own.id, target.id), incoming = row(target.id, own.id);
                const state = Rules.relation(outgoing, incoming), active = request.action === 'declare' ? 1 : 0;
                if (request.expectedRevision !== undefined && request.expectedRevision !== state.revision) return { ok: false, code: 'war_changed' };
                if ((outgoing?.active || 0) === active) return { ok: true, changed: false, row: outgoing || null, state };
                if (active) {
                    const reason = Rules.declaration(own, target,
                        Number(one('SELECT COUNT(*) AS n FROM clan_war_declarations WHERE fromClanId=? AND active=1', [own.id]).n),
                        { manual: !request.autonomous, replying: incoming?.active === 1 });
                    if (reason) return { ok: false, code: reason };
                } else if (one(`SELECT characterId FROM bot_life_state WHERE characterId IN (SELECT id FROM characters WHERE clanId=?)
                    AND json_extract(statsJson,'$.pvpEncounter.expiresAt')>? LIMIT 1`, [own.id, now()])) return { ok: false, code: 'clan_in_combat' };
                const refused = beforeWrite();
                if (refused !== true) return { ok: false, code: typeof refused === 'string' ? refused : 'actor_changed' };
                const at = now(), reason = String(request.reason || 'manual').slice(0, 120);
                write('INSERT INTO clan_war_events(fromClanId,toClanId,actorId,action,reason,createdAt) VALUES (?,?,?,?,?,?)',
                    [own.id, target.id, actor.id, request.action, reason, at]);
                const revision = Number(one('SELECT last_insert_rowid() AS id').id);
                write(`INSERT INTO clan_war_declarations(fromClanId,toClanId,active,revision,declaredAt,updatedAt) VALUES (?,?,?,?,?,?)
                    ON CONFLICT(fromClanId,toClanId) DO UPDATE SET active=excluded.active,revision=excluded.revision,
                    declaredAt=excluded.declaredAt,updatedAt=excluded.updatedAt`,
                [own.id, target.id, active, revision, active ? at : outgoing.declaredAt, at]);
                const saved = row(own.id, target.id);
                return { ok: true, changed: true, row: saved, state: Rules.relation(saved, incoming) };
            }, 'clan-war:transition'));
        }
    };
}
module.exports = { install, create, authorisedEvidence };
