const Database = invoke('Database');
const ClanRules = invoke('GameServer/Clan/ClanRules');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');

const DAY_MS = 86400000;
const JOIN_COOLDOWN_MS = 5 * DAY_MS;
const CREATE_COOLDOWN_MS = 10 * DAY_MS;
const SMALL_CREST_KIND = 'pledge';
const SMALL_CREST_MAX_BYTES = 256;

const state = {
    clans: new Map()
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
    return session?.actor?.fetchIsOnline?.() ? member.id : 0;
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

function liveMember(member) {
    const session = onlineSessionByActorId(member.id);
    if (!session?.actor) return normalizeMember(member);

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
    clan.members = clan.members.filter((entry) => Number(entry.id) !== Number(member.id));
    clan.members.push(normalizeMember(member));
}

function removeMemberFromCache(clanId, actorId) {
    const clan = state.clans.get(number(clanId));
    if (!clan) return;
    clan.members = clan.members.filter((entry) => Number(entry.id) !== Number(actorId));
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

const ClanService = {
    rules: ClanRules,
    JOIN_COOLDOWN_MS,
    CREATE_COOLDOWN_MS,

    init() {
        return ensureSchema()
            .then(() => this.reload())
            .then(() => ClanCrestService.ensureAutonomousClans())
            .then((result) => result.assigned ? this.reload() : this.all())
            .then(() => utils.infoSuccess('Clan', 'loaded %d clans', state.clans.size))
            .catch((err) => {
                utils.infoWarn('Clan', 'clan tables unavailable: %s', err.message);
            });
    },

    reload() {
        state.clans.clear();
        return Promise.all([
            Database.fetchClans(),
            Database.fetchClanCharacters()
        ]).then(([clans, members]) => {
            clans.forEach((row) => {
                const clanMembers = members.filter((member) => number(member.clanId) === number(row.id));
                state.clans.set(number(row.id), normalizeClan(row, clanMembers));
            });
            return Array.from(state.clans.values());
        });
    },

    all() {
        return Array.from(state.clans.values());
    },

    findById(id) {
        return state.clans.get(number(id)) || null;
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
                state.clans.set(clanId, clan);
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
            return { ok: true, clan, member: actorMember(actor) };
        });
    },

    removeMember(actor, options = {}) {
        const clanId = actor.fetchClanId();
        const clan = this.findById(clanId);
        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        if (!options.force && this.isLeader(actor, clan)) return Promise.resolve({ ok: false, code: 'leader_cannot_leave' });

        return this.removeMemberById(clan, actor.fetchId(), { ...options, actor });
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
            return Database.removeCharacterFromClan(member.id).then(() => {
                if (options.actor) clearActorClan(options.actor);
                removeMemberFromCache(clan.id, member.id);
                return { ok: true, clan, member, actor: options.actor || null };
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

    dissolve(actor) {
        const clan = this.clanForActor(actor);
        if (!clan) return Promise.resolve({ ok: false, code: 'no_clan' });
        if (!this.isLeader(actor, clan)) return Promise.resolve({ ok: false, code: 'not_leader' });

        const sessions = clanOnlineSessions(clan);
        return Database.dissolveClan({ clanId: clan.id, leaderId: actor.fetchId() }).then((result) => {
            if (!result.ok) return result;
            sessions.forEach((memberSession) => {
                if (memberSession.actor) clearActorClan(memberSession.actor);
            });
            state.clans.delete(number(clan.id));
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
    liveMember,
    membersForDisplay(clan) {
        return (clan?.members || []).map(liveMember);
    },

    refreshOnlineMembers(clan) {
        if (!clan) return null;

        clanOnlineSessions(clan).forEach((session) => {
            if (session.actor) {
                replaceMember(clan, actorMember(session.actor));
            }
        });

        return clan;
    },

    updateActorMember(actor) {
        const clan = this.clanForActor(actor);
        if (!clan) return null;

        const member = actorMember(actor);
        replaceMember(clan, member);
        return { clan, member };
    },

    onlineSessions: clanOnlineSessions
};

module.exports = ClanService;
