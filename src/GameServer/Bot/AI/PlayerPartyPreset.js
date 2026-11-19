'use strict';

const commands = () => invoke('GameServer/Bot/AI/ClanCommandParty');
const party = () => invoke('GameServer/Bot/AI/PartyCompanionService');
const database = () => invoke('Database');
const id = session => Number(session?.actor?.fetchId?.());
const reference = session => ({ id: id(session), name: session.actor.fetchName() });

function tell(operation, message) {
    if (operation.player.actor !== operation.actor || operation.actor.fetchIsOnline?.() === false) return;
    operation.player.dataSendToMe(invoke('GameServer/Network/Response').speak(operation.actor, { kind: 0, text: message }));
}

function fail(message) {
    const error = new Error(message);
    error.playerMessage = message;
    throw error;
}

function current(operation) {
    return !operation.cancelled && operation.player.partyPresetOperation === operation
        && operation.player.actor === operation.actor && commands().authorized(operation.player);
}

function check(operation) {
    if (!current(operation)) fail('Party operation cancelled.');
}

function cancel(player) {
    if (player?.partyPresetOperation) player.partyPresetOperation.cancelled = true;
}

function normalize(value, ownerId) {
    if (!value || value.version !== 1 || !Array.isArray(value.main) || !value.main.length || value.main.length > 8
        || !Array.isArray(value.additional)) fail('Invalid saved party composition. Use .partysave again.');
    const seen = new Set([ownerId]);
    const members = (rows, max) => {
        if (!Array.isArray(rows) || !rows.length || rows.length > max) fail('Invalid saved party composition. Use .partysave again.');
        return rows.map(row => {
            if (!Number.isSafeInteger(row?.id) || row.id <= 0 || seen.has(row.id))
                fail('Invalid saved party composition. Use .partysave again.');
            seen.add(row.id);
            return { id: row.id, name: typeof row.name === 'string' ? row.name : `#${row.id}` };
        });
    };
    const main = members(value.main, 8);
    const additional = value.additional.map(group => {
        const roster = members(group?.members, 9);
        if (!roster.some(member => member.id === group.leaderId)) fail('Invalid saved party composition. Use .partysave again.');
        return { leaderId: group.leaderId, members: roster };
    });
    return { version: 1, main, additional };
}

function matchAdditionalGroup(groups, wanted) {
    const matches = groups.filter(group => commands().roster(group).some(member => wanted.has(id(member))));
    const conflict = matches.length > 1 || matches.some(group => commands().roster(group).some(member => !wanted.has(id(member))));
    return { group: conflict ? null : matches[0] || null, conflict };
}

function describe(player, value) {
    const roster = normalize(value, id(player));
    const groups = [...(player.commandParties?.values() || [])].filter(group => group.leaderAssigned && commands().current(group));
    const describeParty = (name, leaderName, members, present, includePlayer = false) => {
        const presentIds = new Set(present.map(id));
        return { name, leaderName, expected: members.length + Number(includePlayer),
            missing: members.filter(member => !presentIds.has(member.id)) };
    };
    return [describeParty('Main', player.actor.fetchName(), roster.main, party().membersForLeader(player), true),
        ...roster.additional.map((saved, index) => {
            const wanted = new Set(saved.members.map(member => member.id));
            const { group } = matchAdditionalGroup(groups, wanted);
            const leader = saved.members.find(member => member.id === saved.leaderId);
            return describeParty(`Party ${index + 1}`, leader.name, saved.members, group ? commands().roster(group) : []);
        })];
}

async function settleParties(operation) {
    const groups = [...(operation.player.commandParties?.values() || [])].filter(group => group.active);
    await Promise.all(groups.map(group => group.pending));
    check(operation);
}

async function saveComposition(operation) {
    await settleParties(operation);
    const player = operation.player;
    const groups = [...(player.commandParties?.values() || [])].filter(group => group.active);
    if (groups.some(group => !group.leaderAssigned || !commands().current(group)))
        fail('An additional party is still assembling. Try .partysave again.');
    const main = party().membersForLeader(player);
    if (!main.length) fail('No active main party to save.');
    const roster = normalize({ version: 1, main: main.map(reference),
        additional: groups.map(group => ({ leaderId: id(group.owner), members: commands().roster(group).map(reference) })) }, id(player));
    await database().savePartyPreset(id(player), roster);
    check(operation);
    tell(operation, `Saved main party (${roster.main.length + 1} members) and ${roster.additional.length} additional parties.`);
    return { ok: true, roster };
}

