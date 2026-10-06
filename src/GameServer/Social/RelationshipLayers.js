'use strict';

// Hours of the owner's play, rather than a wall-clock sweep. Each event puts
// its share into every layer at once; reading only discounts those shares.
function positive(value) { return Math.max(0, Number(value) || 0); }
function hours(row, input) {
    return Math.max(positive(row?.gameAt), positive(input?.playedHours));
}
function durations(traits = {}) {
    const loyalty = Math.max(0, Math.min(1, Number(traits.loyalty ?? 0.5)));
    const resilience = Math.max(0, Math.min(1, Number(traits.resilience ?? 0.5)));
    return { fast: 0.25 + (1 - resilience) * 0.75,
        middle: 24 + loyalty * 24, long: (7 + loyalty * 7) * 24 / (0.5 + resilience) };
}
function decay(value, elapsed, halfLife) { return positive(value) * 0.5 ** (positive(elapsed) / halfLife); }
function persistent(row, at) {
    const elapsed = Math.max(0, at - positive(row?.gameAt));
    const spans = durations(row?.traits);
    return { grudge: decay(row?.grudge, elapsed, spans.middle), gratitude: decay(row?.gratitude, elapsed, spans.middle) };
}
function apply(row, event) {
    const at = hours(row, event), prior = persistent(row, at);
    const negative = ['mob_contested', 'loot_taken', 'attacked', 'killed', 'aided_opponent', 'party_kicked', 'party_wiped', 'ignored_loot_request', 'insulted'].includes(event.type);
    const loss = positive(event.hours);
    return { ...prior, gameAt: at, traits: event.traits || row?.traits || {},
        grudge: prior.grudge + (negative ? loss : 0), gratitude: prior.gratitude + (!negative ? loss : 0) };
}
function fast(previous, event) {
    const at = hours(previous, event), span = durations(event.traits).fast;
    const old = (Number(previous?.value) || 0) * 0.5 ** (Math.max(0, at - positive(previous?.gameAt)) / span);
    const negative = ['mob_contested', 'loot_taken', 'attacked', 'killed', 'aided_opponent', 'party_kicked', 'party_wiped', 'ignored_loot_request', 'insulted'].includes(event.type);
    return { value: old + (negative ? positive(event.hours) : -positive(event.hours)), gameAt: at, halfLife: span };
}
function fastValue(row, at) {
    if (!row) return 0;
    return row.value * 0.5 ** (Math.max(0, at - row.gameAt) / row.halfLife);
}
module.exports = { durations, persistent, apply, fast, fastValue, hours };
