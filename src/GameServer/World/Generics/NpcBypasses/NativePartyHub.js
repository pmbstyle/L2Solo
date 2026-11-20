'use strict';

const Protocol = invoke('GameServer/World/Generics/NativePartyHubProtocol');
const A = Protocol.ACTION;
const party = () => invoke('GameServer/Bot/AI/PartyCompanionService');
const command = () => invoke('GameServer/Bot/AI/ClanCommandParty');
const friends = () => invoke('GameServer/Bot/AI/BotFriendship');
const finder = () => invoke('GameServer/World/Generics/NpcBypasses/BotParty');
const control = () => invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const presets = () => invoke('GameServer/Bot/AI/PlayerPartyPreset');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const world = () => invoke('GameServer/World/World');
const id = member => Number(member?.actor?.fetchId?.() || member?.fetchId?.() || member?.characterId || member?.botId || 0);
const valid = (session, hub) => session.actor === hub.actor && session.partyHub === hub && [1, 2].includes(hub.version);
const leader = session => command().authorized(session);
const group = (session, scope) => /^p[1-9]\d*$/.test(scope) ? session.commandParties?.get(Number(scope.slice(1))) : null;
const currentGroup = (session, scope) => { const found = group(session, scope); return found && command().current(found) ? found : null; };
const sameClan = (session, subject) => invoke('GameServer/Bot/AI/ClanLeaderPartyInvite').isLeaderFor(session, subject);
const number = value => /^\d{1,6}$/.test(value || '') ? Number(value) : null;
const viewKey = ({ tab, scope, source, page, groupPage, query, level, role, sort }) =>
    [tab, scope, source, page, groupPage, query, level, role, sort].join('|');

function settings(session) {
    const hub = session.partyHub;
    if (!leader(session)) {
        hub.scope = 'main'; hub.groupPage = 0;
        if (hub.tab === 'saved') hub.tab = 'party';
        if (hub.source === 'clan') hub.source = 'friends';
    }
    if (!['main', 'all', 'new'].includes(hub.scope) && !currentGroup(session, hub.scope)) hub.scope = 'main';
    if (hub.scope === 'new' && !party().membersForLeader(session).length) hub.scope = 'main';
    if (hub.scope !== 'main' && hub.source === 'finder') hub.source = 'clan';
    return hub;
}

function groupRows(session) {
    const rows = [{ key: 'main', leaderId: id(session), name: session.actor.fetchName(),
        count: party().membersForLeader(session).length + 1, movement: party().getSettings(session).movementMode }];
    if (leader(session)) for (const entry of session.commandParties?.values() || []) {
        if (!command().current(entry)) continue;
        rows.push({ key: `p${entry.number}`, leaderId: id(entry.owner), name: entry.owner.actor.fetchName(),
            count: command().roster(entry).length, movement: entry.movement });
    }
    return rows;
}

function memberRows(session, hub) {
    if (hub.scope === 'all') return groupRows(session).slice(hub.page * 8, (hub.page + 1) * 8)
        .map((row, index) => ({ id: index + 1, name: row.key === 'main' ? 'Main' : row.key,
            detail: row.name, note: row.movement, count: row.count, expected: 9 }));
    const selected = currentGroup(session, hub.scope);
    if (hub.scope !== 'main' && !selected) return [];
    const views = hub.scope === 'main' ? control().views(session)
        : command().roster(selected).map(member => {
            const presentation = invoke('GameServer/Bot/AI/BotRoles').presentation(member);
            return { id: id(member), name: member.actor.fetchName(), level: member.actor.fetchLevel(),
                classId: presentation.classId, className: presentation.className,
                note: member.actor.isDead?.() ? 'Dead' : member.botStay ? 'Hold' : 'Follow',
                leader: member === selected.owner };
        });
    return views.map(view => ({ id: view.id, name: view.name, level: view.level, classId: view.classId,
        detail: view.className, note: view.note, selected: view.stance === 'hold', leader: view.leader,
        actions: hub.scope === 'main' ? A.HOLD | A.CALL | (view.canPull ? A.PULL : 0) : A.KICK | (!view.leader ? A.LEADER : 0),
        count: view.stance === 'pulling' ? 1 : 0 }));
}

