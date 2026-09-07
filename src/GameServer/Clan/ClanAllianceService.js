const Rules = require('./ClanAllianceRules');
const Database = invoke('Database');
const records = new Map();
const tails = new Map();
const processedKills = new WeakSet();
const sessions = () => invoke('GameServer/World/World').user?.sessions || [];
const idOf = session => Number(session?.actor?.fetchId?.() || 0);
const clanOf = session => Number(session?.actor?.fetchClanId?.() || 0);
const botSession = session => String(session?.accountId || '').startsWith('bot_');
const online = session => session?.actor && session.actor.fetchIsOnline?.() !== false;
const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const near = (a, b, radius = Rules.INTERACTION_RADIUS) => a && b && Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY(), a.fetchLocZ() - b.fetchLocZ()) <= radius;
const NPC_EVENTS = { start: Rules.NPC.rodemai, finish: Rules.NPC.rodemai, ritual: Rules.NPC.kalis,
    poison: Rules.NPC.kalis, cure: Rules.NPC.kalis, fail: Rules.NPC.kalis, pledge: Rules.NPC.altar,
    chests: Rules.NPC.athrea, blood: Rules.NPC.athrea, deliver: Rules.NPC.kalis };

function serialize(clanId, work) {
    const previous = tails.get(clanId) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    tails.set(clanId, next);
    return next.finally(() => { if (tails.get(clanId) === next) tails.delete(clanId); });
}
function active(state) { return state?.kind === 'player' && ['started', 'loyalty', 'gathering', 'cured'].includes(state.stage); }
function publish(clanId, state) {
    records.set(Number(clanId), state);
    for (const session of sessions().filter(s => clanOf(s) === Number(clanId) || s.clanAllianceQuest?.clanId === Number(clanId) || idOf(s) === state?.leaderId)) {
        const member = clanOf(session) === Number(clanId) && active(state) && state.members.find(m => m.id === idOf(session));
        if (member && !session.clanAllianceQuest && botSession(session)) {
            session.actor.automation?.abortAll?.(session.actor);
            if (session.spotRelocation) invoke('GameServer/Bot/AI/BotSpotTravel').cancel(session, session.actor, 'clan_quest_started');
        }
        if (!active(state) && session.actor.effects?.clan_alliance_poison) stopPoison(session);
        if (!member) { session.clanAllianceReport = null; session.clanAllianceRecovering = false; }
        session.clanAllianceQuest = member ? { clanId: Number(clanId), leaderId: state.leaderId } : null;
        if (member && botSession(session)) invoke('GameServer/Bot/AI/HotActorLodPolicy').promote?.(session, 'clan_quest');
    }
}
async function snapshot(session) {
    const clanId = clanOf(session);
    if (!clanId) return null;
    return serialize(clanId, async () => {
        const previous = records.get(clanId);
        const state = await Database.fetchClanAllianceQuest(clanId);
        publish(clanId, state);
        if (active(previous) && !active(state)) {
            for (const member of sessions().filter(s => idOf(s) === previous.leaderId || previous.members.some(m => m.id === idOf(s)))) await syncInventory(member);
        }
        return state;
    });
}
async function syncInventory(session) {
    if (!online(session)) return;
    const rows = await Database.fetchItems(idOf(session));
    const bag = session.actor.backpack;
    const managed = new Set(Object.keys(Rules.ITEMS).map(Number));
    bag.items = bag.items.filter(item => !managed.has(Number(item.fetchSelfId())));
    for (const row of rows.filter(row => managed.has(Number(row.selfId)))) bag.insertItem(Number(row.id), Number(row.selfId), { amount: Number(row.amount) });
    const adena = bag.fetchItemFromSelfId(57);
    const savedAdena = rows.find(row => Number(row.id) === Number(adena?.fetchId()));
    if (adena && savedAdena) adena.setAmount(Number(savedAdena.amount));
    else if (adena) bag.items = bag.items.filter(item => item !== adena);
    session.dataSendToMe(invoke('GameServer/Network/Response').itemsList(bag.fetchItems()));
}
function stopPoison(session) {
    const actor = session?.actor;
    if (!actor) return;
    invoke('GameServer/Effects/EffectTicker').clear(actor, 'clan_alliance_poison');
    invoke('GameServer/Effects/EffectStore').remove(actor, 'clan_alliance_poison');
    invoke('GameServer/Effects/EffectTicker').refreshEffects(session, actor);
}
function poison(session, state) {
    if (state?.stage !== 'gathering' || idOf(session) !== state.leaderId || session.actor.isDead()) return;
    const store = invoke('GameServer/Effects/EffectStore');
    if (session.actor.effects?.clan_alliance_poison && session.actor.effectTimers?.clan_alliance_poison) return;
    const durationMs = Math.max(0, state.poisonedAt + 3600000 - Date.now());
    if (!durationMs) return;
    const effect = store.apply(session.actor, { key: 'clan_alliance_poison', id: 4082, level: 1, name: 'Poison of Death',
        type: 'debuff', category: 'clan_alliance_poison', dispellable: false, durationMs,
        dot: { damage: 100, intervalMs: 3000, count: Math.ceil(durationMs / 3000) } });
    const ticker = invoke('GameServer/Effects/EffectTicker');
    ticker.applyDot(session, session.actor, session.actor, effect);
    ticker.scheduleExpiry(session, session.actor, effect);
    ticker.refreshEffects(session, session.actor);
}
function targetNpc(selfId, actor) {
    const world = invoke('GameServer/World/World');
    // Used only for an active quest's travel destination, cached per world.
    if (npcWorld !== world.npc || Date.now() >= npcRefreshAt) {
        npcWorld = world.npc; npcRefreshAt = Date.now() + 30000; npcTargets.clear();
        const needed = new Set([...Object.values(Rules.NPC), ...Rules.HERBS.map(h => h.npcId)]);
        for (const npc of world.npc.spawns) {
            const id = Number(npc.fetchSelfId());
            if (!needed.has(id)) continue;
            if (!npcTargets.has(id)) npcTargets.set(id, []);
            npcTargets.get(id).push(npc);
        }
    }
    const candidates = npcTargets.get(Number(selfId)) || [];
    return candidates.filter(npc => !npc.isDead?.()).sort((a, b) => distance(actor, a) - distance(actor, b))[0] || candidates[0];
}
let npcWorld, npcRefreshAt = 0;
const npcTargets = new Map();
const distance = (a, b) => Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY());
function spawnChests(session, state) {
    const world = invoke('GameServer/World/World');
    for (const [locX, locY, locZ] of Rules.CHEST_LOCS) {
        const npc = world.spawnQuestNpc({ selfId: 5173 + Math.floor(Math.random() * 5), locX, locY, locZ, head: 0,
            ownerId: idOf(session), questId: 501, despawnDelay: 60000 });
        if (npc) npc.allianceChestToken = state.chests.token;
    }
}
async function transition(session, event, extra = {}) {
    const clanId = clanOf(session);
    if (!clanId) return { ok: false, code: 'clan_required' };
    return serialize(clanId, async () => {
        if (event !== 'fail' && (!online(session) || session.actor.isDead())) return { ok: false, code: 'character_not_ready' };
        if (event === 'assign' && !candidates(session).some(s => idOf(s) === extra.memberId))
            return { ok: false, code: 'member_unavailable' };
        if (event === 'ritual') {
            const saved = await Database.fetchClanAllianceQuest(clanId);
            const available = new Set(candidates(session).map(idOf));
            if (saved?.selection?.length !== 3 || !saved.selection.every(id => available.has(id)))
                return { ok: false, code: 'choose_three_available_members' };
        }
        if (event === 'deliver') {
            const state = records.get(clanId);
            const leader = sessions().find(s => idOf(s) === state?.leaderId && online(s));
            if (!leader || leader.actor.isDead() || !near(session.actor, leader.actor)) return { ok: false, code: 'return_to_your_leader' };
        }

        const rewardSp = Rules.SP_REWARD * invoke('GameServer/Quest/QuestService').questRates().questSp;
        const result = await Database.transitionClanAlliance({ clanId, characterId: idOf(session), event, rewardSp, ...extra });
        if (result.state) publish(clanId, result.state);
        if (!result.ok) return result;
        const state = result.state;
        const affected = sessions().filter(s => clanOf(s) === clanId && (idOf(s) === state.leaderId || state.members.some(m => m.id === idOf(s))));
        for (const member of affected) await syncInventory(member);
        const leader = affected.find(s => idOf(s) === state.leaderId);
        if (leader?.questStates) {
            const quest = invoke('GameServer/Quest/QuestService').quests().find(q => q.id === 501);
            const log = invoke('GameServer/Quest/QuestService').stateFor(leader, quest);
            log.state = active(state) ? 'started' : 'created';
            log.variables = { cond: { started: 1, loyalty: 2, gathering: 3, cured: 4 }[state.stage] || 0 };
            invoke('GameServer/Quest/QuestService').syncActiveQuests(leader);
        }
        if (event === 'poison') poison(session, state);
        if (event === 'cure' || event === 'fail') stopPoison(session);
        if (event === 'pledge') invoke('GameServer/Actor/Generics/Die')(session, session.actor);
        if (event === 'chests') spawnChests(session, state);
        if (event === 'finish') {
            session.actor.setSp(result.sp);
            session.dataSendToMe(invoke('GameServer/Network/Response').userInfo(session.actor));
        }
        return result;
    });
}
function candidates(session) {
    return sessions().filter(s => s !== session && online(s) && !s.actor.isDead() && !s.supplyErrandPhase
        && !s.activeTrade && clanOf(s) === clanOf(session)).sort((a, b) => idOf(a) - idOf(b));
}
function eventName(value) {
    if (/^status_[0-9]+$/.test(value)) return 'status';
    if (/^assign_[0-2]_[1-9]\d*$/.test(value)) return 'assign';
    if (/^choose_blood_[1-9]\d*$/.test(value)) return 'choose_blood';
    return value;
}
function report(session, key, text) {
    if (!botSession(session) || session.clanAllianceReport === key) return;
    session.clanAllianceReport = key;
    const state = records.get(clanOf(session));
    const leader = sessions().find(s => idOf(s) === state?.leaderId && online(s));
    if (!leader) return;
    const manager = invoke('GameServer/Bot/BotManager');
    if (!manager.botPartySay(session, text, leader)) manager.botTell(session, leader, text);
}
function memberStatus(state, member) {
    const session = sessions().find(s => idOf(s) === member.id && online(s));
    if (!session) return 'Offline; assignment saved';
    if (session.actor.isDead()) return 'Dead; awaiting resurrection or town restart';
    if (state.stage === 'loyalty') return member.loyaltyDelivered ? 'Offering delivered' : member.pledged ? 'Returning with offering' : 'Going to the altar';
    if (state.stage === 'cured') return 'Trial complete';
    if (member.delivered && (!member.blood || member.bloodDelivered)) return 'Delivered; supporting the party';
    if (session.clanAllianceRecovering) return 'Recovering HP / MP';
    if (!member.herb) return 'Hunting for the herb';
    if (member.blood && !state.bloodObtained) return 'Collecting Blood of Eva at Athrea';
    return 'Returning with ingredients';
}
async function event(session, name) {
    const rawName = name;
    name = eventName(name);
    const expected = ['assign', 'choose_blood', 'status'].includes(name) ? Rules.NPC.kalis : NPC_EVENTS[name];
    const talk = session.activeNpcTalk;
    const npc = talk && require('../World/NpcObjectIndex').find(invoke('GameServer/World/World'), talk.objectId);
    if (!expected || !npc || Number(npc.fetchSelfId()) !== expected || !near(session.actor, npc) || session.actor.isDead())
        return { ok: false, code: 'talk_to_the_quest_npc' };
    const state = await snapshot(session);
    if (name === 'deliver') {
        const leader = sessions().find(s => idOf(s) === state?.leaderId && online(s));
        if (!leader || leader.actor.isDead() || !near(session.actor, leader.actor)) return { ok: false, code: 'return_to_your_leader' };
    }
    if (name === 'status') { session.clanAlliancePage = Number(rawName.split('_')[1] || 0); return { ok: true, state }; }
    if (['assign', 'choose_blood', 'ritual'].includes(name) && (state?.leaderId !== idOf(session) || state.stage !== 'started'))
        return { ok: false, code: 'leader_selection_required' };
    if (name === 'assign') {
        const [, slot, memberId] = rawName.split('_').map(Number);
        if (!candidates(session).some(s => idOf(s) === memberId)) return { ok: false, code: 'member_unavailable' };
        return transition(session, name, { slot, memberId });
    }
    if (name === 'choose_blood') return transition(session, name, { bloodId: Number(rawName.split('_')[2]) });
    if (name === 'ritual') {
        const available = new Set(candidates(session).map(idOf));
        if (state.selection?.length !== 3 || !state.selection.every(id => available.has(id)))
            return { ok: false, code: 'choose_three_available_members' };
    }
    return transition(session, name);
}
async function onKill(session, npc) {
    if (!clanOf(session) || processedKills.has(npc) || !(npc.isDead?.() || npc.state?.fetchDead?.())) return;
    const npcId = Number(npc.fetchSelfId());
    if (!Rules.HERBS.some(h => h.npcId === npcId) && !npc.allianceChestToken) return;
    if (session.actor.isDead() || !near(session.actor, npc, 2500)) return;
    const state = records.get(clanOf(session)) || await snapshot(session);
    if (!active(state) || state.stage !== 'gathering') return;
    const leader = sessions().find(s => idOf(s) === state.leaderId && online(s));
    if (!leader || leader.actor.isDead()) return;
    if (npc.allianceChestToken && Number(npc.questSpawn?.ownerId) !== idOf(session)) return;
    processedKills.add(npc);
    return transition(session, npc.allianceChestToken ? 'chest_kill' : 'kill', {
        npcId: npc.allianceChestToken ? Number(npc.fetchId()) : npcId, chestToken: npc.allianceChestToken || '', roll: Math.random()
    });
}
async function resume(session) {
    if (!clanOf(session)) return;
    const state = await snapshot(session);
    if (active(state) && state.leaderId === idOf(session)) {
        if (session.actor.isDead()) await transition(session, 'fail');
        else {
            poison(session, state);
            for (const member of state.members) {
                if (sessions().some(s => idOf(s) === member.id && online(s))) continue;
                const life = await invoke('GameServer/Bot/Population/BotLifeState').findByCharacterId(member.id);
                if (life && Number(life.clanId) === clanOf(session))
                    await invoke('GameServer/Bot/Population/PopulationService').requestActivation(life, 'clan_quest_resume');
            }
        }
    }
}
function onDeath(session) {
    const state = records.get(clanOf(session));
    if (active(state) && state.members.some(m => m.id === idOf(session)))
        report(session, 'dead', 'I am down. I will continue my assignment after resurrection or a town restart.');
    if (state?.stage === 'gathering' && state.leaderId === idOf(session))
        transition(session, 'fail').catch(error => utils.infoWarn('ClanQuest', 'death cleanup failed: %s', error.message));
}
module.exports = { Rules, records, active, snapshot, resume, event, transition, onKill, onDeath, targetNpc, near, loc,
    sessions, idOf, clanOf, online, botSession, syncInventory, stopPoison, candidates, eventName, report, memberStatus };
