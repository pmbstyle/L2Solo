const Database = invoke('Database');
const ClanRules = invoke('GameServer/Clan/ClanRules');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');

const DAY_MS = 86400000;
const JOIN_COOLDOWN_MS = ClanRules.JOIN_COOLDOWN_MS;
const CREATE_COOLDOWN_MS = 10 * DAY_MS;
const SMALL_CREST_KIND = 'pledge';
const SMALL_CREST_MAX_BYTES = 256;

// memberClans (member id -> clan id) and membershipRevision are kept by the
// membership writers below (replaceMember, removeMemberFromCache, reload,
// create, dissolve): a member's clan is a Map read, and a reader that copies
// the memberships (ClanSocialRuntime) rebuilds only when the revision moved.
const state = {
    clans: new Map(),
    memberClans: new Map(),
    membershipRevision: 0
};

function nowMs() {
    return Date.now();
}

function number(value) {
    return Number(value) || 0;
}

function normalizeClan(row, members = []) {
    return {
        id: number(row.id),
        name: String(row.name || ''),
        level: number(row.level),
        leaderId: number(row.leaderId),
        crestId: number(row.crestId),
        crestLargeId: number(row.crestLargeId),
        allyId: number(row.allyId),
        allyName: String(row.allyName || ''),
        allyCrestId: number(row.allyCrestId),
        dissolvingExpiryTime: number(row.dissolvingExpiryTime),
        charPenaltyExpiryTime: number(row.charPenaltyExpiryTime),
        members: members.map(normalizeMember)
    };
}

function normalizeMember(row) {
    return {
        id: number(row.id),
        name: String(row.name || ''),
        title: String(row.title || ''),
        level: number(row.level),
        classId: number(row.classId),
        clanId: number(row.clanId),
        clanPrivileges: number(row.clanPrivileges),
        online: Number(row.isOnline) === 1 || row.isOnline === true
    };
}

function actorMember(actor) {
    return normalizeMember({
        id: actor.fetchId(),
        name: actor.fetchName(),
        title: actor.fetchTitle?.() || '',
        level: actor.fetchLevel(),
        classId: actor.fetchClassId(),
        clanId: actor.fetchClanId(),
        clanPrivileges: actor.fetchClanPrivileges(),
        isOnline: actor.fetchIsOnline?.() ? 1 : 0
    });
}

function onlineObjectId(member) {
    const session = onlineSessionByActorId(member.id);
    if (session?.actor?.fetchIsOnline?.()) return Number(member.id);
    // Cold bots remain socially online; their simulation does not require a
    // world session. This is a clan UI status, not an actor lookup for actions.
    const bot = invoke('GameServer/Bot/Population/BotLifeState').cachedState(member.id);
    return bot ? Number(member.id) : 0;
}

function onlineSessionByActorId(id) {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).find((ob) => Number(ob.actor?.fetchId?.()) === Number(id));
}

function clanOnlineSessions(clan) {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter((session) => (
        Number(session.actor?.fetchClanId?.()) === Number(clan?.id)
    ));
}

function broadcastClanAppearance(clan) {
    if (!clan) return;
    const ServerResponse = invoke('GameServer/Network/Response');
    clanOnlineSessions(clan).forEach((memberSession) => {
        memberSession.dataSendToMe(ServerResponse.userInfo(memberSession.actor));
        memberSession.dataSendToOthers(ServerResponse.charInfo(memberSession.actor), memberSession.actor);
        memberSession.dataSendToOthers(ServerResponse.relationChanged(memberSession.actor), memberSession.actor);
    });
}

function liveMember(member) {
    const session = onlineSessionByActorId(member.id);
    if (!session?.actor) {
        const bot = invoke('GameServer/Bot/Population/BotLifeState').cachedState(member.id);
        return normalizeMember({
            ...member,
            name: bot?.name || member.name,
            level: bot?.level ?? member.level,
            classId: bot?.stats?.classId ?? member.classId,
            isOnline: Boolean(bot)
        });
    }

    return normalizeMember({
        ...member,
        id: session.actor.fetchId(),
        name: session.actor.fetchName(),
        title: session.actor.fetchTitle?.() ?? member.title ?? '',
        level: session.actor.fetchLevel(),
        classId: session.actor.fetchClassId(),
        clanId: session.actor.fetchClanId(),
        clanPrivileges: session.actor.fetchClanPrivileges?.() || member.clanPrivileges,
        isOnline: session.actor.fetchIsOnline?.() ? 1 : 0
    });
}

