const catalog = require('../../../data/Items/soul_crystals.json');

const messages = { success: 974, failed: 975, broken: 976, resonance: 977, refused: 978 };
const crystalIds = Object.keys(catalog.crystals).map(Number);
const processedDeaths = new WeakSet();

function crystal(item) { return catalog.crystals[item?.fetchSelfId?.()] || null; }
function targetRule(npc) { return catalog.npcs[npc?.fetchSelfId?.()] || null; }
function active(session) { return session?.questStates?.get(350)?.isStarted() === true; }
function inventory(actor) {
    return (actor?.backpack?.fetchItems?.() || []).filter(item => crystal(item) && item.fetchAmount() > 0);
}
function singleCrystal(actor) {
    const items = inventory(actor);
    return items.length === 1 && items[0].fetchAmount() === 1 ? items[0] : null;
}
function canUse(session, item, npc) {
    return active(session) && !!crystal(item) && !!targetRule(npc)
        && session.actor.backpack.fetchItemRaw(item.fetchId()) === item;
}
function tell(session, outcome) {
    session.dataSendToMe?.(invoke('GameServer/Network/Response').systemMessage(messages[outcome]));
}
function outcomeFor(rule, stage, npcId, roll) {
    const boss = rule.maxStage > 10;
    const minimum = boss ? (rule.maxStage > 12 ? 12 : 10) : 0;
    if (stage < minimum || stage >= rule.maxStage) return 'refused';
    const guaranteed = boss && rule.absorbType === 'FULL_PARTY' && ![10319, 10338].includes(Number(npcId));
    if (guaranteed || roll < (boss ? 0.70 : 0.32)) return 'success';
    return !boss && roll >= 0.90 ? 'broken' : 'failed';
}
function killerSession(session, actor) {
    if (actor?.fetchIsSummon?.() === true) {
        const ownerId = Number(actor.fetchOwnerId?.());
        return (invoke('GameServer/World/World').user?.sessions || [])
            .find(candidate => Number(candidate.actor?.fetchId?.()) === ownerId) || null;
    }
    return session?.actor === actor ? session : null;
}
function participants(session, npc, rule, random) {
    if (rule.absorbType === 'LAST_HIT') return [session];
    const leader = session.partyCompanion && session.followPlayerSession ? session.followPlayerSession : session;
    const members = [...new Set([session, ...invoke('GameServer/Bot/AI/PartyAwareness').partySessions(leader)])]
        .filter(member => member.actor && !member.actor.isDead?.() && member.actor.fetchIsOnline?.() !== false)
        .filter(member => Math.hypot(member.actor.fetchLocX() - npc.fetchLocX(), member.actor.fetchLocY() - npc.fetchLocY()) <= 2500);
    // Choose before checking quest/crystal eligibility: a failed recipient is not rerolled.
    return rule.absorbType === 'PARTY_ONE_RANDOM' && members.length
        ? [members[Math.floor(random() * members.length)]] : members;
}
async function award(session, actor, item, rule, npcId, roll) {
    const QuestService = invoke('GameServer/Quest/QuestService');
    return QuestService.mutate(session, async () => {
        const valid = () => session.actor === actor && active(session)
            && actor.fetchIsOnline?.() !== false && !actor.isDead?.() && singleCrystal(actor) === item;
        if (!valid()) return;
        const metadata = crystal(item);
        const outcome = outcomeFor(rule, metadata.stage, npcId, roll);
        if (outcome === 'failed' || outcome === 'refused') { tell(session, outcome); return outcome; }
        const selfId = outcome === 'success' ? metadata.nextId : metadata.brokenId;
        let template;
        invoke('GameServer/DataCache').fetchItemFromSelfId(selfId, value => { template = value; });
        if (!template) throw new Error(`Missing Soul Crystal item ${selfId}`);
        const id = item.fetchId();
        const changed = session.persistenceMode === 'ephemeral' ? valid()
            : await invoke('Database').replaceSoulCrystal(actor.fetchId(), id, item.fetchSelfId(),
                selfId, template.template.name, crystalIds, valid);
        if (!changed) return;
        // The object id stays stable, so the crystal remains usable from its shortcut.
        actor.backpack.items = actor.backpack.fetchItems().filter(entry => entry !== item);
        actor.backpack.insertItem(id, selfId, { amount: 1 });
        if (session.actor === actor) {
            session.dataSendToMe?.(invoke('GameServer/Network/Response').itemsList(actor.backpack.fetchItems()));
            tell(session, outcome);
        }
        return outcome;
    });
}
async function onDeath(session, attacker, npc, random = Math.random) {
    if (processedDeaths.has(npc)) return Promise.resolve([]);
    processedDeaths.add(npc);
    const rule = targetRule(npc);
    const killer = killerSession(session, attacker);
    const mark = killer && npc.fetchSoulCrystalAbsorber?.(killer.actor);
    npc.resetSoulCrystalAbsorbers?.();
    if (!rule || !killer || killer.actor.isDead?.() || killer.actor.fetchIsOnline?.() === false) return Promise.resolve([]);
    if (rule.maxStage <= 10 && (!mark || mark.actor !== killer.actor || !(mark.absorbedHp > 0)
        || mark.absorbedHp > npc.fetchMaxHp() / 2)) return Promise.resolve([]);
    const roll = random();
    const jobs = [];
    for (const recipient of participants(killer, npc, rule, random)) {
        if (!active(recipient)) continue;
        const item = singleCrystal(recipient.actor);
        if (!item) {
            if (inventory(recipient.actor).length) tell(recipient, 'resonance');
            continue;
        }
        // Ordinary mobs are bound to the item actually used, not a crystal swapped in later.
        if (rule.maxStage <= 10 && mark.crystalItemId !== item.fetchId()) continue;
        jobs.push(award(recipient, recipient.actor, item, rule, npc.fetchSelfId(), roll));
    }
    return Promise.all(jobs);
}

module.exports = { canUse, onDeath, outcomeFor, crystal, targetRule, crystalIds, catalog };
