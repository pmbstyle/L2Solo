const Rules = require('./ClanAmbitionRules');
const Database = invoke('Database');
const { ID, MOB, NPC, ITEM } = Rules;
const world = () => invoke('GameServer/World/World');
const clans = () => invoke('GameServer/Clan/ClanService');
const quests = () => invoke('GameServer/Quest/QuestService');
const response = () => invoke('GameServer/Network/Response');
const idOf = session => Number(session?.actor?.fetchId?.());
const tails = new Map();
const kills = new WeakSet();
const killNpcs = new Set(Rules.KILL_NPCS);
const managed = new Set(Object.values(ITEM));
const index = require('../World/NpcObjectIndex');
const distance = (a, b) => Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY(), a.fetchLocZ() - b.fetchLocZ());

function serialize(session, work) {
    const actor = session.actor;
    const id = idOf(session);
    const next = (tails.get(id) || Promise.resolve()).catch(() => {}).then(() =>
        session.actor === actor ? work(actor) : { ok: false, code: 'character_changed' });
    tails.set(id, next);
    return next.finally(() => { if (tails.get(id) === next) tails.delete(id); });
}

function eligible(session, clan = clans().clanForActor(session.actor)) {
    return clan?.level === 4 && clans().isLeader(session.actor, clan)
        && !(clan.dissolvingExpiryTime > Date.now());
}

function state(session) {
    const log = session.questStates?.get(ID);
    if (log && log.getInt('clanId') === Number(session.actor.fetchClanId?.())) return log.variables;
    return {};
}

function inventoryCounts(session) {
    const counts = {};
    for (const item of session.actor.backpack?.items || []) {
        const id = Number(item.fetchSelfId());
        if (managed.has(id)) counts[id] = (counts[id] || 0) + Number(item.fetchAmount());
    }
    return counts;
}

function syncItems(session, rows) {
    if (!rows.length) return;
    const bag = session.actor.backpack;
    const removed = new Set();
    for (const row of rows) {
        const existing = bag.items.find(item => item.fetchId() === row.id);
        if (existing) {
            existing.setAmount(row.amount);
            if (!row.amount) removed.add(existing);
        } else if (row.amount) bag.insertItem(row.id, row.selfId, row);
    }
    if (removed.size) {
        bag.items = bag.items.filter(item => !removed.has(item));
        require('../Model/Item').bindInventory(bag);
    }
    session.dataSendToMe(response().itemsList(bag.fetchItems()));
}

function encounters(session, attempt, kind) {
    const ownerId = idOf(session);
    return Rules.DYNAMIC_NPCS.flatMap(id => [...index.ofTemplate(world(), id)]).filter(npc => !npc.isDead?.()
        && npc.questSpawn?.questId === ID && npc.questSpawn.ownerId === ownerId
        && npc.ambition?.attempt === attempt && (!kind || kind === npc.ambition.encounter));
}

function despawn(session, attempt) {
    if (!attempt) return;
    for (const npc of encounters(session, attempt))
        invoke('GameServer/World/Generics/SpawnNpcs').despawnQuestNpc(world(), npc);
}

function spawn(session, attempt, anchor, { id, encounter, count }) {
    const existing = encounters(session, attempt, encounter);
    for (let index = existing.length; index < count; index++) {
        const offset = count === 1 ? 0 : 45;
        const npc = world().spawnQuestNpc({
            selfId: id, ownerId: idOf(session), questId: ID,
            locX: anchor.fetchLocX() + offset, locY: anchor.fetchLocY() + (index % 2 ? -offset : offset) * (1 + Math.floor(index / 2)),
            locZ: anchor.fetchLocZ(), despawnDelay: encounter === 'coffer' ? 300000 : 120000
        });
        if (!npc) continue;
        npc.ambition = { attempt, encounter };
        if (id === MOB.blitz || id === MOB.slave) {
            const target = session.actor;
            if (distance(target, npc) <= 1000) npc.addDamageHate?.(session, target, 0, 1, { attacked: false });
        }
    }
}