function replaceMember(clan, member) {
    const before = clan.members.length;
    clan.members = clan.members.filter((entry) => Number(entry.id) !== Number(member.id));
    clan.members.push(normalizeMember(member));
    if (clan.members.length === before) return;
    state.memberClans.set(number(member.id), number(clan.id));
    state.membershipRevision++;
}

function removeMemberFromCache(clanId, actorId) {
    const clan = state.clans.get(number(clanId));
    if (!clan) return;
    const before = clan.members.length;
    clan.members = clan.members.filter((entry) => Number(entry.id) !== Number(actorId));
    if (clan.members.length === before) return;
    if (state.memberClans.get(number(actorId)) === number(clan.id)) state.memberClans.delete(number(actorId));
    state.membershipRevision++;
}

// A whole clan enters or leaves the cache (reload, create, dissolve).
function setClan(clan) {
    state.clans.set(clan.id, clan);
    for (const member of clan.members) state.memberClans.set(number(member.id), clan.id);
    state.membershipRevision++;
}

function deleteClan(clanId) {
    const clan = state.clans.get(clanId);
    if (!clan) return;
    state.clans.delete(clanId);
    for (const member of clan.members) {
        if (state.memberClans.get(number(member.id)) === clanId) state.memberClans.delete(number(member.id));
    }
    state.membershipRevision++;
}

function setActorClan(actor, clanId, privileges) {
    actor.setClanId?.(number(clanId));
    actor.setClanPrivileges?.(number(privileges));
}

function clearActorClan(actor) {
    setActorClan(actor, 0, 0);
    actor.setClanJoinExpiryTime?.(0);
    actor.setClanCreateExpiryTime?.(0);
    actor.setTitle?.('');
}

function ensureSchema() {
    return Database.execute(['SELECT 1', []], 'schema:clans');
}

// The social runtime reads the rosters from this service: the push back is the one lazy link.
function syncSocialMemberships() {
    // lazy: cycle ClanSocialRuntime loads ClanService at its top to read the rosters.
    invoke('GameServer/Clan/ClanSocialRuntime').syncMemberships();
}