function existingGroups(player, roster) {
    const main = party().membersForLeader(player);
    const wantedMain = new Set(roster.main.map(member => member.id));
    if (main.some(member => !wantedMain.has(id(member))))
        fail('The main party has members outside the saved composition. Remove them before .partyrestore.');
    const groups = [...(player.commandParties?.values() || [])].filter(group => group.active);
    for (const group of groups) if (!commands().current(group) || !group.leaderAssigned)
        fail('An additional party is still assembling. Try .partyrestore again.');
    if (groups.some(group => commands().roster(group).some(member => wantedMain.has(id(member)))))
        fail('A saved main-party member is in an additional party. Remove that member before .partyrestore.');
    return roster.additional.map(saved => {
        const wanted = new Set(saved.members.map(member => member.id));
        if (main.some(member => wanted.has(id(member))))
            fail('A saved additional-party member is in the main party. Remove that member before .partyrestore.');
        const { group, conflict } = matchAdditionalGroup(groups, wanted);
        if (conflict)
            fail('Current additional parties conflict with the saved composition. Adjust them before .partyrestore.');
        return group;
    });
}

async function restoreComposition(operation) {
    const player = operation.player;
    const [row] = await database().fetchPartyPreset(id(player));
    check(operation);
    if (!row) fail('No saved party composition. Use .partysave first.');
    let decoded;
    try { decoded = JSON.parse(row.rosterJson); } catch (_) { fail('Invalid saved party composition. Use .partysave again.'); }
    const roster = normalize(decoded, id(player));
    await settleParties(operation);
    const groups = existingGroups(player, roster);
    const savedMembers = [...roster.main, ...roster.additional.flatMap(group => group.members)];
    const rows = await database().execute(['SELECT id, name FROM characters WHERE id IN (' + savedMembers.map(() => '?').join(',') + ')',
        savedMembers.map(member => member.id)], 'party-preset:characters');
    check(operation);
    const names = new Map(rows.map(member => [Number(member.id), member.name]));
    const unavailable = [];
    const missing = (member, reason) => {
        if (!unavailable.some(entry => entry.id === member.id))
            unavailable.push({ ...member, name: names.get(member.id) || member.name, reason });
    };
    const world = invoke('GameServer/World/World');
    const operationCurrent = () => current(operation);
    tell(operation, 'Restoring saved parties...');
    for (const member of roster.main) {
        check(operation);
        if (party().membersForLeader(player).some(session => id(session) === member.id)) continue;
        const name = names.get(member.id);
        if (!name) { missing(member, 'character_missing'); continue; }
        const accepted = await world.inviteBotByName(player, operation.actor, name, undefined, 'party_restore',
            { isCurrent: operationCurrent });
        check(operation);
        if (!accepted || !party().membersForLeader(player).some(session => id(session) === member.id)) missing(member, 'invite_refused');
    }
    const restored = [];
    for (let index = 0; index < roster.additional.length; index++) {
        check(operation);
        const saved = roster.additional[index];
        const leader = saved.members.find(member => member.id === saved.leaderId);
        const leaderName = names.get(saved.leaderId);
        if (!leaderName || !party().membersForLeader(player).length) {
            missing(leader, leaderName ? 'main_party_unavailable' : 'character_missing');
            continue;
        }
        let group = groups[index];
        if (!group) {
            const before = new Set(player.commandParties?.keys() || []);
            commands().handleCommand(player, `.createparty ${leaderName}`, operationCurrent);
            group = [...(player.commandParties?.values() || [])].find(candidate => !before.has(candidate.number));
            groups[index] = group;
            if (group) await group.pending;
            check(operation);
            if (!group?.active || !commands().current(group) || id(group.owner) !== saved.leaderId) {
                missing(leader, 'leader_unavailable');
                continue;
            }
        } else {
            if (!commands().roster(group).some(session => id(session) === saved.leaderId)) {
                await commands().recruit(group, leaderName, operationCurrent);
                check(operation);
            }
            if (!group.active || !commands().current(group) || !commands().roster(group).some(session => id(session) === saved.leaderId)) {
                missing(leader, 'leader_unavailable');
                continue;
            }
            if (id(group.owner) !== saved.leaderId) commands().handleCommand(player, `.leader-p${group.number} ${leaderName}`);
        }
        for (const member of saved.members) {
            check(operation);
            if (!commands().current(group)) break;
            if (commands().roster(group).some(session => id(session) === member.id)) continue;
            const name = names.get(member.id);
            if (!name) { missing(member, 'character_missing'); continue; }
            await commands().recruit(group, name, operationCurrent);
            check(operation);
            if (!commands().roster(group).some(session => id(session) === member.id)) missing(member, 'invite_refused');
        }
    }
    check(operation);
    // Later invitations yield to chat and lifecycle actions. Audit all parties
    // together instead of reporting their earlier, possibly stale rosters.
    const mainMembers = party().membersForLeader(player);
    const present = new Set();
    for (const member of roster.main) {
        if (mainMembers.some(session => id(session) === member.id)) present.add(member.id);
        else missing(member, 'party_changed');
    }
    const main = present.size;
    for (let index = 0; index < roster.additional.length; index++) {
        const saved = roster.additional[index];
        const group = groups[index];
        if (!group || !commands().current(group)) {
            for (const member of saved.members) missing(member, 'party_unavailable');
            continue;
        }
        const result = { number: group.number, leaderId: saved.leaderId };
        const members = commands().roster(group);
        result.count = 0;
        result.expected = saved.members.length;
        for (const member of saved.members) {
            if (members.some(session => id(session) === member.id)) { present.add(member.id); result.count++; }
            else missing(member, 'party_changed');
        }
        result.complete = result.count === result.expected && members.length === result.expected && id(group?.owner) === saved.leaderId;
        restored.push(result);
    }
    const stillUnavailable = unavailable.filter(member => !present.has(member.id));
    const complete = main === roster.main.length && mainMembers.length === roster.main.length
        && restored.length === roster.additional.length && restored.every(group => group.complete);
    const missingIds = new Set(stillUnavailable.map(member => member.id));
    const reportMissing = (label, members) => {
        const missingNames = members.filter(member => missingIds.has(member.id)).map(member => names.get(member.id) || member.name);
        if (missingNames.length) tell(operation, `${label} unavailable: ${missingNames.join(', ')}. Use .partyrestore to retry.`);
    };
    tell(operation, `Main party: ${main + 1}/${roster.main.length + 1}.`);
    reportMissing('Main party', roster.main);
    for (let index = 0; index < roster.additional.length; index++) {
        const saved = roster.additional[index];
        const result = restored.find(group => group.leaderId === saved.leaderId);
        const leader = saved.members.find(member => member.id === saved.leaderId);
        const label = result ? `Additional party ${result.number}` : `Additional party (${names.get(saved.leaderId) || leader.name})`;
        tell(operation, `${label}: ${result?.count || 0}/${saved.members.length}.`);
        reportMissing(label, saved.members);
    }
    if (!stillUnavailable.length && !complete) tell(operation, 'Party composition changed during assembly. Use .partyrestore to retry.');
    return { ok: true, complete, main, additional: restored, unavailable: stillUnavailable };
}

