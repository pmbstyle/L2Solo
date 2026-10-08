const CreatureModel = invoke('GameServer/Model/Creature');
const Formulas = invoke('GameServer/Formulas');
const locationBatchDepth = new WeakMap();

function publishLocation(actor) {
    if (!locationBatchDepth.has(actor) && actor.session?.actor === actor) {
        invoke('GameServer/World/World').updateUserLocation?.(actor.session, actor);
        if (actor.session.tradeMeetingPresence) require('../AfkTrade/TradeMeetingService').presenceChanged(actor.session);
    }
}

class ActorModel extends CreatureModel {
    fetchCollectivePAtk() { return invoke('GameServer/Pets/PetMount').stats(this)?.pAtk ?? super.fetchCollectivePAtk(); }
    fetchCollectiveRunSpd() { return invoke('GameServer/Pets/PetMount').stats(this)?.run ?? super.fetchCollectiveRunSpd(); }

    fetchCollectiveWalkSpd() { return invoke('GameServer/Pets/PetMount').stats(this)?.walk ?? super.fetchCollectiveWalkSpd(); }

    // Set

    setLocX(data) {
        super.setLocX(data);
        publishLocation(this);
    }

    setDestId(id) {
        super.setDestId(id);
        invoke('GameServer/World/World').updateUserPresence?.(this.session, this);
    }

    clearDestId() {
        super.clearDestId();
        invoke('GameServer/World/World').updateUserPresence?.(this.session, this);
    }

    setLocY(data) {
        super.setLocY(data);
        publishLocation(this);
    }

    setLocZ(data) {
        super.setLocZ(data);
        publishLocation(this);
    }

    setLocXYZ(coords) {
        const previousDepth = locationBatchDepth.get(this) || 0;
        locationBatchDepth.set(this, previousDepth + 1);
        try {
            super.setLocXYZ(coords);
        } finally {
            if (previousDepth === 0) locationBatchDepth.delete(this);
            else locationBatchDepth.set(this, previousDepth);
        }
        publishLocation(this);
    }

    canReplenishVitals() {
        return this.model.isOnline === true
            && this.session?.actor === this
            && this.state.fetchDead() !== true
            && this.fetchHp() > 0;
    }

    refreshVitalsRegeneration() {
        const automation = this.automation;
        // EnterWorld initializes regeneration after restoring the character.
        if (!automation?.replenishVitals || automation.fetchRevHp?.() === undefined
            || automation.fetchRevMp?.() === undefined) return;
        if (!this.canReplenishVitals()) {
            automation.stopReplenish();
            return;
        }
        if (this.fetchHp() < this.fetchMaxHp() || this.fetchMp() < this.fetchMaxMp()
            || this.fetchCp() < this.fetchMaxCp()) {
            automation.replenishVitals(this);
        } else {
            automation.stopReplenish();
        }
    }

    setHp(data) {
        const wasLow = this.fetchHp() <= this.fetchMaxHp() * 0.6;
        super.setHp(data);
        if (this.session?.tradeMeetingPresence) require('../AfkTrade/TradeMeetingService').presenceChanged(this.session);
        const isLow = this.fetchHp() <= this.fetchMaxHp() * 0.6;
        if (wasLow !== isLow && invoke('GameServer/Items/C4WeaponSA').hasRisk(this)) {
            invoke('GameServer/Actor/Generics/CalculateStats').refreshConditionalCombatStats(this);
        }
        this.refreshVitalsRegeneration();
    }

    setMaxHp(data) {
        super.setMaxHp(data);
        this.refreshVitalsRegeneration();
    }

    setMp(data) {
        super.setMp(data);
        this.refreshVitalsRegeneration();
    }

    setMaxMp(data) {
        super.setMaxMp(data);
        this.refreshVitalsRegeneration();
    }

    setExp(data) {
        this.model.exp = data;
    }

    setSp(data) {
        this.model.sp = data;
    }

    setCp(data) {
        this.model.cp = data;
        this.refreshVitalsRegeneration();
    }

    setMaxCp(data) {
        this.model.maxCp = data;
        this.refreshVitalsRegeneration();
    }

    setCharges(data) {
        this.model.charges = data;
    }

    setExpertisePenalty(data) {
        this.model.expertisePenalty = Math.max(0, Number(data) || 0);
    }

    setPvp(data) {
        this.model.pvp = data;
    }

    setPk(data) {
        this.model.pk = data;
    }

    setKarma(data) {
        this.model.karma = data;
    }

    setExpSp(exp, sp) {
        this.setExp(exp); this.setSp(sp);
    }

    setCollectiveAccur(data) {
        this.model.collectiveAccur = data;
    }

