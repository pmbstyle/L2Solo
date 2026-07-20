const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const QuestState = invoke('GameServer/Quest/QuestState');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const ExperienceReward = invoke('GameServer/Actor/Generics/ExperienceReward');

const quests = [
    require('./quests/Q001_LettersOfLove'),
    require('./quests/Q002_WhatWomenWant'),
    require('./quests/Q003_WillTheSealBeBroken')
];
const byId = new Map(quests.map((quest) => [quest.id, quest]));

function states(session) {
    if (!session.questStates) session.questStates = new Map();
    return session.questStates;
}

// NPC links and kill callbacks can reach the same character back-to-back.
// Keep the read-modify-write quest transition atomic at the session level so
// two kills cannot both observe the same pre-transition inventory/state.
function mutate(session, work) {
    const previous = session.questMutationTail || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    session.questMutationTail = next.catch(() => {});
    return next;
}

async function ensureLoaded(session) {
    if (session.questStatesLoaded) return;
    const rows = await Database.fetchCharacterQuests(session.actor.fetchId());
    rows.forEach((row) => {
        const quest = byId.get(Number(row.questId));
        if (quest) states(session).set(quest.id, new QuestState(session, quest, row));
    });
    session.questStatesLoaded = true;
}

function stateFor(session, quest) {
    let state = states(session).get(quest.id);
    if (!state) {
        state = new QuestState(session, quest);
        states(session).set(quest.id, state);
    }
    return state;
}

function questForNpc(npc, session) {
    const npcId = Number(npc.fetchSelfId());
    return quests.find((quest) => {
        if (!quest.npcs.includes(npcId)) return false;
        const state = stateFor(session, quest);
        if (!state.isStarted() && !state.isCompleted() && !(quest.startNpcs || []).includes(npcId)) return false;
        return !quest.canTalk || quest.canTalk(state, npc);
    });
}

function handlesNpc(npc) {
    const npcId = Number(npc.fetchSelfId?.() ?? npc);
    return quests.some((quest) => quest.npcs.includes(npcId));
}

function render(session, npc, html) {
    session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
    session.dataSendToMe(ServerResponse.actionFailed());
}

async function onTalk(session, npc) {
    return mutate(session, async () => {
        await ensureLoaded(session);
        const quest = questForNpc(npc, session);
        if (!quest) return false;
        const html = await quest.onTalk(stateFor(session, quest), npc);
        if (!html) return false;
        render(session, npc, html);
        return true;
    });
}

async function onEvent(session, event) {
    return mutate(session, async () => {
        await ensureLoaded(session);
        const quest = byId.get(Number(event.questId));
        const npc = session.activeNpcTalk;
        const eventName = String(event.name);
        if (!quest || !npc || !quest.npcs.includes(Number(npc.selfId))) return false;
        if (quest.eventNpc?.(eventName) !== Number(npc.selfId)) return false;
        const state = stateFor(session, quest);
        const html = await quest.onEvent(state, eventName);
        if (!html) return false;
        render(session, { fetchId: () => npc.objectId }, html);
        return true;
    });
}

async function giveItem(session, selfId, amount) {
    const backpack = session.actor.backpack;
    const existing = backpack.fetchItemFromSelfId(selfId);
    if (existing?.fetchStackable?.()) {
        const total = existing.fetchAmount() + amount;
        await Database.updateItemAmount(session.actor.fetchId(), existing.fetchId(), total);
        existing.setAmount(total);
    } else {
        const data = await new Promise((resolve) => DataCache.fetchItemFromSelfId(selfId, resolve));
        const result = await Database.setItem(session.actor.fetchId(), {
            selfId, name: data.template.name, amount, equipped: false, slot: data.etc.slot
        });
        backpack.insertItem(Number(result.insertId), selfId, { amount });
    }
    session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
}

async function takeItem(session, selfId, amount = 1) {
    const item = session.actor.backpack.fetchItemFromSelfId(selfId);
    if (!item || item.fetchAmount() < amount) return false;
    const remaining = item.fetchAmount() - amount;
    if (remaining > 0) {
        await Database.updateItemAmount(session.actor.fetchId(), item.fetchId(), remaining);
        item.setAmount(remaining);
    } else {
        await Database.deleteItem(session.actor.fetchId(), item.fetchId());
        session.actor.backpack.items = session.actor.backpack.items.filter((entry) => entry !== item);
    }
    session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
    return true;
}

// Lisvus keeps quest hand-in items at their authored count.  Only explicit
// rewardItems calls are multiplied, with Adena using its dedicated rate.
function rewardItem(session, selfId, amount) {
    const rates = questRates();
    const rate = Number(selfId) === 57 ? rates.questAdena : rates.questReward;
    return giveItem(session, selfId, Math.max(0, Math.floor(Number(amount) * rate)));
}

function questDropAmount(amount, needed, current) {
    const scaled = Math.floor(Math.max(0, Number(amount) || 0) * questRates().questDrop);
    if (scaled <= 0 || current >= needed) return 0;
    return Math.min(scaled, needed - current);
}

function rewardExpSp(session, exp, sp) {
    const rates = questRates();
    // ExperienceReward owns UI, persistence, and level-up. Counter its normal
    // mob-rate input so C4's dedicated RateQuestRewardXp/Sp remains the sole
    // server multiplier for an authored quest reward.
    const baseExp = Number(rates.exp) > 0 ? Number(exp) * rates.questExp / rates.exp : 0;
    const baseSp = Number(rates.sp) > 0 ? Number(sp) * rates.questSp / rates.sp : 0;
    ExperienceReward(session, session.actor, baseExp, baseSp);
}

async function onKill(session, npc) {
    return mutate(session, async () => {
        await ensureLoaded(session);
        const npcId = Number(npc.fetchSelfId());
        for (const quest of quests) {
            if (!quest.killNpcs?.includes(npcId)) continue;
            const state = states(session).get(quest.id);
            if (state?.isStarted()) await quest.onKill(state, npc);
        }
    });
}

function active(session) {
    return [...states(session).values()].filter((state) => state.isStarted()).map((state) => ({ id: state.quest.id, condition: state.getInt('cond') }));
}

function questRates() { return ProgressionRates.profile(); }

module.exports = { ensureLoaded, onTalk, onEvent, onKill, handlesNpc, mutate, stateFor, active, giveItem, takeItem, rewardItem, rewardExpSp, questDropAmount, questRates, quests: () => quests };