function recruitmentRows(session, hub) {
    const range = finder().LEVEL_RANGES.find(r => r.key === hub.level);
    const role = finder().ROLE_FILTERS.find(r => r.key === hub.role);
    const additional = hub.scope !== 'main';
    const candidates = finder().catalog(session).filter(c => (!hub.query || c.name.toLowerCase().includes(hub.query.toLowerCase()))
        && (!range || c.level >= range.min && c.level <= range.max)
        && (hub.role === 'all' || (hub.role === 'spoiler' ? c.profession.role === 'spoiler' : role?.roles.includes(c.profession.role)))
        && (hub.source !== 'clan' || sameClan(session, c.subject)));
    const ownedIds = new Set(party().membersForLeader(session).map(id));
    for (const entry of session.commandParties?.values() || []) for (const member of command().roster(entry)) ownedIds.add(id(member));
    const available = candidate => !ownedIds.has(id(candidate.subject))
        && (additional ? sameClan(session, candidate.subject) : candidate.availability.available);
    for (const candidate of candidates) candidate.availability = finder().availability(session, candidate);
    candidates.sort((a, b) => {
        if (hub.version === 1) {
            const availability = Number(available(b)) - Number(available(a));
            if (availability) return availability;
        }
        const name = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
        const level = a.level - b.level;
        const order = hub.sort === 'name_asc' ? name || level : hub.sort === 'name_desc' ? -name || level
            : hub.sort === 'level_desc' ? -level || name : level || name;
        return order || id(a.subject) - id(b.subject);
    });
    const pages = Math.max(1, Math.ceil(candidates.length / 8));
    hub.page = Math.min(hub.page, pages - 1);
    const rows = candidates.slice(hub.page * 8, (hub.page + 1) * 8).map(c => {
        const availability = c.availability;
        const botId = id(c.subject);
        const owned = ownedIds.has(botId);
        const canInvite = available(c);
        return { id: botId, name: c.name, level: c.level, classId: c.profession.classId,
            detail: c.profession.className, note: owned ? 'In party' : canInvite ? c.phase === 'hot' ? 'Active' : 'Background' : availability.reasonText,
            actions: canInvite ? A.INVITE : 0 };
    });
    return { rows, pages, total: candidates.length };
}

async function friendRows(session, hub) {
    let result = await friends().listWindowPage(session, hub.source === 'add' ? 'add' : 'friends', hub.page);
    if (!result.rows.length && hub.page > 0) { hub.page--; result = await friends().listWindowPage(session, hub.source === 'add' ? 'add' : 'friends', hub.page); }
    const rows = result.rows.map(bot => {
        const additional = hub.scope !== 'main';
        const state = life().cachedState(Number(bot.botId));
        const clan = !additional || sameClan(session, state || { characterId: Number(bot.botId) });
        const owned = groupRows(session).some(g => g.key === 'main' ? party().membersForLeader(session).some(m => id(m) === Number(bot.botId))
            : command().roster(currentGroup(session, g.key)).some(m => id(m) === Number(bot.botId)));
        return { id: Number(bot.botId), name: bot.name, level: bot.level, classId: bot.classId,
            detail: bot.className, note: hub.source === 'add' ? `Trust ${Number(bot.trust).toFixed(1)}/${friends().FRIEND_TRUST}`
                : owned ? 'In party' : !clan ? 'Clan only' : bot.activity || '', selected: bot.selected,
            actions: hub.source === 'add' ? (bot.trust >= friends().FRIEND_TRUST ? A.ADD : 0)
                : A.REMOVE | (!additional ? A.CONST : 0) | (!owned && clan ? A.INVITE : 0) };
    });
    return { rows, pages: hub.page + (result.hasNext ? 2 : 1), total: 0 };
}

async function savedRows(session, hub) {
    const [record] = await invoke('Database').fetchPartyPreset(id(session));
    if (!record) return { rows: [], pages: 1, total: 0, saved: false };
    const entries = presets().describe(session, JSON.parse(record.rosterJson));
    const pages = Math.max(1, Math.ceil(entries.length / 8)); hub.page = Math.min(hub.page, pages - 1);
    const rows = entries.slice(hub.page * 8, (hub.page + 1) * 8).map((entry, i) => {
        const { missing } = entry;
        const names = missing.map(member => member.name).join(', ');
        return { id: hub.page * 8 + i + 1, name: entry.name, detail: entry.leaderName,
            note: names.length > Protocol.NOTE_LIMIT ? `${missing.length} missing. Restore lists names in chat.` : names,
            count: entry.expected - missing.length, expected: entry.expected };
    });
    return { rows, pages, total: entries.length, saved: true };
}

