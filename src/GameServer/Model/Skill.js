class SkillModel {
    constructor(data) {
        this.model = data;
        // Every NPC instance builds its own skills: equal skills share one
        // read-only semantic from the resolve memo; the model stays per instance.
        this.semantic = invoke('GameServer/Skills/C4SkillRules').resolveCached(data);
    }

    // Set

    setCalculatedHitTime(data) {
        this.model.calculatedHitTime = data;
    }

    // Get

    fetchSelfId() {
        return this.model.selfId;
    }

    fetchLevel() {
        return this.model.level;
    }

    fetchName() {
        return this.model.name;
    }

    fetchPassive() {
        return this.model.passive;
    }

    // The one "is magic" answer (cast type: cast speed, spiritshot, cast break,
    // magic MP and land rate), hot and cold: the data flag (Lisvus isMagic),
    // unless C4SkillRules overrides it. Cold records copy it (ColdCombatProfile).
    fetchSpell() {
        return this.semantic.isMagic ?? (this.model.spell === true);
    }

    fetchDistance() {
        return this.model.distance;
    }

    fetchConsumedHp() {
        return this.semantic.hpConsume ?? this.model.hp;
    }

    fetchConsumedMp() {
        return this.semantic.mpConsume ?? this.model.mp;
    }

    fetchHitTime() {
        return this.semantic.hitTime ?? this.model.hitTime;
    }

    fetchCalculatedHitTime() {
        return this.model.calculatedHitTime ?? this.fetchHitTime();
    }

    fetchReuseTime() {
        return this.semantic.reuseTime ?? this.model.reuse;
    }

    fetchPower() {
        return this.semantic.power ?? this.model.power;
    }

    fetchTeleportCoords() {
        if (
            Number.isFinite(Number(this.model.locX)) &&
            Number.isFinite(Number(this.model.locY)) &&
            Number.isFinite(Number(this.model.locZ))
        ) {
            return {
                locX: Number(this.model.locX),
                locY: Number(this.model.locY),
                locZ: Number(this.model.locZ)
            };
        }
        return null;
    }

    fetchItemConsumeId() {
        return this.model.itemId;
    }

    fetchItemConsumeCount() {
        return this.model.itemCount ?? 0;
    }

    fetchOngoingItemConsumeCount() {
        return this.model.itemCountOT ?? 0;
    }

    fetchOngoingItemConsumeId() {
        return this.model.itemIdOT ?? 0;
    }

    fetchOngoingItemConsumeSteps() {
        return this.model.itemConsumeSteps ?? 0;
    }

    fetchSummonNpcId() {
        return this.model.npcId;
    }

    fetchSummonTotalLifeTime() {
        return this.model.totalLifeTime ?? 0;
    }

    fetchSummonTimeLostIdle() {
        return this.model.timeLostIdle ?? 0;
    }

    fetchSummonTimeLostActive() {
        return this.model.timeLostActive ?? 0;
    }

    fetchSummonIsCubic() {
        return this.model.isCubic === true;
    }

    fetchSummonActivationChance() {
        return this.model.activationChance ?? 0;
    }

    fetchSummonActivationTime() {
        return this.model.activationTime ?? 0;
    }

    fetchBuffTime() {
        return this.semantic.durationMs ?? this.model.buff;
    }

    fetchSemantic() {
        return this.semantic;
    }

    fetchSkillType() {
        return this.semantic.skillType;
    }

    fetchTargetKind() {
        return this.semantic.target;
    }

    fetchSsBoost() {
        return this.semantic.ssBoost;
    }
}

module.exports = SkillModel;
