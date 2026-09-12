const Policy = require('./ClanSocialPolicy');
// One shared projection per clan, on main and on the worker. No SQL on reads.
class ClanSocialView {
    constructor() { this.clans = new Map(); this.indexes = new Map(); this.memberships = new Map(); this.membershipVersion = 0; }
    accept(snapshot) {
        if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.clanId)
            || !Array.isArray(snapshot.relations) || snapshot.relations.length > 160) throw Error('invalid clan social snapshot');
        if ((this.clans.get(snapshot.clanId)?.revision ?? -1) >= snapshot.revision) return false;
        this.clans.set(snapshot.clanId, JSON.parse(JSON.stringify({ ...snapshot, recent: [] })));
        this.indexes.set(snapshot.clanId, new Map(this.clans.get(snapshot.clanId).relations.map(r => [`${r.kind}:${r.targetId}`, r])));
        return true;
    }
    acceptMemberships(rows, version, activeClanIds = null) {
        if (version <= this.membershipVersion) return;
        this.membershipVersion = version;
        this.memberships = new Map(rows.map(r => [r.id, r.clanId]));
        if (activeClanIds) {
            const active = new Set(activeClanIds);
            for (const id of this.clans.keys()) if (!active.has(id)) { this.clans.delete(id); this.indexes.delete(id); }
        }
    }
    identity(input) { return { ...input, clanId: this.membershipVersion > 0 ? (this.memberships.get(input.id) || 0) : (input.clanId || 0) }; }
    assess(source, target, personal, at, impression) {
        const clanId = this.identity(source).clanId;
        return { ...Policy.assess(this.clans.get(clanId), this.identity(target), personal, at, impression, this.indexes.get(clanId)),
            selfDiscipline: Policy.relation(this.indexes.get(clanId)?.get(`character:${source.id}`), at)?.discipline || null };
    }
}
module.exports = ClanSocialView;
