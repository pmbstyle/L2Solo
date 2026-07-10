const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const Skill = invoke('GameServer/Model/Skill');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

const CubicSkills = {
    1: [{ id: 4049, name: 'Cubic Drain', powers: [26, 31, 36, 41, 45, 48, 51, 54] }],
    2: [{ id: 4050, name: 'Cubic Drain', powers: [29, 33, 39, 43, 46, 50, 53] }],
    3: [{ id: 4051, name: 'Cubic Heal', powers: [201, 241, 281, 314, 339, 361, 382] }],
    4: [{ id: 4052, name: 'Poison', buff: 30000, powers: [70, 70, 70, 70, 70, 70] }],
    5: [{ id: 4053, name: 'Decrease P. Atk.', buff: 120000, powers: Array(8).fill(80) }, { id: 4054, name: 'Decrease P. Def.', buff: 120000, powers: Array(8).fill(80) }, { id: 4055, name: 'Decrease Atk. Spd.', buff: 120000, powers: Array(8).fill(80) }],
    6: [{ id: 4164, name: 'Paralysis', buff: 120000, powers: Array(9).fill(15) }],
    7: [{ id: 4165, name: 'Icy Air', buff: 15000, powers: [77, 77, 77, 94, 94, 108, 108, 118, 118] }],
    8: [{ id: 4166, name: 'Shock', buff: 9000, powers: Array(9).fill(80) }]
};

function cubicsFor(actor) {
    if (!(actor.cubics instanceof Map)) actor.cubics = new Map();
    return actor.cubics;
}

function idsFor(actor) {
    return [...(actor?.cubics?.keys?.() || [])];
}

function slotCount(actor) {
    const mastery = actor?.skillset?.fetchSkill?.(143);
    return Math.max(1, (Number(mastery?.fetchLevel?.()) || 0) + 1);
}

function notify(session, actor) {
    if (typeof actor?.fetchRace !== 'function') return;
    session?.dataSendToMeAndOthers?.(ServerResponse.userInfo(actor), actor);
}

function remove(session, actor, cubicId) {
    const cubic = actor?.cubics?.get?.(Number(cubicId));
    if (!cubic) return false;
    clearTimeout(cubic.expireTimer);
    clearInterval(cubic.actionTimer);
    actor.cubics.delete(Number(cubicId));
    notify(session, actor);
    return true;
}

function buildSkill(cubic, definition) {
    const level = Math.max(1, Math.min(cubic.level, definition.powers.length));
    return new Skill({
        selfId: definition.id,
        name: definition.name,
        level,
        power: definition.powers[level - 1],
        spell: true,
        distance: 900,
        buff: definition.buff || 0,
        hitTime: 0,
        reuse: 0,
        mp: 0,
        hp: 0
    });
}

function distance2d(src, dst) {
    const dx = Number(src?.fetchLocX?.() || 0) - Number(dst?.fetchLocX?.() || 0);
    const dy = Number(src?.fetchLocY?.() || 0) - Number(dst?.fetchLocY?.() || 0);
    return Math.sqrt(dx * dx + dy * dy);
}

function selectedEnemy(session, actor) {
    const targetId = actor.fetchDestId?.();
    if (targetId === undefined || targetId === null) return Promise.resolve(null);
    return World.fetchNpc(targetId).catch(() => World.fetchUser(targetId).catch(() => null))
        .then((target) => {
            if (!target || target.isDead?.() === true || distance2d(actor, target) > 900) return null;
            if (target.fetchAttackable?.() === true) return target;

            const leaderSession = session?.partyCompanion === true && session.followPlayerSession
                ? session.followPlayerSession
                : session;
            const partyActors = PartyAwareness.partyActors(leaderSession);
            if (target === actor || partyActors.includes(target)) return null;
            return target.fetchIsOnline?.() === true && (target.fetchKarma?.() > 0 || target.fetchPvpFlag?.() > 0)
                ? target
                : null;
        });
}

function act(session, actor, cubic) {
    if (actor.isDead?.() || actor.state?.fetchDead?.() === true) {
        remove(session, actor, cubic.id);
        return;
    }

    const definitions = CubicSkills[cubic.id] || [];
    if (definitions.length === 0) return;
    const lifeCubic = cubic.id === 3;
    if (!lifeCubic && Math.random() * 100 >= cubic.activationChance) return;

    const targetPromise = lifeCubic ? Promise.resolve(actor) : selectedEnemy(session, actor);
    targetPromise.then((target) => {
        if (!target || !actor.cubics?.has(cubic.id)) return;
        const definition = definitions[Math.floor(Math.random() * definitions.length)];
        const skill = buildSkill(cubic, definition);
        const attack = actor.attack || new (invoke('GameServer/Actor/Attack'))();
        session.dataSendToMeAndOthers?.(ServerResponse.magicSkillLaunched(actor, skill, [target]), actor);
        const outcome = SkillEffects.execute(session, actor, target, skill, {
            attack,
            cubicMAtk: cubic.power,
            magicSkill: true
        });
        if (outcome.damage > 0) attack.hit(session, actor, target, outcome.damage);
    });
}

function summon(session, actor, skill, source = actor) {
    const cubicId = Number(skill.fetchSummonNpcId?.()) || 0;
    const lifetime = Number(skill.fetchSummonTotalLifeTime?.()) || 0;
    if (!cubicId || lifetime <= 0) return null;

    const cubics = cubicsFor(actor);
    remove(session, actor, cubicId);

    while (cubics.size >= slotCount(actor)) {
        remove(session, actor, cubics.keys().next().value);
    }

    const cubic = {
        id: cubicId,
        skillId: Number(skill.fetchSelfId?.()) || 0,
        sourceId: Number(source?.fetchId?.()) || 0,
        level: Number(skill.fetchLevel?.()) || 1,
        power: Number(skill.fetchPower?.()) || 0,
        activationChance: Number(skill.fetchSummonActivationChance?.()) || 0,
        activationTime: Number(skill.fetchSummonActivationTime?.()) || 0,
        expiresAt: Date.now() + lifetime
    };
    cubic.expireTimer = setTimeout(() => remove(session, actor, cubicId), lifetime);
    cubic.expireTimer.unref?.();
    cubic.actionTimer = setInterval(() => act(session, actor, cubic), Math.max(1, cubic.activationTime) * 1000);
    cubic.actionTimer.unref?.();
    cubics.set(cubicId, cubic);
    notify(session, actor);
    return cubic;
}

module.exports = {
    act,
    idsFor,
    remove,
    selectedEnemy,
    summon
};