function start(player, action) {
    const operation = { player, actor: player?.actor, action, cancelled: false };
    if (!commands().authorized(player)) {
        if (operation.actor) tell(operation, 'A clan leader is required to save or restore parties.');
        return Promise.resolve({ ok: false, reason: 'not_clan_leader' });
    }
    if (player.partyPresetOperation) {
        tell(operation, 'A party save or restore is already in progress.');
        return Promise.resolve({ ok: false, reason: 'busy' });
    }
    player.partyPresetOperation = operation;
    operation.promise = (async () => {
        try { return await (action === 'save' ? saveComposition(operation) : restoreComposition(operation)); }
        catch (error) {
            const cancelled = !current(operation);
            if (player.partyPresetOperation === operation)
                tell(operation, cancelled ? 'Party operation cancelled.' : error.playerMessage || 'Could not save or restore parties. Try again.');
            if (!cancelled && !error.playerMessage) utils.infoWarn('PartySave', '%s failed: %s', action, error.message);
            return { ok: false, reason: cancelled ? 'cancelled' : error.playerMessage ? 'unavailable' : 'error' };
        } finally {
            if (player.partyPresetOperation === operation) delete player.partyPresetOperation;
        }
    })();
    return operation.promise;
}

function handleCommand(player, text) {
    const match = /^\.(partysave|partyrestore)$/i.exec(String(text || '').trim());
    if (!match) return false;
    start(player, match[1].toLowerCase() === 'partysave' ? 'save' : 'restore');
    return true;
}

module.exports = { save: player => start(player, 'save'), restore: player => start(player, 'restore'), describe, cancel, handleCommand };
