'use strict';

// Only route evidence is cached. Wallets, offers and funding stay native.
class EconomyRouteCache {
    constructor({ send, prepared = () => {}, limit = 64 } = {}) {
        this.send = send; this.prepared = prepared; this.limit = limit;
        this.cards = new Map(); this.sequence = 0;
    }
    read(characterId, key, frame) {
        const id = Number(characterId);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        const held = this.cards.get(id);
        if (held?.key === key) return held.rows || null;
        if (!held && this.cards.size >= this.limit) {
            let victim;
            for (const [owner, card] of this.cards) if (card.rows) { victim = owner; break; }
            if (victim === undefined) return null;
            this.cards.delete(victim);
        }
        const card = { key, requestId: ++this.sequence, rows: null };
        this.cards.set(id, card);
        if (!this.send({ characterId: id, requestId: card.requestId, key, frame })) this.cards.delete(id);
        return null;
    }
    accept(payload) {
        const card = this.cards.get(Number(payload.characterId));
        if (!card || card.requestId !== payload.requestId || card.key !== payload.key || card.rows) return false;
        if (!Array.isArray(payload.rows) || payload.rows.length !== 16) { this.cards.delete(Number(payload.characterId)); return false; }
        card.rows = payload.rows;
        this.prepared(Number(payload.characterId), card.key);
        return true;
    }
    forget(id) { this.cards.delete(Number(id)); }
    clear() { this.cards.clear(); }
}
module.exports = { EconomyRouteCache };