async function render(session, message = '') {
    const hub = session.partyHub;
    if (!hub || !valid(session, hub) || !hub.open) return;
    settings(session);
    const generation = ++hub.generation;
    const requestedView = viewKey(hub);
    const view = { ...hub };
    let data = { rows: [], pages: 1, total: 0 };
    let selectedCount = 0;
    try {
        if (view.tab === 'party') {
            if (view.scope === 'all') { data.total = groupRows(session).length; data.pages = Math.max(1, Math.ceil(data.total / 8)); view.page = Math.min(view.page, data.pages - 1); }
            data.rows = memberRows(session, view);
        } else if (view.tab === 'saved') data = await savedRows(session, view);
        else if (view.scope !== 'all') {
            data = ['friends', 'add'].includes(view.source) ? await friendRows(session, view) : recruitmentRows(session, view);
            if (view.source === 'friends') selectedCount = await friends().selectedCount(session);
        }
    } catch (error) {
        utils.infoWarn('PartyHub', 'list failed: %s', error.message);
        data = { rows: [], pages: 1, total: 0 }; message = 'Could not load. Try Refresh.';
    }
    if (!valid(session, hub) || !hub.open || hub.generation !== generation) return;
    settings(session);
    if (viewKey(hub) !== requestedView) return render(session);
    const all = groupRows(session);
    const groupPages = Math.max(1, Math.ceil((all.length - 1) / 7));
    hub.groupPage = Math.min(hub.groupPage, groupPages - 1); hub.page = Math.min(view.page, data.pages - 1);
    const groups = leader(session) ? [all[0], ...all.slice(1 + hub.groupPage * 7, 8 + hub.groupPage * 7)] : [];
    const selectedGroup = currentGroup(session, hub.scope);
    const currentSettings = party().getSettings(session);
    const revision = hub.revision + 1;
    const snapshot = { ...hub, revision, open: true, leader: leader(session), pages: data.pages, total: data.total,
        groupPages, groupTotal: all.length, selectedCount, combat: currentSettings.combatMode,
        movement: selectedGroup?.movement || currentSettings.movementMode,
        pull: currentSettings.pullMode, loot: currentSettings.lootPickupEnabled !== false, message,
        busy: !!session.partyHubOperation || !!session.partyPresetOperation,
        canCreate: leader(session) && party().membersForLeader(session).length > 0, saved: data.saved };
    const packet = invoke('GameServer/Network/Response').npcHtml(id(session), Protocol.encode(snapshot, groups, data.rows));
    hub.revision = revision;
    hub.publishedView = viewKey(hub);
    hub.visible = data.rows;
    hub.visiblePages = data.pages;
    session.dataSendToMe(packet);
}

function open(session, target = 'party', version) {
    if (!session.actor || session.characterLeaving) return;
    const old = session.partyHub;
    const sameActor = old?.actor === session.actor;
    if (target === 'friends' && !sameActor && session.botFriendsView?.mode === 'add') target = 'add';
    session.nativePartyHubVersion = version ?? (session.nativePartyHubVersion || 1);
    const hub = session.partyHub = { actor: session.actor, version: session.nativePartyHubVersion, open: true,
        epoch: session.partyHubEpoch = (session.partyHubEpoch || 0) + 1, revision: 0, generation: 0,
        tab: target === 'party' ? 'party' : 'recruit', scope: target === 'party' && sameActor && old.scope !== 'new' ? old.scope : 'main',
        source: target === 'party' ? sameActor ? old.source : 'friends' : target,
        page: 0, groupPage: sameActor ? old.groupPage : 0, query: '', level: 'all', role: 'all', sort: 'level_asc' };
    if (!['friends', 'finder', 'add', 'clan'].includes(hub.source)) hub.source = 'friends';
    session.nativePartyUiOpen = false; session.nativeFinderOpen = false; session.nativeFriendsOpen = false;
    session.nativeFriendsRevision = (session.nativeFriendsRevision || 0) + 1;
    return render(session);
}

async function mutate(session, run) {
    if (session.partyHubOperation || session.partyPresetOperation) return render(session, 'Working...');
    const actor = session.actor;
    const operation = session.partyHubOperation = {};
    const current = () => session.actor === actor && session.partyHubOperation === operation;
    let message = '';
    try { message = await run(current) || ''; }
    catch (error) { utils.infoWarn('PartyHub', 'action failed: %s', error.message); message = 'Action failed. Try Refresh.'; }
    finally {
        const notify = current();
        if (session.partyHubOperation === operation) delete session.partyHubOperation;
        if (notify) await render(session, message);
    }
}

