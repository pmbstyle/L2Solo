'use strict';

// Owner: how a solo owner fights beside its pet (docs/game-decisions.md,
// "Summoner's pet takes the hits"), the hot SummonerTactics, the cold
// BackgroundResolver, the solo gate (BotTargetMatchup) and the offline hunt
// model alike. The mob hits whoever holds its hate (NpcHate; hate = damage): an
// owner strikes only if its next hit stays under the pet's hate, so it never
// pulls the mob off its pet. Pure: the hot adapter reads Npc.getHating and
// SummonControl.canTake, the cold one the fight's two hate counts and the
// pet's hold; both price a hit by BotTargetMatchup.expectedHit before the cast.

const Roles = invoke('GameServer/Bot/AI/BotRoles');

// The classes that send a pet ahead: a summoner, a necromancer.
function binds(value) {
    return Roles.isSummoner(value) || Roles.isNecromancer(value);
}

// Does the owner hold its next hit? petCanTake: the pet can land a hit on the
// mob. onOwner: the mob is on the owner (a critical passed the pet's hate, an
// aggressive mob came at it, a new pet starts from nothing): it holds only while
// the pet's next hit (petHit) takes the mob back, and strikes when the lead is
// beyond that, so it never stands idle under a mob the pet cannot soon retake.
// Otherwise it holds until nextHit stays under the pet's hate. What ends the
// wait: the pet's hits that raise its hate; a pet that cannot take the mob
// (stunned, asleep, rooted out of reach, stopped short of it, a pet that never
// attacks); the pet's or the mob's death.
function ownerWaits({ petCanTake, onOwner, ownerHate, petHate, nextHit, petHit }) {
    if (!petCanTake) return false;
    if (onOwner) return ownerHate - petHate < petHit;
    return ownerHate + nextHit >= petHate;
}

// The damage an owner deals beside its pet: the whole hits that stay under the hate the pet built.
function ownerCap(petDamage, ownerHit) {
    return ownerHit > 0 ? Math.floor(petDamage / ownerHit) * ownerHit : petDamage;
}

module.exports = { binds, ownerWaits, ownerCap };
