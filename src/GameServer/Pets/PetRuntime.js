const Rules = require('./PetRules');
const { collision } = require('../../../data/Pets/c4-collision.json');
const Npc = invoke('GameServer/Npc/Npc');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const EffectStats = invoke('GameServer/Effects/EffectStats');

class Pet extends Npc {
    markSkillReuse(skill, now = Date.now()) {
        this.skillReuseUntil.set(skill.fetchSelfId(), now + Math.max(0, Number(skill.fetchReuseTime()) || 0));
    }
    fetchCollectiveCritical() { return Number(this.model.critical) || 40; }
    fetchCollectiveRunSpd() {
        const speed = super.fetchCollectiveRunSpd();
        return this.petData && this.fetchCurrentFeed() < this.fetchMaxFeed() * Rules.POLICY.hungerSpeed ? speed * 0.5 : speed;
    }
    fetchChargedSoulShot() { return !!this.soulshotLoaded; }
    setChargedSoulShot(value) { this.soulshotLoaded = !!value; }
    fetchChargedSpiritShot() { return this.spiritshotLoaded ? (this.blessedSpiritshotLoaded ? 'blessed' : true) : false; }
    setChargedSpiritShot(value) { this.spiritshotLoaded = !!value; this.blessedSpiritshotLoaded = value === 'blessed'; }
    fetchExp() { return this.petData?.exp || 0; }
    fetchLoad() { return invoke('GameServer/Pets/PetInventory').items(this).reduce((total, item) => total + item.fetchMass() * item.fetchAmount(), 0); }
    fetchMaxLoad() { return Rules.POLICY.inventoryWeight; }
    fetchSp() { return this.petData?.sp || 0; }
    fetchExpForThisLevel() { return Rules.stats(this.fetchSelfId(), this.fetchLevel()).exp; }
    fetchExpForNextLevel() { return Rules.stats(this.fetchSelfId(), this.fetchLevel() + 1).exp; }
    fetchCurrentFeed() { return this.petData?.currentFeed || 0; }
    fetchMaxFeed() { return Rules.stats(this.fetchSelfId(), this.fetchLevel()).maxFeed; }
    setCurrentFeed(value) {
        this.petData.currentFeed = Rules.clamp(value, 0, this.fetchMaxFeed());
        if (this.petData.currentFeed > 0) this.petData.starvingSince = 0;
    }
    fetchCollectiveAccur() { return Rules.stats(this.fetchSelfId(), this.fetchLevel()).accur + EffectStats.add(this, 'pAccuracyCombatAdd'); }
    fetchCollectiveEvasion() { return Rules.stats(this.fetchSelfId(), this.fetchLevel()).evasion + EffectStats.add(this, 'pEvasionRateAdd'); }
}