async function inviteRow(session, hub, row, current) {
    const actor = session.actor;
    const state = await life().findByName(row.name);
    if (!current() || id(state) !== row.id) return 'Unavailable.';
    const subject = invoke('GameServer/Bot/BotManager').findSessionById(row.id) || state;
    if (hub.scope !== 'main') {
        if (!leader(session) || !sameClan(session, subject)) return 'Clan only.';
        if (hub.scope === 'new') {
            command().handleCommand(session, `.createparty ${state.name}`, current);
            const created = session.commandParties?.get(session.nextCommandPartyNumber);
            if (created) await created.pending;
            if (!current()) return;
            if (created && command().current(created)) {
                if (session.partyHub?.epoch === hub.epoch && session.partyHub.actor === actor) session.partyHub.scope = `p${created.number}`;
                return 'Party created.';
            }
            return 'Unavailable.';
        }
        const selected = currentGroup(session, hub.scope);
        if (!selected) return 'Party changed.';
        command().handleCommand(session, `.invite-${hub.scope} ${state.name}`, current);
        await selected.pending;
        return command().current(selected) && command().roster(selected).some(member => id(member) === row.id) ? 'Joined.' : 'Unavailable.';
    }
    const accepted = hub.source === 'friends'
        ? await world().inviteFriendByName(session, actor, state.name, undefined, 'party_hub_friend', { isCurrent: current })
        : await world().inviteBotByName(session, actor, state.name, undefined, 'party_hub', { isCurrent: current });
    return accepted ? 'Joined.' : 'Unavailable.';
}

