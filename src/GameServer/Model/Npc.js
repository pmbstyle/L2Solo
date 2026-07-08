const CreatureModel = invoke('GameServer/Model/Creature');
const Formulas      = invoke('GameServer/Formulas');

class NpcModel extends CreatureModel {

    // Set

    setStateRun(data) {
        this.model.stateRun = data;
    }

    setStateAttack(data) {
        this.model.stateAttack = data;
    }

    setStateDead(data) {
        this.model.stateDead = data;
    }

    setStateInvisible(data) {
        this.model.stateInvisible = data;
    }

    // Get

    fetchSelfId() {
        return this.model.selfId;
    }

    fetchKind() {
        return this.model.kind;
    }

    fetchHostile() {
        return this.model.hostile;
    }

    fetchAtkRadius() {
        return this.model.atkRadius;
    }

    fetchRevHp() {
        return this.model.revHp;
    }

    fetchRevMp() {
        return this.model.revMp;
    }

    fetchCorpseTime() {
        return this.model.corpseTime;
    }

    fetchWeapon() {
        return this.model.weapon;
    }

    fetchShield() {
        return this.model.shield;
    }

    fetchArmor() {
        return this.model.armor;
    }

    fetchClanName() {
        return this.model.clanName ?? this.model.clan?.clanName ?? '';
    }

    fetchClanHelpRadius() {
        return this.model.helpRadius ?? this.model.clan?.helpRadius ?? 0;
    }

    fetchOwnerId() {
        return this.model.ownerId ?? 0;
    }

    fetchOwnerName() {
        return this.model.ownerName ?? '';
    }

    fetchSummonSkillId() {
        return this.model.summonSkillId ?? 0;
    }

    fetchIsSummon() {
        return this.model.isSummon === true || this.model.kind === 'Summon';
    }

    fetchRewardExp() {
        return this.model.exp;
    }

    fetchRewardSp() {
        return this.model.sp;
    }

    fetchStateRun() {
        return this.model.stateRun;
    }

    fetchStateAttack() {
        return this.model.stateAttack;
    }

    fetchStateDead() {
        return this.model.stateDead;
    }

    fetchStateInvisible() {
        return this.model.stateInvisible;
    }

    // Abstract

    fetchDispSelfId() {
        return this.fetchSelfId() + 1000000;
    }

    fetchAttackable() {
        return ['Monster', 'Boss'].includes(this.model.kind);
    }

    fetchAcquiredExp() {
        return Formulas.calcAcquiredExp(this.fetchLevel(), this.fetchRewardExp());
    }
}

module.exports = NpcModel;