function snapshot(pet) {
    return { ...pet.petData, level: pet.fetchLevel(), hp: pet.fetchHp(), mp: pet.fetchMp(), dead: pet.state.fetchDead() };
}
function persist(pet, owner = pet.ownerActor || pet.ownerSession?.actor) {
    if (!owner) return pet.persistTail || Promise.resolve();
    const item = owner.backpack.fetchItemRaw(pet.fetchPetControlItemObjectId());
    if (!item) return Promise.resolve();
    const state = structuredClone(snapshot(pet));
    item.setPetData(state);
    if (pet.ownerSession.persistenceMode === 'ephemeral') return Promise.resolve(state);
    const pending = Database.savePetState(owner.fetchId(), item.fetchId(), state);
    pet.persistTail = pending.catch(error => {
        utils.infoWarn('Pet', 'state save failed for %d: %s', item.fetchId(), error.message);
    });
    return pending;
}
function publish(pet) {
    const session = pet.ownerSession;
    session?.dataSendToMe?.(Response.petInfo(pet, session.actor));
    session?.dataSendToMe?.(Response.petStatusUpdate(pet));
}
function applyStats(pet) {
    const row = Rules.stats(pet.fetchSelfId(), pet.petData.level);
    const equipment = invoke('GameServer/Pets/PetInventory').equipmentStats(pet);
    Object.assign(pet.model, row, collision[pet.fetchSelfId()], { level: pet.petData.level, walk: Math.round(row.run * 0.5), kind: 'Pet',
        pAtk: row.pAtk + equipment.pAtk, mAtk: row.mAtk + equipment.mAtk,
        pDef: row.pDef + equipment.pDef, mDef: row.mDef + equipment.mDef });
    if (equipment.atkSpd) pet.model.atkSpd = equipment.atkSpd;
    if (equipment.critical) pet.model.critical = equipment.critical;
    pet.automation.setRevHp(row.revHp);
    pet.automation.setRevMp(row.revMp);
    pet.petData.maxFeed = row.maxFeed;
    pet.petData.feedNormal = row.feedNormal;
    pet.petData.feedBattle = row.feedBattle;
    pet.setCurrentFeed(pet.fetchCurrentFeed());
}
function create(session, controlItem, template) {
    if (controlItem.petInUse) return null;
    const type = Rules.TYPES[controlItem.fetchSelfId()];
    if (!type) return null;
    const state = Rules.normalize(controlItem.fetchSelfId(), controlItem.fetchPetData() || {}, session.actor.fetchLevel());
    if (state.expired || (state.dead && state.deadUntil <= Date.now())) {
        state.expired = true;
        controlItem.setPetData(state);
        if (session.persistenceMode !== 'ephemeral') eraseExpired(session, controlItem.fetchId(), Database.savePetState(session.actor.fetchId(), controlItem.fetchId(), state));
        return null;
    }
    const row = Rules.stats(type.npcId, state.level);
    const pet = new Pet(invoke('GameServer/World/World').npc.nextId++, {
        ...template, ...row, selfId: type.npcId, name: state.name || type.name,
        kind: 'Pet', title: session.actor.fetchName(), isPet: true, isSummon: true,
        ownerId: session.actor.fetchId(), ownerName: session.actor.fetchName(),
        petControlItemObjectId: controlItem.fetchId(), petFoodCategories: [type.category],
        locX: session.actor.fetchLocX(), locY: session.actor.fetchLocY(), locZ: session.actor.fetchLocZ(),
        head: session.actor.fetchHead?.() || 0, walk: Math.round(row.run / 2),
        radius: template.radius || 10, size: template.size || 15, atkRadius: template.atkRadius || 40,
        stateRun: true, str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25
    });
    controlItem.petInUse = true;
    pet.petData = state;
    pet.ownerSession = session;
    pet.ownerActor = session.actor;
    applyStats(pet);
    pet.setHp(state.hp);
    pet.setMp(state.mp);
    pet.state.setDead(state.dead);
    controlItem.setPetData(state);
    return pet;
}
function start(pet) {
    persist(pet).catch(() => {});
    publish(pet);
    if (pet.petData.dead) scheduleCorpse(pet);
    else invoke('GameServer/Pets/BabyPetAI').start(pet);
}
function award(pet, exp, sp = 0) {
    if (!pet || pet.evolving || pet.state.fetchDead() || pet.petData.expired || pet.ownerSession?.actor?.pet !== pet || pet.ownerSession.actor.mounted) return false;
    const oldLevel = pet.fetchLevel();
    const rates = invoke('GameServer/ProgressionRates').profile();
    const next = Rules.clamp(pet.fetchExp() + Math.max(0, Math.round(exp * rates.exp)), 0, Rules.stats(pet.fetchSelfId(), 81).exp - 1);
    pet.petData.exp = next;
    pet.petData.sp = Rules.clamp(pet.fetchSp() + Math.max(0, Math.round(sp * rates.sp)), 0, 2147483647);
    pet.petData.level = Rules.levelFor(pet.fetchSelfId(), next);
    if (oldLevel !== pet.petData.level) {
        applyStats(pet);
        pet.setHp(Math.min(pet.fetchHp(), pet.fetchMaxHp()));
        pet.setMp(Math.min(pet.fetchMp(), pet.fetchMaxMp()));
    }
    publish(pet);
    persist(pet).catch(() => {});
    return true;
}
function remove(pet, expired = false) {
    const session = pet.ownerSession;
    const owner = session?.actor;
    if (!owner) return;
    if (expired) {
        pet.petData.expired = true;
        if (!pet.petData.dead) session.dataSendToMe?.(Response.consoleText(593, []));
    }
    clearTimeout(pet.timer.petCorpse);
    invoke('GameServer/Npc/SummonControl').unsummon(session, owner, pet);
    if (expired) pet.expireTail = eraseExpired(session, pet.fetchPetControlItemObjectId(), pet.teardownTail || pet.persistTail);
}
function eraseExpired(session, id, pending = Promise.resolve()) {
    if (session.persistenceMode === 'ephemeral') return;
    const actor = session.actor;
    return Promise.resolve(pending).then(() => Database.deleteItem(actor.fetchId(), id)).then(() => {
        actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== id);
        if (session.actor === actor) session.dataSendToMe?.(Response.itemsList(actor.backpack.fetchItems()));
    }).catch(error => utils.infoWarn('Pet', 'expired control item %d: %s', id, error.message));
}
function scheduleCorpse(pet) {
    clearTimeout(pet.timer.petCorpse);
    pet.timer.petCorpse = setTimeout(() => remove(pet, true), Math.max(1, pet.petData.deadUntil - Date.now()));
    pet.timer.petCorpse.unref?.();
}
function die(pet) {
    if (!pet.petData || pet.petData.dead) return;
    pet.petData.dead = true;
    pet.petData.deadUntil = Date.now() + Rules.POLICY.corpseMs;
    const loss = Math.min(pet.fetchExp(), Rules.deathLoss(pet.fetchSelfId(), pet.fetchLevel()));
    pet.petData.lostExp = loss;
    pet.petData.exp -= loss;
    pet.petData.level = Rules.levelFor(pet.fetchSelfId(), pet.fetchExp());
    applyStats(pet);
    pet.setHp(0);
    pet.state.setDead(true);
    persist(pet).catch(() => {});
    publish(pet);
    scheduleCorpse(pet);
}
function revive(pet, recovery = 0) {
    if (!pet?.petData?.dead || pet.petData.expired) return false;
    if (pet.petData.deadUntil <= Date.now()) { remove(pet, true); return false; }
    clearTimeout(pet.timer.petCorpse);
    pet.petData.exp += Math.round(pet.petData.lostExp * Rules.clamp(recovery, 0, 100) / 100);
    pet.petData.level = Rules.levelFor(pet.fetchSelfId(), pet.fetchExp());
    pet.petData.dead = false;
    pet.petData.deadUntil = 0;
    pet.petData.lostExp = 0;
    pet.state.setDead(false);
    applyStats(pet);
    pet.setHp(pet.fetchMaxHp());
    pet.setMp(pet.fetchMaxMp());
    invoke('GameServer/Pets/BabyPetAI').start(pet);
    persist(pet).catch(() => {});
    return true;
}
async function feedTick(pet) {
    if (pet.feedPending || pet.evolving || pet.ownerTeleport || pet.petData.dead || pet.petData.expired) return;
    const owner = pet.ownerSession?.actor;
    if (!owner || owner.pet !== pet) return;
    pet.feedPending = true;
    try {
        const row = Rules.stats(pet.fetchSelfId(), pet.fetchLevel());
        const active = pet.state.fetchHits() || pet.controlMode === 'attack' || owner.state?.fetchHits?.();
        pet.setCurrentFeed(pet.fetchCurrentFeed() - (active ? row.feedBattle : row.feedNormal));
        if (pet.fetchCurrentFeed() < row.maxFeed * Rules.POLICY.autoFeed) {
            const inventory = invoke('GameServer/Pets/PetInventory');
            await (owner.fetchMounted?.() || owner.mounted ? inventory.autoFeedMounted(pet) : inventory.autoFeed(pet));
        }
        if (owner.pet !== pet) return;
        const hungry = pet.fetchCurrentFeed() < row.maxFeed * Rules.POLICY.hungerSpeed;
        pet.setStateRun(!hungry);
        if (!pet.fetchCurrentFeed()) {
            if (owner.fetchMounted?.() || owner.mounted) { invoke('GameServer/Pets/PetMount').dismount(pet.ownerSession,owner,true); return; }
            if (!pet.petData.starvingSince) pet.ownerSession.dataSendToMe?.(Response.consoleText(595, []));
            pet.petData.starvingSince ||= Date.now();
            if (Date.now() - pet.petData.starvingSince >= Rules.POLICY.starvationGraceMs) { remove(pet, true); return; }
        }
        publish(pet);
        await persist(pet);
    } finally { pet.feedPending = false; }
}
function recordDamage(npc, source, damage) {
    if (source?.fetchIsPet?.() !== true || !source.petData || npc.fetchIsSummon?.()) return;
    if (Rules.typeForNpc(source.fetchSelfId())?.ownerShare) return;
    const effective = Math.max(0, Math.min(Number(damage) || 0, npc.fetchHp()));
    if (!effective) return;
    npc.petDamage ||= new Map();
    const entry = npc.petDamage.get(source.fetchId()) || { pet: source, damage: 0 };
    entry.damage += effective;
    npc.petDamage.set(source.fetchId(), entry);
}
function rewardDamage(npc, exp, sp) {
    let used = 0;
    for (const { pet, damage } of (npc.petDamage || new Map()).values()) {
        const share = Math.min(1 - used, damage / npc.fetchMaxHp());
        used += share;
        const distance = Math.hypot(pet.fetchLocX() - npc.fetchLocX(), pet.fetchLocY() - npc.fetchLocY());
        if (distance > Rules.POLICY.rewardRadius || Rules.typeForNpc(pet.fetchSelfId())?.ownerShare) continue;
        const penalty = Rules.levelPenalty(pet.fetchLevel(), npc.fetchLevel());
        award(pet, exp * share * penalty, sp * share * penalty);
    }
    return Math.max(0, 1 - used);
}
module.exports = { Pet, create, start, persist, snapshot, publish, applyStats, award, die, revive, remove, feedTick, recordDamage, rewardDamage };
