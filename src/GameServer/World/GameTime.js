const REAL_DAY_MS = 4 * 60 * 60 * 1000;
const GAME_MINUTE_MS = 10000;
const GAME_MINUTES_PER_DAY = 24 * 60;
const SUNRISE_MINUTE = 6 * 60;

function localMidnight(now = Date.now()) {
    const date = new Date(Number(now));
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function elapsedInGameDay(now = Date.now()) {
    const elapsed = Number(now) - localMidnight(now);
    return ((elapsed % REAL_DAY_MS) + REAL_DAY_MS) % REAL_DAY_MS;
}

function gameMinute(now = Date.now()) {
    return Math.floor(elapsedInGameDay(now) / GAME_MINUTE_MS) % GAME_MINUTES_PER_DAY;
}

function gameHour(now = Date.now()) {
    return Math.floor(gameMinute(now) / 60);
}

function isNight(now = Date.now()) {
    return gameMinute(now) < SUNRISE_MINUTE;
}

function mode(now = Date.now()) {
    return isNight(now) ? 'night' : 'day';
}

function msUntilTransition(now = Date.now()) {
    const elapsed = elapsedInGameDay(now);
    const sunriseAt = SUNRISE_MINUTE * GAME_MINUTE_MS;
    return Math.max(1, isNight(now) ? sunriseAt - elapsed : REAL_DAY_MS - elapsed);
}

module.exports = {
    REAL_DAY_MS,
    GAME_MINUTE_MS,
    SUNRISE_MINUTE,
    localMidnight,
    gameMinute,
    gameHour,
    isNight,
    mode,
    msUntilTransition
};
