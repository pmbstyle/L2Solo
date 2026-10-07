'use strict';
const hundredth = value => Math.round(value * 100) / 100;
const positive = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
function arrived(stats = {}) {
    const hours = positive(stats.playedHours);
    const prior = stats.visitEvery;
    const last = positive(prior?.[0]), average = positive(prior?.[1]);
    const interval = hours - last;
    if (interval <= 0) return Array.isArray(prior) ? prior : [hundredth(hours), 0];
    return [hundredth(hours), hundredth(last > 0 ? average > 0 ? .5 * average + .5 * interval : interval : average)];
}
function targetHours(stats = {}, fallback = 2) {
    const interval = positive(stats.visitEvery?.[1]);
    return Math.max(.5, Math.min(24, interval > 0 ? interval : fallback));
}
module.exports = { arrived, targetHours };