async function handler(session, parts) {
    if (!session?.actor || session.characterLeaving) return;
    const action = parts[1];
    if (action === 'open') {
        if (['1', '2'].includes(parts[2])) return open(session, parts[3], Number(parts[2]));
        if (parts[2] === '0') {
            delete session.partyHub;
            session.nativePartyHubVersion = 0;
            session.nativePartyUiVersion = 0;
            return control().render(session, 0, { open: true });
        }
        return;
    }
    const hub = session.partyHub;
    if (!hub || !valid(session, hub) || String(hub.epoch) !== parts[2]) return;
    if (action === 'close') { hub.open = false; hub.generation++; hub.visible = []; return; }
    if (!hub.open) return;
    if (String(hub.revision) !== parts[3]) return render(session);
    const addressed = viewKey(hub);
    settings(session);
    if (addressed !== viewKey(hub) || action === 'refresh') return render(session);
    if (hub.publishedView !== addressed) return;
    const args = parts.slice(4);
    if (action === 'tab') {
        if (!['party', 'recruit', ...(leader(session) ? ['saved'] : [])].includes(args[0])) return;
        hub.tab = args[0]; hub.page = 0; return render(session);
    }
    if (action === 'scope') {
        if (args[0] !== 'main' && (!leader(session) || !['all', 'new'].includes(args[0]) && !currentGroup(session, args[0]))) return;
        if (args[0] === 'new' && !party().membersForLeader(session).length) return;
        hub.scope = args[0]; hub.page = 0;
        if (hub.scope === 'new') { hub.tab = 'recruit'; hub.source = 'clan'; }
        return render(session);
    }
    if (action === 'source' && hub.tab === 'recruit') {
        if (!['friends', 'add', ...(hub.scope === 'main' ? ['finder'] : []), ...(leader(session) ? ['clan'] : [])].includes(args[0])) return;
        hub.source = args[0]; hub.page = 0; return render(session);
    }
    if (action === 'page' || action === 'groups') {
        const next = number(args[0]); if (next === null) return;
        if (action === 'groups') { if (!leader(session) || next >= Math.max(1, Math.ceil((groupRows(session).length - 1) / 7))) return; hub.groupPage = next; }
        else { if (next >= (hub.visiblePages || 1)) return; hub.page = next; }
        return render(session);
    }
    if (action === 'filter' && hub.tab === 'recruit' && ['finder', 'clan'].includes(hub.source)) {
        if (args.length !== (hub.version === 2 ? 4 : 3)
            || !['all', ...finder().LEVEL_RANGES.map(r => r.key)].includes(args[1])
            || !['all', 'spoiler', ...finder().ROLE_FILTERS.map(r => r.key)].includes(args[2])
            || hub.version === 2 && !Protocol.SORTS.includes(args[3])) return;
        hub.query = args[0] === '-' ? '' : finder().searchText(args[0]); hub.level = args[1]; hub.role = args[2]; hub.page = 0;
        if (hub.version === 2) hub.sort = args[3];
        return render(session);
    }
    const view = { ...hub };
    if (action === 'order' && hub.tab === 'party' && session.actor.isDead?.() !== true) {
        const [kind, value] = args;
        const allowed = { combat: ['assist', 'protect', 'passive'], pull: ['auto', 'leader', 'off'], loot: ['on', 'off'] };
        if (kind === 'move' && ['follow', 'hold', 'regroup'].includes(value)) {
            if (hub.scope === 'main') control()(session, ['companion-control', value === 'regroup' ? 'regroup' : 'movement', value]);
            else if (leader(session) && (hub.scope === 'all' || currentGroup(session, hub.scope))) command().handleCommand(session, `.${hub.scope} ${value}`);
            else return;
        } else if (hub.scope === 'main' && Object.hasOwn(allowed, kind) && allowed[kind].includes(value)) control()(session, ['companion-control', kind, value]);
        else return;
        return render(session);
    }
    if (action === 'dismiss' && hub.tab === 'party' && leader(session) && currentGroup(session, hub.scope)) {
        command().handleCommand(session, `.dismiss-${hub.scope}`); hub.scope = 'main'; return render(session);
    }
    if (action === 'save' || action === 'restore') {
        if (hub.tab !== 'saved' || !leader(session)) return;
        return mutate(session, async () => {
            const result = await presets()[action](session);
            return result.ok ? action === 'save' ? 'Saved.' : result.complete ? 'Restored.' : 'Partially restored.' : 'Could not complete.';
        });
    }
    if (action === 'form' && hub.tab === 'recruit' && hub.scope === 'main' && hub.source === 'friends') {
        return mutate(session, async current => {
            const actor = session.actor;
            const bots = await friends().selected(session);
            if (!current()) return;
            const formation = await invoke('GameServer/Bot/AI/ConstPartySession').prepareFormation(session, actor, bots, current);
            let complete = false;
            let joined = 0;
            try {
                for (const bot of bots) {
                    if (!current()) return;
                    if (await world().inviteFriendByName(session, actor, bot.characterName || bot.name, undefined, 'friend_const', { isCurrent: current })) joined++;
                }
                complete = true;
                return `Party invitations processed: ${joined} / ${bots.length}.`;
            } finally {
                if (!complete || !current()) await formation?.rollback();
            }
        });
    }
    const row = hub.visible?.find(entry => String(entry.id) === args[0]);
    const flags = { invite: A.INVITE, const: A.CONST, remove: A.REMOVE, add: A.ADD, hold: A.HOLD, follow: A.HOLD,
        pull: A.PULL, 'stop-pull': A.PULL, call: A.CALL, leader: A.LEADER, kick: A.KICK };
    if (!row || !(row.actions & flags[action])) return;
    if (['hold', 'follow', 'pull', 'stop-pull', 'call'].includes(action)) {
        if (hub.tab !== 'party' || hub.scope !== 'main') return;
        const member = party().membersForLeader(session).find(member => id(member) === row.id); if (!member) return render(session);
        const sub = { hold: 'stay', follow: 'follow', call: 'summon' }[action];
        control()(session, sub ? ['companion-control', sub, member.actor.fetchName()]
            : ['companion-control', 'member-pull', action === 'pull' ? 'on' : 'off', member.actor.fetchName()]);
        return render(session);
    }
    if (action === 'leader' || action === 'kick') {
        const selected = currentGroup(session, hub.scope);
        if (hub.tab !== 'party' || !leader(session) || !selected) return;
        const member = command().roster(selected).find(member => id(member) === row.id); if (!member) return render(session);
        command().handleCommand(session, `.${action}-${hub.scope} ${member.actor.fetchName()}`); return render(session);
    }
    if (hub.tab !== 'recruit') return;
    return mutate(session, async current => {
        if (action === 'invite') return inviteRow(session, view, row, current);
        if (action === 'const' && view.source === 'friends' && view.scope === 'main') { const result = await friends().toggleConst(session, row.id); return result.ok ? '' : result.reason === 'const_full' ? 'Const party is full.' : 'Unavailable.'; }
        if (action === 'remove' && view.source === 'friends') { const result = await friends().remove(session, row.id); return result.ok ? 'Removed.' : 'Unavailable.'; }
        if (action === 'add' && view.source === 'add') { const state = await life().findByName(row.name); if (!current() || id(state) !== row.id) return 'Unavailable.'; const result = await friends().request(session, state); return result.ok ? 'Added.' : 'Declined.'; }
    });
}

handler.open = open;
handler.render = render;
module.exports = handler;
