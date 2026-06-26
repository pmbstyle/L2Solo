const CreatureModel = invoke('GameServer/Model/Creature');

class ActorModel extends CreatureModel {

    // Set

    setExp(data) {
        this.model.exp = data;
    }

    setSp(data) {
        this.model.sp = data;
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
    }

    setPrivateStoreType(data) {
        this.model.privateStoreType = data;
    }

    fetchPrivateStoreType() {
        return this.model.privateStoreType || 0;
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

    // Get

    fetchPvpFlag() {
        return this.model.pvpFlag || 0;
    }

    fetchUsername() {
        return this.model.username;
    }

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

    // Abstract

    isSpellcaster() {
        return [10, 25, 38, 49].includes(this.fetchClassId()) ? 1 : 0;
    }
}

module.exports = ActorModel;
