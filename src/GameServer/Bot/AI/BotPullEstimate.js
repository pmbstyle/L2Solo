// How many mobs come when one is hit (E72, F20; design 13.8, 13.12): the
// target, its same-clan helpers inside its help radius (SocialAggro), the
// aggressive mobs within the aggro radius (NpcAggro) and a leader's minion
// group. One answer for hot target choice and cold fights. The table is, per
// spawn group (a spot's npc entry), the share of its spawns by pull size (and
// their mean), computed once from the spawns at start; mobs of a neighbouring
// spot cell are not counted.
// Pure: the cold worker loads this module without the live world.
const AggroRange = invoke('GameServer/Npc/NpcAggroRange');

// The record of a live npc for pullSize.
function record(npc) {
    return {
        selfId: Number(npc.fetchSelfId?.() || 0),
        clan: String(npc.fetchClanName?.() || '').trim(),
        helpRadius: Math.max(0, Number(npc.fetchClanHelpRadius?.()) || 0),
        hostile: npc.fetchHostile?.() === true,
        // Minions come through their leader's group (minionJoiners).
        minion: !!npc.minionLeader,
        x: npc.fetchLocX(), y: npc.fetchLocY(), z: npc.fetchLocZ()
    };
}

// Records: { selfId, clan, helpRadius, hostile, minion, x, y, z }.
// rules: { assistZ, aggroRadius, aggroZ } from SocialAggro and NpcAggro;
// an aggressive NPC joins within its own C4 range (NpcAggroRange, T114),
// rules.aggroRadius for one without.
function pullSize(target, neighbours = [], rules = {}, minions = 0) {
    const helpRadius = Number(target.helpRadius) || 0;
    let joiners = 0;
    for (const npc of neighbours) {
        if (npc === target || npc.minion) continue;
        const dx = npc.x - target.x, dy = npc.y - target.y;
        const dz = Math.abs(npc.z - target.z);
        const distanceSq = dx * dx + dy * dy;
        const helps = !!target.clan && npc.clan === target.clan && helpRadius > 0
            && distanceSq <= helpRadius * helpRadius && dz <= rules.assistZ;
        const range = AggroRange.of(npc.selfId, rules.aggroRadius);
        const aggro = npc.hostile === true && distanceSq <= range * range
            && dz <= rules.aggroZ;
        if (helps || aggro) joiners++;
    }
    return 1 + joiners + Math.max(0, Number(minions) || 0);
}

// Lisvus minion rows (RaidBossMinionManager.groupsByBoss): a leader brings the
// mean size of each of its groups; a hit minion alerts its leader and the rest
// of the group, the same number of other mobs.
function minionJoiners(groupsByBoss) {
    const joiners = new Map();
    for (const [bossId, groups] of groupsByBoss || []) {
        const total = groups.reduce((sum, group) => sum + (Number(group.min) + Number(group.max)) / 2, 0);
        joiners.set(Number(bossId), total);
        for (const group of groups) {
            if (!joiners.has(Number(group.minionId))) joiners.set(Number(group.minionId), total);
        }
    }
    return joiners;
}

// Sets, on each spot entry with a spawn whose pull is above one, entry.pulls
// ([[size, share], ...] by size, shares to three decimals: user 10-29, a
// spot is a mix of lone mobs, pairs and packs) and entry.pull (their mean,
// one decimal), from the spot's spawn records, and drops the records.
function annotate(spots, rules, joiners = new Map()) {
    let entries = 0, pulls = 0;
    for (const spot of spots) {
        const records = spot.records || [];
        const sizes = new Map();
        for (const record of records) {
            const size = pullSize(record, records, rules, joiners.get(Number(record.selfId)));
            const bySize = sizes.get(record.selfId) || new Map();
            bySize.set(size, (bySize.get(size) || 0) + 1);
            sizes.set(record.selfId, bySize);
        }
        for (const entry of spot.npcEntries || []) {
            entries++;
            const bySize = sizes.get(entry.selfId);
            if (!bySize || ![...bySize.keys()].some(size => size > 1)) continue;
            const count = [...bySize.values()].reduce((sum, n) => sum + n, 0);
            entry.pulls = [...bySize].sort((a, b) => a[0] - b[0]).map(([size, n]) => [size, Math.round(n / count * 1000) / 1000]);
            entry.pull = Math.round([...bySize].reduce((sum, [size, n]) => sum + size * n, 0) / count * 10) / 10;
            pulls++;
        }
        delete spot.records;
    }
    return { entries, pulls };
}

function entryPull(spot, selfId) {
    const id = Number(selfId);
    const entry = spot?.npcEntries?.find(item => Number(item.selfId) === id);
    return Number(entry?.pull) > 1 ? Number(entry.pull) : 1;
}

// The mobs of a pull of k that hit the fighter, on average over the fight:
// (k + 1) / 2 while single-target hits fell them one by one, all k while an
// area skill wears them down together; areaShare: the share of the
// fighter's damage dealt by area skills.
function packFactor(k, areaShare = 0) {
    const share = Math.min(1, Math.max(0, Number(areaShare) || 0));
    return (k + 1) / 2 * (1 - share) + k * share;
}

// A pull of k as one mob: k times the HP, and the attack of its mobs still
// standing on average (packFactor). The view keeps k for the area skills
// that hit every mob of it, its pack for its skills' damage (coldMobAction)
// and one mob's attack (unitPAtk) to be packed anew (repack).
function pullView(target, k, areaShare = 0) {
    if (!(k > 1)) return target;
    const pack = packFactor(k, areaShare);
    return { ...target, maxHp: target.maxHp * k, pAtk: target.pAtk * pack, pull: k, pack, unitPAtk: target.pAtk };
}

// A pull view packed for another area share (the same one mob).
function repack(view, areaShare = 0) {
    if (!(Number(view?.pull) > 1) || !Number.isFinite(Number(view.unitPAtk))) return view;
    const pack = packFactor(view.pull, areaShare);
    return pack === view.pack ? view : { ...view, pAtk: view.unitPAtk * pack, pack };
}

// The mobs that hit as one of a view (1 for a lone mob; a saved encounter
// of an older view: (k + 1) / 2).
function packOf(view) {
    if (Number(view?.pack) > 0) return Number(view.pack);
    return Number(view?.pull) > 1 ? packFactor(Number(view.pull)) : 1;
}

// An entry's pulls by size, [[size, share], ...]: its measured ones, else the
// two whole sizes around its mean, else one mob.
function pullsOf(entry) {
    if (Array.isArray(entry?.pulls) && entry.pulls.length) return entry.pulls;
    const mean = Number(entry?.pull) || 1;
    if (!(mean > 1)) return [[1, 1]];
    const whole = Math.floor(mean), part = mean - whole;
    return part > 0 ? [[whole, 1 - part], [whole + 1, part]] : [[whole, 1]];
}

// One size from pulls [[size, share], ...] (shares need not sum to one).
function rollPulls(pulls, rng) {
    const total = pulls.reduce((sum, [, share]) => sum + share, 0);
    if (pulls.length === 1 || !(total > 0)) return pulls[0]?.[0] || 1;
    let needle = rng() * total;
    for (const [size, share] of pulls) {
        needle -= share;
        if (needle < 0) return size;
    }
    return pulls[pulls.length - 1][0];
}

module.exports = { record, pullSize, minionJoiners, annotate, entryPull, packFactor, pullView, repack, packOf, pullsOf, rollPulls };