const ClanService = {
    rules: ClanRules,
    JOIN_COOLDOWN_MS,
    CREATE_COOLDOWN_MS,

    init() {
        return ensureSchema()
            .then(() => Database.migrateAutonomousClanNames().catch((err) => {
                utils.infoWarn('Clan', 'name migration deferred: %s', err.message);
                return { renamed: [] };
            }))
            .then((result) => {
                if (result.renamed.length) utils.infoSuccess('Clan', 'renamed %d legacy bot clans', result.renamed.length);
            })
            .then(() => this.reload())
            .then(() => ClanCrestService.ensureAutonomousClans())
            .then((result) => result.assigned ? this.reload() : this.all())
            .then(() => invoke('GameServer/Clan/ClanWarRuntime').refresh(true))
            .then(() => utils.infoSuccess('Clan', 'loaded %d clans', state.clans.size))
            .catch((err) => {
                utils.infoWarn('Clan', 'clan tables unavailable: %s', err.message);
            });
    },

    reload() {
        state.clans.clear();
        state.memberClans.clear();
        state.membershipRevision++;
        return Promise.all([
            Database.fetchClans(),
            Database.fetchClanCharacters()
        ]).then(([clans, members]) => {
            // One pass groups the members by clan (in their row order), not one filter per clan.
            const byClan = new Map();
            for (const member of members) {
                const id = number(member.clanId);
                if (!byClan.has(id)) byClan.set(id, []);
                byClan.get(id).push(member);
            }
            clans.forEach((row) => {
                setClan(normalizeClan(row, byClan.get(number(row.id)) || []));
            });
            syncSocialMemberships();
            return Array.from(state.clans.values());
        });
    },

    all() {
        return Array.from(state.clans.values());
    },

    findById(id) {
        return state.clans.get(number(id)) || null;
    },

    // The clan whose cached roster holds this member (the index the membership writers keep).
    clanOfMember(memberId) {
        return state.clans.get(state.memberClans.get(number(memberId))) || null;
    },

    // Moves on every cached membership change (a member or a whole clan in or out).
    membershipRevision() {
        return state.membershipRevision;
    },

    findByName(name) {
        const lookup = ClanRules.normalizeName(name).toLowerCase();
        return this.all().find((clan) => clan.name.toLowerCase() === lookup) || null;
    },

    clanForActor(actor) {
        return this.findById(actor?.fetchClanId?.());
    },

    isLeader(actor, clan = this.clanForActor(actor)) {
        return !!actor && !!clan && number(clan.leaderId) === number(actor.fetchId());
    },

    canCreate(actor, name) {
        const valid = ClanRules.validateClanName(name);
        if (!valid.ok) return valid;
        if (!actor) return { ok: false, code: 'no_actor' };
        if (number(actor.fetchLevel?.()) < 10) return { ok: false, code: 'level_too_low' };
        if (number(actor.fetchClanId?.()) !== 0) return { ok: false, code: 'already_in_clan' };
        if (number(actor.fetchClanCreateExpiryTime?.()) > nowMs()) return { ok: false, code: 'create_cooldown' };
        if (number(actor.fetchClanJoinExpiryTime?.()) > nowMs()) return { ok: false, code: 'join_cooldown' };
        if (this.findByName(valid.name)) return { ok: false, code: 'name_exists' };
        return { ok: true, name: valid.name };
    },

    create(actor, name) {
        const allowed = this.canCreate(actor, name);
        if (!allowed.ok) return Promise.resolve(allowed);

        return Database.createClan({
            name: allowed.name,
            leaderId: actor.fetchId()
        }).then((result) => {
            const clanId = number(result.insertId);
            return Database.updateCharacterClan(actor.fetchId(), clanId, ClanRules.CP_ALL, 0, 0).then(() => {
                const clan = normalizeClan({
                    id: clanId,
                    name: allowed.name,
                    level: 0,
                    leaderId: actor.fetchId()
                }, [actorMember(actor)]);
                setClan(clan);
                syncSocialMemberships();
                setActorClan(actor, clanId, ClanRules.CP_ALL);
                actor.setClanJoinExpiryTime?.(0);
                actor.setClanCreateExpiryTime?.(0);
                return { ok: true, clan };
            });
        });
    },

    canInvite(requestor, target) {
        const clan = this.clanForActor(requestor);
        if (!clan) return { ok: false, code: 'no_clan' };
        if (!ClanRules.hasPrivilege(requestor, ClanRules.CP_CL_JOIN_CLAN)) return { ok: false, code: 'no_privilege' };
        if (!target || number(target.fetchId?.()) === number(requestor.fetchId?.())) return { ok: false, code: 'invalid_target' };
        if (number(clan.charPenaltyExpiryTime) > nowMs()) return { ok: false, code: 'clan_invite_cooldown' };
        if (number(target.fetchClanId?.()) !== 0) return { ok: false, code: 'target_has_clan' };
        if (number(target.fetchClanJoinExpiryTime?.()) > nowMs()) return { ok: false, code: 'target_join_cooldown' };
        if (clan.members.length >= ClanRules.memberLimit(clan.level)) return { ok: false, code: 'clan_full' };
        return { ok: true, clan };
    },

    addMember(clan, actor, privileges = 0) {
        return Database.updateCharacterClan(actor.fetchId(), clan.id, privileges, 0, 0).then(() => {
            setActorClan(actor, clan.id, privileges);
            actor.setClanJoinExpiryTime?.(0);
            replaceMember(clan, actorMember(actor));
            syncSocialMemberships();
            return Database.syncPlayerManagedClan(clan.id).catch((error) => {
                utils.infoWarn('Clan', 'player-managed sync failed after member join: %s', error.message);
                return { ok: false, code: 'automation_sync_failed' };
            }).then((automation) => ({
                ok: true,
                clan,
                member: actorMember(actor),
                automation
            }));
        });
    },

    removeMember(actor, options = {}) {
        const clanId = actor.fetchClanId();
        const clan = this.findById(clanId);
        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        if (!options.force && this.isLeader(actor, clan)) return Promise.resolve({ ok: false, code: 'leader_cannot_leave' });

        return this.removeMemberById(clan, actor.fetchId(), { ...options, actor });
    },

    applyDisciplineRemoval(result) {
        const clan = this.findById(result.clanId);
        const member = clan?.members.find(m => m.id === result.characterId);
        const session = onlineSessionByActorId(result.characterId);
        if (session?.actor) {
            clearActorClan(session.actor);
            session.actor.setClanJoinExpiryTime?.(result.banUntil);
        }
        removeMemberFromCache(result.clanId, result.characterId);
        syncSocialMemberships();
        const Response = invoke('GameServer/Network/Response');
        if (session?.actor && session.actor.backpack) {
            session.dataSendToMe(Response.userInfo(session.actor));
            session.dataSendToMe(Response.pledgeShowMemberListDelete(member?.name || session.actor.fetchName()));
            session.dataSendToOthers(Response.charInfo(session.actor), session.actor);
            session.dataSendToOthers(Response.relationChanged(session.actor), session.actor);
        }
        if (clan && member) this.onlineSessions(clan).forEach(s => {
            s.dataSendToMe(Response.pledgeShowMemberListDelete(member.name));
            s.dataSendToMe(Response.pledgeShowInfoUpdate(clan));
        });
    },

    removeMemberById(clan, memberId, options = {}) {
        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        const member = clan.members.find((entry) => number(entry.id) === number(memberId));
        if (!member) return Promise.resolve({ ok: false, code: 'not_member' });
        if (number(member.id) === number(clan.leaderId)) {
            return Promise.resolve({ ok: false, code: 'leader_cannot_leave' });
        }

        return Database.isAutonomousBotMember(member.id, clan.id).then((permanent) => {
            if (permanent) return { ok: false, code: 'autonomous_membership_permanent' };
            const joinExpiryTime = nowMs() + JOIN_COOLDOWN_MS;
            return Database.removeCharacterFromClan(member.id, joinExpiryTime).then(() => {
                if (options.actor) {
                    clearActorClan(options.actor);
                    options.actor.setClanJoinExpiryTime?.(joinExpiryTime);
                }
                removeMemberFromCache(clan.id, member.id);
                syncSocialMemberships();
                return Database.syncPlayerManagedClan(clan.id).catch((error) => {
                    utils.infoWarn('Clan', 'player-managed sync failed after member removal: %s', error.message);
                    return { ok: false, code: 'automation_sync_failed' };
                }).then((automation) => ({
                    ok: true,
                    clan,
                    member,
                    actor: options.actor || null,
                    automation
                }));
            });
        });
    },

    setMemberTitle(actor, targetActor, title) {
        const clan = this.clanForActor(actor);
        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        if (!ClanRules.hasPrivilege(actor, ClanRules.CP_CL_GIVE_TITLE)) {
            return Promise.resolve({ ok: false, code: 'no_privilege' });
        }
        if (number(clan.level) < 3) return Promise.resolve({ ok: false, code: 'level_too_low' });
        if (!targetActor || number(targetActor.fetchClanId?.()) !== number(clan.id)) {
            return Promise.resolve({ ok: false, code: 'not_member' });
        }

        const value = String(title || '');
        if (value.length > 32) return Promise.resolve({ ok: false, code: 'title_too_long' });

        return Database.updateCharacterTitle(targetActor.fetchId(), value).then(() => {
            targetActor.setTitle?.(value);
            replaceMember(clan, actorMember(targetActor));
            return { ok: true, clan, member: actorMember(targetActor), actor: targetActor };
        });
    },

    applyAutonomousMemberTitles(clanId, assignments) {
        const clan = this.findById(clanId);
        return Database.updateAutonomousClanMemberTitles({ clanId, assignments }).then((result) => {
            if (!result.ok || !clan) return result;
            const ServerResponse = invoke('GameServer/Network/Response');
            const updated = [];
            (result.updated || []).forEach((assignment) => {
                const member = clan.members.find((entry) => number(entry.id) === number(assignment.characterId));
                if (member) member.title = String(assignment.title || '');
                const session = onlineSessionByActorId(assignment.characterId);
                if (session?.actor) {
                    session.actor.setTitle?.(assignment.title);
                    replaceMember(clan, actorMember(session.actor));
                    session.dataSendToMe(ServerResponse.userInfo(session.actor));
                    session.dataSendToOthers?.(ServerResponse.charInfo(session.actor), session.actor);
                    session.dataSendToOthers?.(ServerResponse.relationChanged(session.actor), session.actor);
                }
                updated.push({
                    characterId: number(assignment.characterId),
                    title: String(assignment.title || ''),
                    hot: !!session?.actor
                });
            });
            return { ...result, clan, updated };
        });
    },

    dissolve(actor) {
        const clan = this.clanForActor(actor);
        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        if (!this.isLeader(actor, clan)) return Promise.resolve({ ok: false, code: 'not_leader' });

        // Members are remembered with their characters: a connection that
        // selects a character of another clan during the write keeps that
        // character's clan. Characters of this clan online after the write
        // (an alt selected meanwhile) are cleared and get the dissolve UI.
        const remembered = clanOnlineSessions(clan).map((session) => session.actor);
        return Database.dissolveClan({ clanId: clan.id, leaderId: actor.fetchId() }).then((result) => {
            if (!result.ok) return result;
            const sessions = clanOnlineSessions(clan);
            remembered.forEach(clearActorClan);
            sessions.forEach((memberSession) => clearActorClan(memberSession.actor));
            deleteClan(number(clan.id));
            syncSocialMemberships();
            return { ok: true, clan, sessions, memberIds: result.memberIds || [] };
        });
    },

    setPrivileges(actor, targetActor, privileges) {
        const clan = this.clanForActor(actor);
        if (!clan || !this.isLeader(actor, clan) || !targetActor) {
            return Promise.resolve({ ok: false, code: 'not_authorized' });
        }
        if (number(targetActor.fetchId()) === number(actor.fetchId())) {
            return Promise.resolve({ ok: false, code: 'cannot_change_self' });
        }
        if (number(targetActor.fetchClanId()) !== number(clan.id)) {
            return Promise.resolve({ ok: false, code: 'not_member' });
        }

        const value = number(privileges);
        return Database.updateCharacterClanPrivileges(targetActor.fetchId(), value).then(() => {
            targetActor.setClanPrivileges?.(value);
            replaceMember(clan, actorMember(targetActor));
            return { ok: true, clan };
        });
    },

    changeLevel(clan, level) {
        clan.level = number(level);
        return Database.updateClanLevel(clan.id, clan.level).then(() => ({ ok: true, clan }));
    },

    setSmallCrest(actor, data) {
        const clan = this.clanForActor(actor);
        const crestData = Buffer.from(data || []);

        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        if (!ClanRules.hasPrivilege(actor, ClanRules.CP_CL_MANAGE_CREST)) {
            return Promise.resolve({ ok: false, code: 'no_privilege' });
        }
        if (number(clan.dissolvingExpiryTime) > nowMs()) {
            return Promise.resolve({ ok: false, code: 'clan_dissolving' });
        }
        if (crestData.length === 0) {
            clan.crestId = 0;
            return Database.updateClanCrest(clan.id, 0).then(() => ({ ok: true, clan, deleted: true }));
        }
        if (crestData.length > SMALL_CREST_MAX_BYTES) {
            return Promise.resolve({ ok: false, code: 'crest_too_large' });
        }
        if (number(clan.level) < 3) {
            return Promise.resolve({ ok: false, code: 'level_too_low' });
        }

        return Database.createClanCrest(clan.id, SMALL_CREST_KIND, crestData).then((result) => {
            const crestId = number(result.insertId);
            return Database.updateClanCrest(clan.id, crestId).then(() => {
                clan.crestId = crestId;
                return { ok: true, clan, crestId };
            });
        });
    },

    setPlayerManagedCrest(clanId, data) {
        const id = number(clanId);
        const crestData = Buffer.from(data || []);
        if (!id) return Promise.resolve({ ok: false, code: 'invalid_clan_crest' });
        if (crestData.length && (
            crestData.length !== SMALL_CREST_MAX_BYTES
            || crestData.toString('ascii', 0, 4) !== 'DDS '
            || crestData.readUInt32LE(12) !== 16
            || crestData.readUInt32LE(16) !== 16
            || crestData.toString('ascii', 84, 88) !== 'DXT1'
        )) return Promise.resolve({ ok: false, code: 'invalid_clan_crest' });

        return Database.replacePlayerManagedClanCrest({ clanId: id, data: crestData }).then((result) => {
            if (!result.ok) return result;
            const clan = this.findById(id);
            if (clan) {
                clan.crestId = number(result.crestId);
                const ServerResponse = invoke('GameServer/Network/Response');
                clanOnlineSessions(clan).forEach((memberSession) => {
                    memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clan));
                });
                broadcastClanAppearance(clan);
            }
            return { ...result, clan };
        });
    },

    findSmallCrest(id) {
        const crestId = number(id);
        if (crestId === 0) return Promise.resolve(null);

        return Database.fetchClanCrest(crestId).then(([row]) => {
            if (!row || String(row.kind || SMALL_CREST_KIND) !== SMALL_CREST_KIND) return null;
            return {
                id: number(row.id),
                clanId: number(row.clanId),
                kind: String(row.kind || SMALL_CREST_KIND),
                data: ClanCrestService.clientCrestData(row.data, 'clan')
            };
        });
    },

    SMALL_CREST_MAX_BYTES,
    onlineObjectId,
    syncColdMember(bot) {
        if (!bot || onlineSessionByActorId(bot.characterId)?.actor?.fetchIsOnline?.()) return;
        if (bot.stats?.clanId !== undefined && Number(bot.stats.clanId) === 0) return;
        const clan = state.clans.get(Number(bot.stats?.clanId)) || this.clanOfMember(bot.characterId);
        const member = clan?.members.find(m => m.id === Number(bot.characterId));
        if (!member) return;
        const level = Number(bot.level ?? member.level);
        const classId = Number(bot.stats?.classId ?? member.classId);
        const nameChanged = Boolean(bot.name) && member.name !== bot.name;
        if (member.level === level && member.classId === classId && !nameChanged) return;
        Object.assign(member, { level, classId, online: true });
        if (nameChanged) {
            this.renameMember(bot.characterId, bot.name);
            return;
        }
        const recipients = clanOnlineSessions(clan).filter(s => s.actor?.fetchIsOnline?.());
        if (!recipients.length) return;
        const packet = invoke('GameServer/Network/Response').pledgeShowMemberListUpdate(member);
        recipients.forEach(s => s.dataSendToMe(packet));
    },
    renameMember(characterId, name) {
        const clan = this.clanOfMember(characterId);
        const member = clan?.members.find(m => m.id === Number(characterId));
        if (!member || !name || member.name === name) return;
        member.name = name;
        const Response = invoke('GameServer/Network/Response');
        // C4 incremental member updates are keyed by name. A rename requires
        // replacing the roster so the old row cannot survive in an open window.
        clanOnlineSessions(clan).filter(s => s.actor?.fetchIsOnline?.()).forEach(s => {
            s.dataSendToMe(Response.pledgeShowMemberListDeleteAll());
            s.dataSendToMe(Response.pledgeShowMemberListAll(this.refreshOnlineMembers(clan), s.actor));
        });
    },
    broadcastMemberPresence(actor) {
        const clanId = Number(actor?.fetchClanId?.() || 0);
        if (!clanId) return;
        const Response = invoke('GameServer/Network/Response');
        const recipients = clanOnlineSessions({ id: clanId }).filter(session =>
            session.actor !== actor && session.actor?.fetchIsOnline?.()
        );
        if (!recipients.length) return;
        const packet = Response.pledgeShowMemberListUpdate(actor);
        recipients.forEach(session => session.dataSendToMe(packet));
    },
    liveMember,
    membersForDisplay(clan) {
        return (clan?.members || []).map(liveMember);
    },

    refreshOnlineMembers(clan) {
        if (!clan) return null;

        clan.members = this.membersForDisplay(clan);

        return clan;
    },

    updateActorMember(actor) {
        const clan = this.clanForActor(actor);
        if (!clan) return null;

        const member = actorMember(actor);
        replaceMember(clan, member);
        return { clan, member };
    },

    onlineSessionByActorId,
    onlineSessions: clanOnlineSessions,
    broadcastAppearance: broadcastClanAppearance
};

module.exports = ClanService;