    setCollectiveEvasion(data) {
        this.model.collectiveEvasion = data;
    }

    setCollectiveCritical(data) {
        this.model.collectiveCritical = data;
    }

    setLoad(data) {
        this.model.load = data;
    }

    setMaxLoad(data) {
        this.model.maxLoad = data;
    }

    setIsOnline(data) {
        this.model.isOnline = data;
        if (this.session?.actor === this) invoke('GameServer/World/World').updateUserLocation?.(this.session, this);
    }

    setPrivateStoreType(data) {
        this.model.privateStoreType = data;
    }

    setMounted(data) {
        this.model.mounted = data === true;
    }

    setMountNpcId(data) {
        this.model.mountNpcId = Number(data) || 0;
    }

    fetchPrivateStoreType() {
        return this.model.privateStoreType || 0;
    }

    fetchMounted() {
        return this.model.mounted === true;
    }

    fetchMountNpcId() {
        return this.model.mountNpcId || 0;
    }

    setPrivateStore(data) {
        this.model.privateStore = data;
    }

    fetchPrivateStore() {
        return this.model.privateStore || null;
    }

    setPvpFlag(data) {
        this.model.pvpFlag = data;
    }

    setClassId(data) {
        this.model.classId = data;
    }

    setClanId(data) {
        const previous = this.model.clanId;
        this.model.clanId = data;
        const events = require('../Clan/ClanReviewEvents');
        events.changed(previous, 'membership'); events.changed(data, 'membership');
    }

    setClanPrivileges(data) {
        this.model.clanPrivileges = data;
    }

    setClanJoinExpiryTime(data) {
        this.model.clanJoinExpiryTime = data;
    }

    setClanCreateExpiryTime(data) {
        this.model.clanCreateExpiryTime = data;
    }

    // Get

    fetchPvpFlag() {
        return this.model.pvpFlag || 0;
    }

    fetchUsername() {
        return this.model.username;
    }

    fetchNewbie() { return this.model.newbie ?? -1; }

    fetchNewbieShotsReceived() { return this.model.newbieShotsReceived ?? 0; }

    setNewbieShotsReceived(value) { this.model.newbieShotsReceived = value; }

    fetchClassId() {
        return this.model.classId;
    }

    fetchRace() {
        return this.model.race;
    }

    fetchExp() {
        return this.model.exp;
    }

    fetchSp() {
        return this.model.sp;
    }

    fetchCritical() {
        return this.model.crit;
    }

    fetchCollectiveCritical() {
        return this.model.collectiveCritical ?? this.fetchCritical();
    }

    fetchMaxLoad() {
        return this.model.maxLoad;
    }

    fetchCp() {
        return this.model.cp || 0;
    }

    fetchMaxCp() {
        return this.model.maxCp || 0;
    }

    fetchCharges() {
        return this.model.charges || 0;
    }

    fetchExpertisePenalty() {
        return this.model.expertisePenalty || 0;
    }

    fetchSwim() {
        return this.model.swim;
    }
    
    fetchPvp() {
        return this.model.pvp;
    }

    fetchPk() {
        return this.model.pk;
    }

    fetchSex() {
        return this.model.sex;
    }

    fetchFace() {
        return this.model.face;
    }

    fetchHair() {
        return this.model.hair;
    }

    fetchHairColor() {
        return this.model.hairColor;
    }

    fetchKarma() {
        return this.model.karma;
    }

    fetchEvalScore() {
        return this.model.evalScore;
    }

    fetchRecRemain() {
        return this.model.recRemain;
    }

    fetchIsCrafter() {
        return this.model.crafter;
    }

    fetchIsGM() {
        return this.model.isGM;
    }

    fetchIsOnline() {
        return this.model.isOnline;
    }

    fetchIsActive() {
        return this.model.isActive;
    }

    fetchClanId() {
        return this.model.clanId || 0;
    }

    fetchClanPrivileges() {
        return this.model.clanPrivileges || 0;
    }

    fetchClanJoinExpiryTime() {
        return this.model.clanJoinExpiryTime || 0;
    }

    fetchClanCreateExpiryTime() {
        return this.model.clanCreateExpiryTime || 0;
    }

    fetchClan() {
        return invoke('GameServer/Clan/ClanService').findById(this.fetchClanId());
    }

    // Abstract

    isSpellcaster() {
        return [10, 25, 38, 49].includes(Formulas.getParentClassId(this.fetchClassId())) ? 1 : 0;
    }

    fillupCp() {
        this.setCp(this.fetchMaxCp());
    }

    fillupVitals() {
        super.fillupVitals();
        this.fillupCp();
    }
}

module.exports = ActorModel;