async function apply(session, actor, clan, event, npc, killer = session) {
    if (event !== 'abort' && !eligible(session, clan)) return { ok: false, code: 'level_four_leader_required' };
    const previous = session.questStates?.get(ID)?.variables || {};
    const roll = event === 'kill' ? Math.random() : 1;
    const rewardSp = event === 'finish' ? Math.round(Rules.SP_REWARD * quests().questRates().questSp) : 0;
    const result = await Database.transitionClanAmbition({
        clanId: clan?.id, leaderId: idOf(session), characterId: idOf(killer), event, npcId: npc?.fetchSelfId(),
        attempt: npc?.ambition?.attempt || (event === 'kill' ? previous.attempt : undefined),
        encounter: npc?.ambition?.encounter, roll, materialRoll: event === 'kill' ? Math.random() : 1, rewardSp
    });
    if (!result.ok || result.skipped || session.actor !== actor) return result;
    const log = quests().stateFor(session, quests().quests().find(quest => quest.id === ID));
    log.state = result.state.cond === 13 ? 'completed' : result.state.cond ? 'started' : 'created';
    log.variables = result.state;

    syncItems(session, result.items);
    for (const [item, amount] of result.awarded || []) quests().transmitItemReceived(session, item, amount);
    if (result.spawn) spawn(session, result.state.attempt, npc, result.spawn);
    if (['start', 'abort', 'eggs', 'coffer', 'finish'].includes(event)) despawn(session, previous.attempt);
    if (result.sp) {
        actor.setSp(actor.fetchSp() + result.sp);
        invoke('GameServer/Persistence/CharacterWriteQueue').experience(idOf(session), actor.fetchLevel(), actor.fetchExp(), actor.fetchSp());
        session.dataSendToMe(response().statusUpdate(idOf(session), [{ id: 0x0d, value: actor.fetchSp() }]));
        const consoleText = invoke('GameServer/ConsoleText');
        consoleText.transmit(session, consoleText.caption.earnedExpAndSp, [
            { kind: consoleText.kind.number, value: 0 }, { kind: consoleText.kind.number, value: result.sp }
        ]);
    }
    if (previous.cond !== result.state.cond) {
        quests().syncActiveQuests(session);
        log.playSound(event === 'start' ? 'ItemSound.quest_accept' : event === 'finish' ? 'ItemSound.quest_finish' : 'ItemSound.quest_middle');
    } else if (result.awarded?.length) log.playSound('ItemSound.quest_itemget');
    return result;
}

function event(session, name, npc) {
    return serialize(session, actor => {
        if (actor.isDead?.() || !npc || npc.isDead?.() || distance(actor, npc) > 250
            || Rules.TALK[name]?.npc !== npc.fetchSelfId())
            return { ok: false, code: 'quest_npc_unavailable' };
        if (npc.fetchSelfId() === NPC.coffer && (npc.questSpawn?.ownerId !== idOf(session) || npc.questSpawn?.questId !== ID))
            return { ok: false, code: 'wrong_coffer' };
        return apply(session, actor, clans().clanForActor(actor), name, npc);
    });
}

function abort(session) {
    return serialize(session, actor => apply(session, actor, clans().clanForActor(actor), 'abort'));
}

function leaderFor(session, npc) {
    const clan = clans().clanForActor(session.actor);
    if (clan?.level !== 4) return null;
    const leader = idOf(session) === clan.leaderId ? session
        : (world().user?.sessions || []).find(candidate => idOf(candidate) === clan.leaderId);
    if (!leader || !state(leader).attempt || leader.actor.isDead?.()
        || leader.actor.fetchIsOnline?.() === false || distance(leader.actor, npc) > 2500) return null;
    if (leader !== session && !invoke('GameServer/Bot/AI/PartyAwareness').partySessions(leader).includes(session)) return null;
    if (npc.questSpawn && (npc.questSpawn.questId !== ID || npc.questSpawn.ownerId !== idOf(leader))) return null;
    return leader;
}

function onKill(session, npc) {
    if (!killNpcs.has(npc.fetchSelfId()) || kills.has(npc)) return Promise.resolve();
    const leader = leaderFor(session, npc);
    if (!leader) return Promise.resolve();
    const actor = session.actor;
    const attempt = state(leader).attempt;
    return serialize(leader, leaderActor => {
        if (session.actor !== actor || state(leader).attempt !== attempt || kills.has(npc)) return;
        const cond = state(leader).cond;
        if (![2, 5, 10].includes(cond)) return;
        const clan = clans().clanForActor(leaderActor);
        if (!eligible(leader, clan)) return;
        kills.add(npc);
        return apply(leader, leaderActor, clan, 'kill', npc, session);
    });
}

function onAttack(session, npc) {
    if (npc.fetchSelfId() !== MOB.keeper || npc.fetchHp() > npc.fetchMaxHp() / 2 || npc.isDead?.()) return;
    const leader = leaderFor(session, npc);
    if (!leader || state(leader).cond !== 10) return;
    if (!npc.ambitionGuarded) {
        npc.ambitionGuarded = true;
        spawn(leader, state(leader).attempt, npc, { id: MOB.slave, encounter: 'keeper_guards', count: 4 });
        return;
    }
    if (session.botSession !== true || npc.ambitionBanishAt > Date.now()
        || session.pendingActorTeleport || Math.random() >= 0.04) return;
    if (invoke('GameServer/Actor/Generics/TeleportTo')(session, session.actor, Rules.KEEPER_BANISHMENT)) {
        npc.ambitionBanishAt = Date.now() + 30000;
    }
}

function raise(session) {
    return serialize(session, async actor => {
        const clan = clans().clanForActor(actor);
        if (!eligible(session, clan)) return { ok: false, code: 'level_four_leader_required' };
        const result = await Database.raiseClanToFive({ clanId: clan.id, characterId: idOf(session) });
        if (!result.ok) return result;
        const current = clans().findById(clan.id);
        if (current) {
            current.level = result.level;
            clans().onlineSessions(current).forEach(member => member.dataSendToMe(response().pledgeShowInfoUpdate(current)));
        }
        if (session.actor === actor) {
            syncItems(session, result.items);
            session.dataSendToMe(response().userInfo(actor));
        }
        return result;
    });
}

module.exports = { eligible, state, inventoryCounts, encounters, event, abort, onKill, onAttack, raise, distance };
