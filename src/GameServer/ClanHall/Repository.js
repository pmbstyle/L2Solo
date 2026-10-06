const Policy = require('./Policy');
const ReviewEvents = require('../Clan/ClanReviewEvents');
const { integer: n, DAY, WEEK, AUCTION_DURATION } = Policy;
const json = (raw) => {
    try {
        return JSON.parse(raw || '{}');
    } catch (_) {
        return {};
    }
};

module.exports = function ({
    one,
    all,
    write,
    inTransaction,
    withCharacterFlush,
    updateColdInventorySnapshotUnsafe,
    syncInventorySummaryUnsafe,
    rememberClanContributionUnsafe
}) {
    function ensure(timestamp) {
        write(`CREATE TABLE IF NOT EXISTS clan_halls (id INTEGER PRIMARY KEY, ownerId INTEGER NOT NULL DEFAULT 0,
            round INTEGER NOT NULL DEFAULT 1, auctionEndsAt INTEGER NOT NULL, rentDueAt INTEGER NOT NULL DEFAULT 0,
            serviceDueAt INTEGER NOT NULL DEFAULT 0, functionsJson TEXT NOT NULL DEFAULT '{}',
            auctionDurationMs INTEGER NOT NULL DEFAULT ${AUCTION_DURATION})`);
        if (!all('PRAGMA table_info(clan_halls)').some((column) => column.name === 'auctionDurationMs')) {
            write(`ALTER TABLE clan_halls ADD COLUMN auctionDurationMs INTEGER NOT NULL DEFAULT ${WEEK}`);
        }
        // Preserve each round's start and bids when shortening the old weekly schedule.
        // This runs once per stored duration; ordinary restarts never extend a deadline.
        write(
            `UPDATE clan_halls SET
            auctionEndsAt=CASE WHEN ownerId=0 THEN auctionEndsAt-auctionDurationMs+? ELSE auctionEndsAt END,
            auctionDurationMs=? WHERE auctionDurationMs<>?`,
            [AUCTION_DURATION, AUCTION_DURATION, AUCTION_DURATION]
        );
        write(`CREATE UNIQUE INDEX IF NOT EXISTS clan_hall_owner ON clan_halls(ownerId) WHERE ownerId > 0`);
        write(`CREATE TABLE IF NOT EXISTS clan_hall_bids (clanId INTEGER PRIMARY KEY, hallId INTEGER NOT NULL,
            round INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), placedAt INTEGER NOT NULL)`);
        write(
            `CREATE TABLE IF NOT EXISTS clan_hall_finances (clanId INTEGER PRIMARY KEY, stateJson TEXT NOT NULL DEFAULT '{}')`
        );
        write(`CREATE TABLE IF NOT EXISTS clan_hall_earnings (clanId INTEGER NOT NULL, characterId INTEGER NOT NULL,
            highWater INTEGER NOT NULL, contributed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(clanId,characterId))`);
        write(`CREATE TABLE IF NOT EXISTS clan_hall_events (id INTEGER PRIMARY KEY, clanId INTEGER NOT NULL,
            hallId INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`);
        write(`CREATE TABLE IF NOT EXISTS clan_hall_startup_schedule (
            id INTEGER PRIMARY KEY CHECK(id=1), delayMs INTEGER NOT NULL CHECK(delayMs>0 AND delayMs<=86400000),
            requestedAt INTEGER NOT NULL)`);
        for (const h of Policy.catalog.halls)
            write('INSERT OR IGNORE INTO clan_halls(id,auctionEndsAt,auctionDurationMs) VALUES (?,?,?)', [
                h.id,
                timestamp + AUCTION_DURATION,
                AUCTION_DURATION
            ]);
    }
    let transactionChanges = null;
    const tx = (fn, tag) => inTransaction(() => {
        const changes = new Set(), previous = transactionChanges;
        transactionChanges = changes;
        try { return { result: fn(), changed: [...changes] }; }
        finally { transactionChanges = previous; }
    }, 'clan-hall:' + tag).then(({ result, changed }) => {
        // Only a successful commit wakes planners. A rollback emits nothing.
        for (const id of changed) ReviewEvents.changed(id, 'treasury');
        return result;
    });
    function event(clanId, hallId, kind, amount, at) {
        transactionChanges?.add(clanId);
        write('INSERT INTO clan_hall_events(clanId,hallId,kind,amount,at) VALUES (?,?,?,?,?)', [
            clanId,
            hallId,
            kind,
            amount,
            at
        ]);
    }
    function clan(id) {
        return one(
            `SELECT c.*, s.mode, s.stateJson FROM clans c LEFT JOIN clan_simulation_clans s ON s.clanId=c.id WHERE c.id=?`,
            [id]
        );
    }
    function available(id) {
        return all('SELECT amount,reservedAmount FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [id]).reduce(
            (sum, r) => sum + Math.max(0, n(r.amount) - n(r.reservedAmount)),
            0
        );
    }
    function protectedAmount(c) {
        return Policy.protectedReserve(c, c?.mode, json(c?.stateJson).goal);
    }
    function spendable(c) {
        const rows = all('SELECT selfId,amount,reservedAmount FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [c.id]);
        return Policy.freeAdena(rows, c, c?.mode, json(c?.stateJson).goal);
    }
    function money(id, delta, hallId, kind, timestamp, characterId = null) {
        if (!delta) return true;
        if (delta < 0 && available(id) < -delta) return false;
        transactionChanges?.add(id);
        const rows = all('SELECT * FROM clan_warehouse_items WHERE clanId=? AND selfId=57 ORDER BY id', [id]);
        if (delta > 0) {
            if (rows.length)
                write('UPDATE clan_warehouse_items SET amount=amount+?, updatedAt=? WHERE id=?', [
                    delta,
                    timestamp,
                    rows[0].id
                ]);
            else
                write(
                    `INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,enchant,createdAt,updatedAt) VALUES (?,57,'Adena','Other.Currency',?,0,?,?)`,
                    [id, delta, timestamp, timestamp]
                );
        } else {
            let left = -delta;
            for (const r of rows) {
                const take = Math.min(left, Math.max(0, n(r.amount) - n(r.reservedAmount)));
                if (!take) continue;
                if (take === n(r.amount)) write('DELETE FROM clan_warehouse_items WHERE id=?', [r.id]);
                else
                    write('UPDATE clan_warehouse_items SET amount=amount-?, updatedAt=? WHERE id=?', [
                        take,
                        timestamp,
                        r.id
                    ]);
                left -= take;
                if (!left) break;
            }
        }
        const e = write('INSERT INTO clan_hall_events(clanId,hallId,kind,amount,at) VALUES (?,?,?,?,?)', [
            id,
            hallId,
            kind,
            delta,
            timestamp
        ]);
        const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [id]);
        const state = json(simulation?.stateJson);
        const revision =
            Math.max(
                n(state.warehouseRevision),
                n(one('SELECT MAX(warehouseRevision) AS v FROM clan_warehouse_ledger WHERE clanId=?', [id])?.v)
            ) + 1;
        if (simulation) {
            state.warehouseRevision = revision;
            state.updatedAt = timestamp;
            write('UPDATE clan_simulation_clans SET stateJson=?,updatedAt=? WHERE clanId=?', [
                JSON.stringify(state),
                timestamp,
                id
            ]);
        }
        write(
            `INSERT INTO clan_warehouse_ledger(clanId,characterId,selfId,amount,operation,resolveKey,warehouseRevision,createdAt) VALUES (?,?,57,?,?,?,?,?)`,
            [id, characterId || clan(id).leaderId, Math.abs(delta), kind, `hall:${e.insertId}`, revision, timestamp]
        );
        return true;
    }
    // A member's wallet as the dues read it, or null while another owner holds the
    // member (a party, a live actor or a leased worker snapshot): it pays next time.
    function memberWallet(id, timestamp) {
        const life = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
        if (
            !life ||
            life.phase !== 'cold' ||
            life.partyId ||
            !['legacy_main', 'cold_simulation_owner'].includes(life.simulationOwner || 'legacy_main') ||
            Number(life.simulationLeaseUntil) > timestamp
        )
            return null;
        const rows = all('SELECT id,amount FROM items WHERE characterId=? AND selfId=57 ORDER BY id', [id]);
        const workerOwned = life.simulationOwner === 'cold_simulation_owner';
        const virtual = json(life.inventorySummary);
        const amount = workerOwned ? n(virtual['57']?.amount ?? life.adena) : rows.reduce((s, r) => s + n(r.amount), 0);
        return { id, life, rows, workerOwned, virtual, amount };
    }
    // Pays (delta < 0) or credits (delta > 0) a wallet read by memberWallet.
    function changeWallet(w, delta, clanId, timestamp) {
        const next = w.amount + delta;
        if (w.workerOwned) {
            // Only an unleased persisted worker snapshot can change. Advance its revision
            // in the same transaction; a proposal based on the old snapshot cannot commit.
            w.virtual['57'] = { ...(w.virtual['57'] || {}), selfId: 57, name: 'Adena', amount: next };
            const stats = json(w.life.statsJson);
            stats.lastClanWarehouseTransfer = { clanId, selfId: 57, amount: delta, at: timestamp };
            const changed = write(
                `UPDATE bot_life_state SET inventorySummary=?,adena=?,statsJson=?,simulationRevision=simulationRevision+1,
                simulationLeaseId=NULL,simulationLeaseUntil=0,updatedAt=? WHERE characterId=? AND phase='cold'
                AND simulationOwner='cold_simulation_owner' AND simulationRevision=? AND simulationLeaseUntil<=?`,
                [JSON.stringify(w.virtual), next, JSON.stringify(stats), timestamp, w.id, w.life.simulationRevision, timestamp]
            );
            if (changed.affectedRows !== 1) throw Error('Clan dues owner changed');
            syncInventorySummaryUnsafe(w.id, { 57: w.virtual['57'] });
            return;
        }
        if (delta > 0 && w.rows.length) write('UPDATE items SET amount=amount+? WHERE id=?', [delta, w.rows[0].id]);
        else if (delta > 0)
            write(`INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId) VALUES (57,'Adena',?,0,0,0,?)`, [delta, w.id]);
        let left = -delta;
        for (const r of w.rows) {
            if (left <= 0) break;
            const take = Math.min(left, n(r.amount));
            write('UPDATE items SET amount=amount-? WHERE id=?', [take, r.id]);
            left -= take;
        }
        const updated = updateColdInventorySnapshotUnsafe(
            w.id,
            57,
            { clanId, selfId: 57, amount: delta, at: timestamp },
            Number(w.life.simulationRevision || 0)
        );
        if (!updated.ok) throw Error('Clan dues snapshot changed');
    }
    // What a one-off investment is for: the next level's fund below level 2, then
    // the clan hall the clan is saving for.
    function duesTarget(c, level) {
        if (level <= 1) {
            const required = invoke('GameServer/Clan/ClanContributionPolicy').scaledAdenaRequirement(level);
            const paid = n(one('SELECT COALESCE(SUM(amount),0) AS v FROM clan_contributions WHERE clanId=? AND targetLevel=?', [c.id, level])?.v);
            return required > paid ? { key: `level:${level}`, shortfall: required - paid } : null;
        }
        const g = json(one('SELECT stateJson FROM clan_hall_finances WHERE clanId=?', [c.id])?.stateJson);
        const shortfall = g.status === 'saving' ? n(g.target) - spendable(c) : 0;
        return shortfall > 0 ? { key: `hall:${n(g.hallId)}:${n(g.round)}`, shortfall } : null;
    }
    function snapshot(id) {
        const c = clan(id);
        const hall = one('SELECT * FROM clan_halls WHERE ownerId=?', [id]);
        return {
            goal: json(one('SELECT stateJson FROM clan_hall_finances WHERE clanId=?', [id])?.stateJson),
            hall: hall ? { ...Policy.definition(hall.id), ...hall } : null,
            bid: one('SELECT * FROM clan_hall_bids WHERE clanId=?', [id]) || null,
            available: c ? available(id) : 0,
            protected: c ? protectedAmount(c) : 0
        };
    }
    function saveGoal(id, goal) {
        write(
            `INSERT INTO clan_hall_finances(clanId,stateJson) VALUES (?,?) ON CONFLICT(clanId) DO UPDATE SET stateJson=excluded.stateJson`,
            [id, JSON.stringify(goal)]
        );
    }
    function bid(c, h, amount, timestamp) {
        if (!c || n(c.level) < 2 || n(c.dissolvingExpiryTime) > 0) return { ok: false, code: 'clan_ineligible' };
        if (!h || h.ownerId || h.auctionEndsAt <= timestamp) return { ok: false, code: 'auction_closed' };
        if (one('SELECT id FROM clan_halls WHERE ownerId=?', [c.id])) return { ok: false, code: 'already_owns_hall' };
        const previous = one('SELECT * FROM clan_hall_bids WHERE clanId=?', [c.id]);
        if (previous && (previous.hallId !== h.id || previous.round !== h.round))
            return { ok: false, code: 'already_bidding' };
        if (
            !Number.isSafeInteger(amount) ||
            amount < Policy.definition(h.id).minimumBid ||
            amount <= n(previous?.amount)
        )
            return { ok: false, code: 'invalid_bid' };
        const difference = amount - n(previous?.amount);
        const buffer =
            c.mode === 'autonomous'
                ? Policy.reserve(
                      Policy.definition(h.id),
                      Policy.desired(
                          Policy.definition(h.id),
                          all(
                              `SELECT c.id AS characterId,c.level,c.classId,l.currentRegion,l.adena,l.statsJson,l.inventorySummary,
                            p.traitsJson,p.primaryDrive,p.archetype FROM characters c LEFT JOIN bot_life_state l ON l.characterId=c.id
                            LEFT JOIN bot_personas p ON p.characterId=c.id WHERE c.clanId=? ORDER BY c.id`,
                              [c.id]
                          )
                      )
                  )
                : 0;
        if (spendable(c) < difference + buffer) return { ok: false, code: 'budget_reserved' };
        money(c.id, -difference, h.id, 'hall_bid', timestamp);
        write(
            `INSERT INTO clan_hall_bids(clanId,hallId,round,amount,placedAt) VALUES (?,?,?,?,?) ON CONFLICT(clanId) DO UPDATE SET amount=excluded.amount,placedAt=excluded.placedAt`,
            [c.id, h.id, h.round, amount, timestamp]
        );
        return { ok: true };
    }
    function settle(timestamp) {
        for (const h of all('SELECT * FROM clan_halls ORDER BY id')) {
            if (!h.ownerId && h.auctionEndsAt <= timestamp) {
                const bids = all(
                    'SELECT * FROM clan_hall_bids WHERE hallId=? AND round=? ORDER BY amount DESC,placedAt ASC,clanId ASC',
                    [h.id, h.round]
                );
                let winner = null;
                for (const b of bids) {
                    const c = clan(b.clanId);
                    const eligible =
                        c &&
                        c.level >= 2 &&
                        !c.dissolvingExpiryTime &&
                        !one('SELECT id FROM clan_halls WHERE ownerId=?', [c.id]);
                    if (!winner && eligible) winner = b;
                    else if (c) money(c.id, b.amount, h.id, 'hall_bid_refund', timestamp);
                }
                write('DELETE FROM clan_hall_bids WHERE hallId=?', [h.id]);
                if (winner) {
                    // Rent is due immediately. A late server restart does not backdate a new ownership.
                    write('UPDATE clan_halls SET ownerId=?,rentDueAt=?,serviceDueAt=?,auctionEndsAt=0 WHERE id=?', [
                        winner.clanId,
                        timestamp,
                        timestamp + DAY,
                        h.id
                    ]);
                    event(winner.clanId, h.id, 'hall_won', winner.amount, timestamp);
                } else
                    write('UPDATE clan_halls SET round=round+1,auctionEndsAt=? WHERE id=?', [
                        timestamp + AUCTION_DURATION,
                        h.id
                    ]);
            }
        }
        for (const h of all('SELECT * FROM clan_halls WHERE ownerId>0 ORDER BY id')) {
            const c = clan(h.ownerId),
                def = Policy.definition(h.id);
            if (!c) {
                release(h, timestamp);
                continue;
            }
            if (timestamp >= h.rentDueAt) {
                const periods = Math.floor((timestamp - h.rentDueAt) / WEEK) + 1;
                const due = periods * def.weeklyRent;
                if (spendable(c) >= due) {
                    money(c.id, -due, h.id, 'hall_rent', timestamp);
                    write('UPDATE clan_halls SET rentDueAt=? WHERE id=?', [h.rentDueAt + periods * WEEK, h.id]);
                } else if (timestamp >= h.rentDueAt + WEEK) {
                    release(h, timestamp);
                    continue;
                }
            }
            if (timestamp >= h.serviceDueAt) {
                const upgrades = json(h.functionsJson),
                    periods = Math.floor((timestamp - h.serviceDueAt) / DAY) + 1;
                const due = Policy.dailyCost(def, upgrades) * periods;
                // Optional services cannot consume rent or development reserves.
                if (due && spendable(clan(c.id)) < due + 2 * def.weeklyRent) {
                    write("UPDATE clan_halls SET functionsJson='{}' WHERE id=?", [h.id]);
                    event(c.id, h.id, 'hall_services_disabled', 0, timestamp);
                } else if (due) money(c.id, -due, h.id, 'hall_services', timestamp);
                write('UPDATE clan_halls SET serviceDueAt=? WHERE id=?', [h.serviceDueAt + periods * DAY, h.id]);
            }
        }
    }
    function release(h, timestamp) {
        write(
            "UPDATE clan_halls SET ownerId=0,round=round+1,auctionEndsAt=?,rentDueAt=0,serviceDueAt=0,functionsJson='{}' WHERE id=?",
            [timestamp + AUCTION_DURATION, h.id]
        );
        event(h.ownerId, h.id, 'hall_repossessed', 0, timestamp);
    }
    function upgrade(c, h, kind, level, timestamp) {
        const def = Policy.definition(h.id),
            cost = Policy.fee(def, kind, level),
            upgrades = json(h.functionsJson);
        if (cost === null) return { ok: false, code: 'invalid_function' };
        if (n(upgrades[kind]) === level) return { ok: true };
        const previous = Policy.fee(def, kind, n(upgrades[kind])) || 0;
        if (level) upgrades[kind] = level;
        else delete upgrades[kind];
        const charge = Math.max(0, cost - previous);
        if (charge && spendable(c) < charge + Policy.reserve(def, upgrades))
            return { ok: false, code: 'budget_reserved' };
        if (charge) money(c.id, -charge, h.id, 'hall_upgrade', timestamp);
        write('UPDATE clan_halls SET functionsJson=? WHERE id=?', [JSON.stringify(upgrades), h.id]);
        event(c.id, h.id, 'hall_function_changed', level, timestamp);
        return { ok: true };
    }
    return {
        initClanHalls(timestamp = Date.now()) {
            return tx(() => {
                ensure(timestamp);
                const schedule = one('SELECT delayMs FROM clan_hall_startup_schedule WHERE id=1');
                if (schedule) {
                    // Consume an operator's one-time reschedule atomically with the new deadlines.
                    write('UPDATE clan_halls SET auctionEndsAt=? WHERE ownerId=0', [timestamp + schedule.delayMs]);
                    write('DELETE FROM clan_hall_startup_schedule WHERE id=1');
                }
                settle(timestamp);
                return all('SELECT * FROM clan_halls');
            }, 'init');
        },
        tickClanHalls(timestamp = Date.now()) {
            return tx(() => {
                settle(timestamp);
                return all('SELECT * FROM clan_halls');
            }, 'tick');
        },
        fetchClanHallFinance(id) {
            return tx(
                () =>
                    one("SELECT name FROM sqlite_master WHERE type='table' AND name='clan_halls'")
                        ? snapshot(Number(id))
                        : null,
                'finance'
            );
        },
        fetchClanHallAuctions(id = 0) {
            return tx(
                () =>
                    (one("SELECT name FROM sqlite_master WHERE type='table' AND name='clan_halls'")
                        ? all('SELECT * FROM clan_halls ORDER BY id') : []).map((h) => ({
                        ...h,
                        functions: json(h.functionsJson),
                        ownBid:
                            one('SELECT amount FROM clan_hall_bids WHERE hallId=? AND clanId=?', [h.id, Number(id)])
                                ?.amount || 0
                    })),
                'list'
            );
        },
        placeClanHallBid({ clanId, actorId, hallId, amount, timestamp = Date.now() }) {
            return tx(() => {
                settle(timestamp);
                const c = clan(Number(clanId));
                if (!c || c.leaderId !== Number(actorId)) return { ok: false, code: 'not_leader' };
                return bid(c, one('SELECT * FROM clan_halls WHERE id=?', [Number(hallId)]), Number(amount), timestamp);
            }, 'bid');
        },
        cancelClanHallBid({ clanId, actorId, timestamp = Date.now() }) {
            return tx(() => {
                settle(timestamp);
                const c = clan(Number(clanId)),
                    b = one('SELECT * FROM clan_hall_bids WHERE clanId=?', [Number(clanId)]);
                if (!c || c.leaderId !== Number(actorId)) return { ok: false, code: 'not_leader' };
                if (!b) return { ok: false, code: 'no_bid' };
                money(c.id, Math.floor(b.amount * 0.9), b.hallId, 'hall_bid_cancelled', timestamp);
                write('DELETE FROM clan_hall_bids WHERE clanId=?', [c.id]);
                return { ok: true };
            }, 'cancel');
        },
        configureClanHall({ clanId, actorId, kind, level, timestamp = Date.now() }) {
            return tx(() => {
                settle(timestamp);
                const c = clan(Number(clanId)),
                    h = one('SELECT * FROM clan_halls WHERE ownerId=?', [Number(clanId)]),
                    m = one('SELECT clanId,clanPrivileges FROM characters WHERE id=?', [Number(actorId)]);
                if (!c || !h || m?.clanId !== c.id || (c.leaderId !== Number(actorId) && !(m.clanPrivileges & 32)))
                    return { ok: false, code: 'not_authorized' };
                return upgrade(c, h, kind, Number(level), timestamp);
            }, 'configure');
        },
        planClanHallFinance(clanId, timestamp = Date.now()) {
            return tx(() => {
                const c = clan(Number(clanId));
                if (!c || c.mode !== 'autonomous' || c.level < 2 || c.dissolvingExpiryTime)
                    return { ok: true, skipped: true };
                const current = snapshot(c.id),
                    members = all(
                        `SELECT c.id AS characterId,c.level,c.classId,l.currentRegion,l.adena,l.statsJson,l.inventorySummary,
                            p.traitsJson,p.primaryDrive,p.archetype FROM characters c LEFT JOIN bot_life_state l ON l.characterId=c.id
                            LEFT JOIN bot_personas p ON p.characterId=c.id WHERE c.clanId=? ORDER BY c.id`,
                        [c.id]
                    );
                for (const member of members) {
                    member.stats = json(member.statsJson);
                    member.inventory = json(member.inventorySummary);
                    member.persona = { traits: json(member.traitsJson), primaryDrive: member.primaryDrive, archetype: member.archetype };
                }
                const lots = all('SELECT * FROM clan_halls').map(row => ({ ...Policy.definition(row.id), ...row, functions: json(row.functionsJson) }));
                const economy = invoke('GameServer/Clan/ClanEconomyContext').forClan({ ...c, state: json(c.stateJson), members }, {
                    warehouse: all('SELECT * FROM clan_warehouse_items WHERE clanId=?', [c.id]), halls: lots
                });
                let goal = current.goal,
                    h = current.hall;
                if (h) {
                    const def = Policy.definition(h.id),
                        wanted = Policy.desired(def, members),
                        installed = json(h.functionsJson);
                    const next = Object.entries(wanted).find(([k, l]) => n(installed[k]) < l);
                    const upgrades = next ? { ...installed, [next[0]]: next[1] } : installed;
                    const activation = next
                        ? Math.max(0, Policy.fee(def, ...next) - (Policy.fee(def, next[0], n(installed[next[0]])) || 0))
                        : 0;
                    const desiredReserve = Policy.reserve(def, upgrades) + activation;
                    goal = {
                        status: next ? 'saving_upgrade' : 'maintaining',
                        hallId: h.id,
                        target: desiredReserve,
                        progress: Math.min(desiredReserve, spendable(c)),
                        protected: protectedAmount(c),
                        updatedAt: timestamp
                    };
                    if (next && spendable(c) >= desiredReserve && economy.budgetFor('hall_upgrade', h.id) >= desiredReserve - economy.reserve)
                        upgrade(c, h, ...next, timestamp);
                } else if (current.bid) {
                    goal = {
                        ...goal,
                        status: 'bidding',
                        hallId: current.bid.hallId,
                        round: current.bid.round,
                        bid: current.bid.amount,
                        progress: 0,
                        target: 0,
                        updatedAt: timestamp
                    };
                } else {
                    h = economy.hall;
                    if (!h) goal = { status: 'waiting_auction', target: 0, progress: 0, updatedAt: timestamp };
                    else {
                        const def = Policy.definition(h.id);
                        const maintenance = Policy.reserve(def, Policy.desired(def, members));
                        const valued = Math.min(economy.hallBid(h), Math.max(0, spendable(c) - maintenance));
                        const planned = Math.max(def.minimumBid, valued);
                        const target = planned + Policy.reserve(def, Policy.desired(def, members));
                        goal = {
                            status: 'saving',
                            hallId: h.id,
                            round: h.round,
                            bid: planned,
                            target,
                            progress: Math.min(target, spendable(c)),
                            protected: protectedAmount(c),
                            updatedAt: timestamp
                        };
                        if (spendable(c) >= target && bid(c, h, planned, timestamp).ok)
                            goal = { ...goal, status: 'bidding', target: 0, progress: 0 };
                    }
                }
                goal.economy = { focus: economy.network.focus, dormant: economy.network.dormant,
                    moneyPrice: economy.moneyPrice, incomePerHour: economy.incomePerHour };
                saveGoal(c.id, goal);
                return { ok: true, goal };
            }, 'plan');
        },
        // Clan money to a member (amount > 0: a share of a clan purchase, a gear
        // compensation, from the clan's free money) or back to the clan (amount < 0:
        // a purchase that failed). Money the member keeps is not earnings: its dues
        // mark moves with it (moveMark); money spent at once on a clan purchase does
        // not move it.
        payClanMember({ clanId, characterId, amount, kind, moveMark = true, progressionGoal = null, timestamp = Date.now() }) {
            const pay = Math.trunc(Number(amount) || 0);
            return withCharacterFlush(Number(characterId), () =>
                tx(() => {
                    const c = clan(Number(clanId)),
                        id = Number(characterId);
                    if (!c || c.mode !== 'autonomous' || !pay) return { ok: false, code: 'clan_payment_invalid' };
                    const currentGoal = json(c.stateJson).goal;
                    // Only the exact still-current progression purchase spends
                    // its own earmark. Ordinary member/hall payments cannot.
                    const progressionPurchase = progressionGoal && kind === 'clan_level_purchase'
                        && currentGoal?.type === 'item' && currentGoal.status !== 'completed' && currentGoal?.plan?.kind === 'market'
                        && Number(currentGoal.target?.itemId) === Number(progressionGoal.target?.itemId)
                        && Number(currentGoal.updatedAt) === Number(progressionGoal.updatedAt)
                        && Number(currentGoal.plan.maxPrice) === Number(progressionGoal.plan?.maxPrice)
                        && pay <= n(currentGoal.plan.maxPrice);
                    const residence = progressionPurchase && one("SELECT name FROM sqlite_master WHERE type='table' AND name='clan_halls'")
                        ? one('SELECT * FROM clan_halls WHERE ownerId=?', [c.id]) : null;
                    const maintenance = residence ? Policy.reserve(Policy.definition(residence.id), json(residence.functionsJson)) : 0;
                    const budget = progressionPurchase ? Math.max(0, available(c.id) - maintenance) : spendable(c);
                    if (pay > 0 && budget < pay) return { ok: false, code: 'clan_funds_short' };
                    const member = memberWallet(id, timestamp);
                    if (!member) return { ok: false, code: 'member_busy' };
                    if (pay < 0 && member.amount < -pay) return { ok: false, code: 'member_funds_short' };
                    money(c.id, -pay, 0, kind, timestamp, id);
                    changeWallet(member, pay, c.id, timestamp);
                    if (moveMark) write('UPDATE clan_hall_earnings SET highWater=MAX(0, highWater+?) WHERE clanId=? AND characterId=?', [pay, c.id, id]);
                    return { ok: true, amount: pay, row: one('SELECT * FROM bot_life_state WHERE characterId=?', [id]) };
                }, 'clan-payment')
            );
        },
        // The clan's dues, one settlement per member (ClanHall/Runtime runs it hourly for
        // every bot clan): a share of what the member earned since its last settlement
        // (the mark follows its wealth, wallet + contributed, up and down: a purchase
        // exempts the hour it happened in, not the hours until the old peak returns),
        // never of its savings; plus an
        // optional one-off investment from savings toward the clan's current target.
        // Every level pays the clan warehouse; levels 0-1 also write the contribution
        // ledger that the level-up checks.
        settleClanDues({ clanId, characterId, rate = 0, investFraction = 0, timestamp = Date.now() }) {
            return withCharacterFlush(Number(characterId), () => {
                // ARCH-NOTE: Dues also spend a bot's wallet; read its fixed money packet before the transaction instead of stripping it.
                const member = one(`SELECT c.level, c.classId,
                    COALESCE((SELECT SUM(amount) FROM items WHERE characterId=c.id AND selfId=57),0) AS adena,
                    json_extract(l.statsJson,'$.money') AS money FROM characters c
                    LEFT JOIN bot_life_state l ON l.characterId=c.id WHERE c.id=?`, [Number(characterId)]);
                const personal = { level: n(member?.level), adena: n(member?.adena), stats: { classId: n(member?.classId),
                    money: member?.money ? json(member.money) : undefined } };
                const funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
                const freeBudget = funding.spendable(personal, 0, { free: true });
                const reserve = invoke('GameServer/Clan/ClanContributionPolicy').personalReserve(personal);
                return tx(() => {
                    const c = clan(Number(clanId)),
                        id = Number(characterId),
                        m = one('SELECT clanId,level FROM characters WHERE id=?', [id]);
                    if (!c || c.mode !== 'autonomous' || m?.clanId !== c.id) return { ok: false, code: 'member_busy' };
                    const level = n(c.level);
                    const payer = memberWallet(id, timestamp);
                    if (!payer) return { ok: false, code: 'member_busy' };
                    const cursor = one('SELECT * FROM clan_hall_earnings WHERE clanId=? AND characterId=?', [c.id, id]);
                    const wealth = payer.amount + n(cursor?.contributed),
                        earned = cursor ? Math.max(0, wealth - cursor.highWater) : 0;
                    const free = Math.max(0, Math.min(freeBudget, payer.amount - reserve));
                    const dues = Math.min(free, Math.floor(earned * Math.max(0, Math.min(1, rate))));
                    const target = duesTarget(c, level);
                    const state = json(c.stateJson);
                    const invested = target && state.duesInvested?.key === target.key ? state.duesInvested.ids || [] : [];
                    const investment = target && investFraction > 0 && !invested.includes(id)
                        ? Math.min(target.shortfall, Math.floor((free - dues) * Math.min(1, investFraction)))
                        : 0;
                    const amount = dues + investment;
                    if (amount) {
                        changeWallet(payer, -amount, c.id, timestamp);
                        money(c.id, amount, 0, 'clan_dues', timestamp, id);
                        if (level <= 1) {
                            const ledger = write(`INSERT INTO clan_contributions
                                (clanId, characterId, targetLevel, amount, source, resolveKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [c.id, id, level, amount, investment ? 'investment' : 'dues', `clan:${c.id}:dues:${id}:${timestamp}`, timestamp]);
                            rememberClanContributionUnsafe(c.id, id, n(c.leaderId), ledger.insertId, amount, payer.amount, timestamp);
                        }
                    }
                    if (investment) {
                        write(`UPDATE clan_simulation_clans SET stateJson=json_set(stateJson, '$.duesInvested', json(?)) WHERE clanId=?`,
                            [JSON.stringify({ key: target.key, ids: [...invested, id] }), c.id]);
                    }
                    write(
                        `INSERT INTO clan_hall_earnings(clanId,characterId,highWater,contributed) VALUES (?,?,?,?) ON CONFLICT(clanId,characterId) DO UPDATE SET highWater=excluded.highWater,contributed=excluded.contributed`,
                        [c.id, id, wealth, n(cursor?.contributed) + amount]
                    );
                    return {
                        ok: true,
                        amount,
                        dues,
                        investment,
                        row: amount ? one('SELECT * FROM bot_life_state WHERE characterId=?', [id]) : null
                    };
                }, 'dues');
            });
        },
        clanHallBlocksDissolution(clanId) {
            return tx(
                () =>
                    !!one('SELECT id FROM clan_halls WHERE ownerId=?', [Number(clanId)]) ||
                    !!one('SELECT clanId FROM clan_hall_bids WHERE clanId=?', [Number(clanId)]),
                'dissolution'
            );
        }
    };
};
