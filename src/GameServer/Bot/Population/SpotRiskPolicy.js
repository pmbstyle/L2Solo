const MIN_DEATHS_AT_SPOT = 2;
const MIN_DEATH_RATE = 0.2;
const RISK_WINDOW_VERSION = 2;
const RISK_WINDOW_FIGHTS = 12;
const MAX_LOW_WIN_RATE = 0.25;
// Death marks (died here) live a number of the holder's own steps
// (stats.stepCount: +1 per far step; a party's own rounds), not a clock.
// Today's minutes as steps: a death mark 60, doubling per repeat up to 360.
const BACKOFF_STEPS = 60;
const MAX_BACKOFF_STEPS = 360;
const MAX_BACKOFFS = 8;
const MAX_FAILED_HUNTS = 3;
const FAILED_HUNT_RECOVERY_WINS = 3;
// Spots a bot's situation ruled out (situations.md B6: spot_unreachable, a walk or
// gatekeeper relocation that failed; spot_dangerous on ground it may not hunt alone;
// contest_lost, a spot contest it lost at its arrival, SpotContest):
// stats.spotMarks [{ spotId, reason, answer }], the latest MAX_SPOT_MARKS kept
// (limits.md). answer: the held earning answer's time when it was raised (null: none);
// a mark holds against the search that answer's successor comes from, and lapses when
// a new answer is held: the bot's next own situation that re-decides the spot. No clock.
const MAX_SPOT_MARKS = 8;

function normalizedSpotId(value) {
    const spotId = String(value || '').trim();
    return spotId || null;
}

function pressureForWindow({ spotId, fights = 0, wins = 0, deaths = 0, unrecoveredDeaths = 0, failedHunts = 0 } = {}) {
    const resolved = Math.max(0, Number(fights || 0));
    const won = Math.max(0, Math.min(resolved, Number(wins || 0)));
    const dead = Math.max(0, Number(deaths || 0));
    const deathRate = dead / Math.max(1, resolved);
    if ((dead >= MIN_DEATHS_AT_SPOT && deathRate >= MIN_DEATH_RATE) || unrecoveredDeaths >= MIN_DEATHS_AT_SPOT) {
        return { spotId, deaths: Math.max(dead, unrecoveredDeaths), fights: resolved, wins: won, deathRate, winRate: won / Math.max(1, resolved), reason: 'death_pressure' };
    }
    const winRate = won / Math.max(1, resolved);
    if (resolved >= RISK_WINDOW_FIGHTS && winRate <= MAX_LOW_WIN_RATE) {
        return { spotId, deaths: dead, fights: resolved, wins: won, deathRate, winRate, reason: 'low_win_rate' };
    }
    if (failedHunts >= MAX_FAILED_HUNTS) {
        return { spotId, deaths: dead, fights: resolved, wins: won, deathRate, winRate, reason: 'failed_hunts' };
    }
    return null;
}

function recordResolve(previous = {}, sample = {}) {
    const spotId = normalizedSpotId(sample.spotId);
    const timestamp = Number(sample.timestamp || Date.now());
    const sameSpot = spotId && normalizedSpotId(previous.spotId) === spotId;
    const currentWindow = sameSpot && Number(previous.version || 0) === RISK_WINDOW_VERSION
        ? pressureForWindow({
            spotId,
            fights: previous.windowFights,
            wins: previous.windowWins,
            deaths: previous.windowDeaths,
            unrecoveredDeaths: previous.unrecoveredDeaths,
            failedHunts: previous.failedHunts
        })
        : null;
    // Keep a failed sample stable until the existing routing pass consumes it.
    // This prevents a delayed travel/rest cycle from diluting the signal and
    // also keeps the persisted counters bounded without a separate timer.
    if (currentWindow) return { ...previous };
    const continueWindow = sameSpot
        && Number(previous.version || 0) === RISK_WINDOW_VERSION
        && Number(previous.windowFights || 0) < RISK_WINDOW_FIGHTS;
    const base = continueWindow ? previous : {};
    const deaths = Math.max(0, Number(sample.deaths || 0));
    const recoveryWins = deaths ? 0 : Math.min(RISK_WINDOW_FIGHTS,
        (sameSpot ? Number(previous.recoveryWins || 0) : 0) + Math.max(0, Number(sample.wins || 0)));
    const unrecoveredDeaths = recoveryWins >= RISK_WINDOW_FIGHTS ? 0 : Math.min(MIN_DEATHS_AT_SPOT,
        (sameSpot ? Number(previous.unrecoveredDeaths ?? previous.windowDeaths ?? 0) : 0) + deaths);

    const failedHuntRecoveryWins = deaths || sample.failedHunts ? 0 : Math.min(FAILED_HUNT_RECOVERY_WINS,
        (sameSpot ? Number(previous.failedHuntRecoveryWins || 0) : 0) + Math.max(0, Number(sample.wins || 0)));

    return {
        version: RISK_WINDOW_VERSION,
        spotId,
        enteredAt: sameSpot && Number(previous.version || 0) === RISK_WINDOW_VERSION
            ? Number(previous.enteredAt || timestamp)
            : timestamp,
        deathsAtEntry: sameSpot && Number(previous.version || 0) === RISK_WINDOW_VERSION
            ? Number(previous.deathsAtEntry || 0)
            : Math.max(0, Number(sample.totalDeaths || 0)),
        fightsAtEntry: sameSpot && Number(previous.version || 0) === RISK_WINDOW_VERSION
            ? Number(previous.fightsAtEntry || 0)
            : Math.max(0, Number(sample.totalFights || 0)),
        winsAtEntry: sameSpot && Number(previous.version || 0) === RISK_WINDOW_VERSION
            ? Number(previous.winsAtEntry || 0)
            : Math.max(0, Number(sample.totalWins || 0)),
        windowFights: Math.max(0, Number(base.windowFights || 0)) + Math.max(0, Number(sample.fights || 0)),
        windowWins: Math.max(0, Number(base.windowWins || 0)) + Math.max(0, Number(sample.wins || 0)),
        windowDeaths: Math.max(0, Number(base.windowDeaths || 0)) + Math.max(0, Number(sample.deaths || 0)),
        recoveryWins, unrecoveredDeaths,
        failedHuntRecoveryWins,
        // The round hunted the spot for an item (its held step's material hunt there).
        ...(sample.itemHunt === true ? { itemHunt: true } : {}),
        // A lucky kill must not erase repeated abandoned fights. Require a
        // short run of clean wins before trusting the same ground again.
        failedHunts: Math.min(MAX_FAILED_HUNTS,
            (sameSpot && failedHuntRecoveryWins < FAILED_HUNT_RECOVERY_WINS && !deaths ? Number(previous.failedHunts || 0) : 0)
            + Math.max(0, Number(sample.failedHunts || 0)))
    };
}

// Ground the bot hunts for an item (its held step's material hunt) is left at its first
// death there while that death is a fifth of its fights since it came (our choice): the
// item has other sources and the market, and a bot that went back died there again (a
// level-34 Puncher killed level 29-35 bots in 1-3 fights). Wins it had there before keep
// it; any other ground (earning, progress, a gear plan's, a party's) takes two deaths
// at a fifth of its fights. Totals are the state's after the round.
function itemHuntDeath(state, risk, spotId) {
    if (risk.itemHunt !== true) return null;
    const deaths = Math.max(0, Number(state.stats?.deaths || 0) - Number(risk.deathsAtEntry || 0));
    const fights = Math.max(0, Number(state.stats?.fightsResolved || 0) - Number(risk.fightsAtEntry || 0));
    const deathRate = deaths / Math.max(1, fights);
    return deaths >= 1 && deathRate >= MIN_DEATH_RATE
        ? { spotId, deaths, fights, wins: Math.max(0, fights - deaths), deathRate, reason: 'death_pressure' } : null;
}

function deathPressure(state = {}, spotId = state.spotId) {
    const expectedSpotId = normalizedSpotId(spotId);
    const risk = state.stats?.spotRisk;
    if (!expectedSpotId || normalizedSpotId(risk?.spotId) !== expectedSpotId) return null;

    if (Number(risk.version || 0) === RISK_WINDOW_VERSION) {
        return itemHuntDeath(state, risk, expectedSpotId) || pressureForWindow({
            spotId: expectedSpotId,
            fights: risk.windowFights,
            wins: risk.windowWins,
            deaths: risk.windowDeaths,
            unrecoveredDeaths: risk.unrecoveredDeaths,
            failedHunts: risk.failedHunts
        });
    }

    const deaths = Math.max(0, Number(state.stats?.deaths || 0) - Number(risk.deathsAtEntry || 0));
    const fights = Math.max(0, Number(state.stats?.fightsResolved || 0) - Number(risk.fightsAtEntry || 0));
    const deathRate = deaths / Math.max(1, fights);
    if (deaths < MIN_DEATHS_AT_SPOT || deathRate < MIN_DEATH_RATE) return null;
    return { spotId: expectedSpotId, deaths, fights, deathRate };
}

function recoveryFor(state = {}) {
    if (state.party?.partyId || state.partyId) return null;
    if (state.stats?.huntingRecovery) return state.stats.huntingRecovery;
    // Adopt a persisted failed visit on the first routing pass after upgrade.
    const deaths = Number(state.stats?.spotRisk?.unrecoveredDeaths ?? state.stats?.spotRisk?.windowDeaths ?? 0);
    if (!deaths && !deathPressure(state)) return null;
    return { levelPenalty: Math.min(6, Math.max(2, deaths * 2)), cleanWins: 0,
        resumeExp: Math.max(Number(state.exp || 0), Number(state.stats?.deathExperience?.expBeforeDeath || 0)) };
}

function recordRecovery(state, { deaths = 0, wins = 0, exp, expBeforeDeath, pressure } = {}) {
    let recovery = recoveryFor(state);
    if (deaths || pressure) {
        recovery = { levelPenalty: Math.min(6, Math.max(2, Number(recovery?.levelPenalty || 0) + (deaths ? 2 : 0))),
            cleanWins: 0, resumeExp: Math.max(Number(recovery?.resumeExp || 0), Number(expBeforeDeath ?? state.exp ?? 0)) };
    } else if (recovery?.levelPenalty > 0) {
        recovery = { ...recovery, cleanWins: Math.min(RISK_WINDOW_FIGHTS, Number(recovery.cleanWins || 0) + wins) };
        if (recovery.cleanWins >= RISK_WINDOW_FIGHTS && exp >= recovery.resumeExp) {
            recovery = { ...recovery, levelPenalty: Math.max(0, recovery.levelPenalty - 2), cleanWins: 0 };
        }
    }
    return recovery;
}

// One hunting record of a bot on its own, on either thread: a far round
// (BotLifeState.prepareResolve) or a near body's won fight or death (BotLifeState.recordNearFight).
// It moves the spot's risk window, marks the spot when the window turns to pressure (a mark
// it did not hold) and moves the leveling recovery, so a death near a player counts as a far
// one. A party member's record keeps its own risk as it was and writes no mark or recovery
// (its party's risk, PartySpotRiskPolicy).
// state: before the record; sample: spotId, fights, wins, deaths (a death is a fight), itemHunt
// (its held step hunts the spot for an item), timestamp, exp after it, expBeforeDeath.
// Returns the stats fields it writes (spotBackoffs only with a new mark).
function recordHunt(state = {}, sample = {}) {
    const stats = state.stats || {};
    if (state.party?.partyId || state.partyId) return { spotRisk: stats.spotRisk };
    const spotId = normalizedSpotId(sample.spotId);
    const timestamp = Number(sample.timestamp || Date.now());
    const deaths = Math.max(0, Number(sample.deaths || 0)), fights = Math.max(0, Number(sample.fights || 0));
    const wins = Math.max(0, Number(sample.wins || 0));
    const spotRisk = recordResolve(stats.spotRisk, {
        spotId, itemHunt: sample.itemHunt === true, timestamp,
        totalDeaths: Number(stats.deaths || 0), totalFights: Number(stats.fightsResolved || 0),
        totalWins: Number(stats.fightsWon || 0), deaths, fights, wins,
        // Only completed, abandoned hunts count. Pending encounter slices
        // and pre-fight recovery have zero completed fights.
        failedHunts: Math.max(0, fights - wins - deaths)
    });
    const after = { ...state, spotId, stats: { ...stats, spotRisk, deaths: Number(stats.deaths || 0) + deaths,
        fightsResolved: Number(stats.fightsResolved || 0) + fights } };
    const pressure = deathPressure(after);
    const marked = pressure && !activeBackoffs(state).some(entry => entry.spotId === spotId)
        ? withBackoff(after, backoffForStates([after], spotId, timestamp), timestamp).stats.spotBackoffs : null;
    return { spotRisk, ...(marked ? { spotBackoffs: marked } : {}),
        huntingRecovery: recordRecovery(state, { deaths, wins, exp: sample.exp, expBeforeDeath: sample.expBeforeDeath,
            pressure: !!pressure }) };
}

// The holder's step counter: a bot's far steps (BotLifeState.prepareResolve),
// a party's rounds (PartySpotRiskPolicy.state passes them as stats.stepCount).
function stepCount(state = {}) {
    return Math.max(0, Number(state?.stats?.stepCount) || 0);
}
// A mark is active while its end lies ahead of its holder's counter. A saved
// mark of the former clock (until, no untilStep) reads as expired.
function markActive(entry, state = {}) {
    return Number(entry?.untilStep) > stepCount(state);
}

// One-time migration of saved wall-clock marks (until, no untilStep), run
// where a saved row becomes a state: the time left becomes steps of the
// holder's counter, one step ~ the default one-minute resolve period; an
// expired mark is dropped. No decision reads a clock.
const MIGRATION_STEP_MS = 60000;
function clockMark(entry) {
    return !!entry && entry.until !== undefined && entry.untilStep === undefined;
}
function markInSteps(entry, counter, now) {
    if (!clockMark(entry)) return entry;
    const left = Math.ceil(Math.max(0, Number(entry.until) - now) / MIGRATION_STEP_MS);
    if (!(left > 0)) return null;
    const next = { ...entry, untilStep: counter + left };
    delete next.until;
    return next;
}
function marksInSteps(stats, now = Date.now(), counter = stepCount({ stats })) {
    if (!stats || typeof stats !== 'object') return stats;
    for (const key of ['spotBackoffs', 'clanHuntBackoffs']) {
        if (Array.isArray(stats[key]) && stats[key].some(clockMark)) {
            stats[key] = stats[key].map(entry => markInSteps(entry, counter, now)).filter(Boolean);
        }
    }
    return stats;
}

function activeBackoffs(state = {}) {
    return (Array.isArray(state.stats?.spotBackoffs) ? state.stats.spotBackoffs : [])
        .filter((entry) => normalizedSpotId(entry?.spotId) && markActive(entry, state))
        .map((entry) => ({
            ...entry,
            spotId: normalizedSpotId(entry.spotId),
            untilStep: Number(entry.untilStep)
        }));
}

function backoffForStates(states = [], spotId, timestamp = Date.now()) {
    const expectedSpotId = normalizedSpotId(spotId);
    if (!expectedSpotId) return null;

    const stored = (states || []).flatMap((state) => activeBackoffs(state))
        .filter((entry) => entry.spotId === expectedSpotId)
        .sort((left, right) => right.untilStep - left.untilStep)[0];
    if (stored) return stored;

    const pressures = (states || [])
        .map((state) => deathPressure(state, expectedSpotId))
        .filter(Boolean)
        .sort((left, right) => right.deathRate - left.deathRate || right.deaths - left.deaths);
    const pressure = pressures[0];
    if (!pressure) return null;
    return {
        ...pressure,
        reason: pressure.reason || 'death_pressure',
        startedAt: timestamp,
        steps: BACKOFF_STEPS
    };
}

// The spots one holder's marks exclude, added to `excluded`: its active
// death marks, its death pressure and its situations' spot marks (spotMarks; a
// party's on its held spot answer, PartySpotRiskPolicy).
// Returns the holder's step at which the first
// of those marks ends (Infinity: none ends by itself; death pressure ends only by
// a resolve, a spot mark only by a new earning answer).
function addExclusions(state, excluded) {
    let untilStep = Infinity;
    const mark = (spotId, entry) => { excluded.add(spotId); untilStep = Math.min(untilStep, Number(entry.untilStep)); };
    activeBackoffs(state).forEach((entry) => mark(entry.spotId, entry));
    const pressure = deathPressure(state);
    if (pressure) excluded.add(pressure.spotId);
    for (const entry of spotMarks(state.stats)) excluded.add(entry.spotId);
    return untilStep;
}

// The held answer a mark is tied to: its time (EquipmentIncomeRoute.answerOf's at), null for none.
const answerKey = stats => stats?.earning ? Number(stats.earning.at) || 0 : null;
// The spot marks of a stats object that hold (written only through Situations' raise).
function spotMarks(stats) {
    if (!Array.isArray(stats?.spotMarks) || !stats.spotMarks.length) return [];
    const answer = answerKey(stats);
    return stats.spotMarks.filter(entry => normalizedSpotId(entry?.spotId) && (entry.answer ?? null) === answer);
}
// The marks with one more (the ones that hold): the spot's earlier mark replaced, the oldest past MAX_SPOT_MARKS
// dropped (dropped: told the count, limits.md).
function withSpotMark(stats, spotId, reason = 'excluded', dropped = null) {
    const id = normalizedSpotId(spotId);
    const kept = spotMarks(stats).filter(entry => String(entry.spotId) !== id);
    if (!id) return kept;
    if (kept.length >= MAX_SPOT_MARKS) dropped?.();
    return [...kept, { spotId: id, reason: String(reason || 'excluded'), answer: answerKey(stats) }].slice(-MAX_SPOT_MARKS);
}
const isMarked = (stats, spotId) => spotMarks(stats).some(entry => String(entry.spotId) === String(spotId));

// Callers still pass a time as the second argument; marks no longer read it.
function excludedSpotIdsForStates(states = []) {
    const excluded = new Set();
    (states || []).forEach((state) => addExclusions(state, excluded));
    return excluded;
}

// The version of one holder's exclusions (a bot, or a party's state), for a
// reader that holds a result over them: revision names the excluded set
// (its sorted ids), so a mark added, removed or expired moves it; untilStep
// is the holder's step (stats.stepCount) at which the set next changes by
// itself by a mark's end, Infinity for none. A reader keeps its result while
// the revision it read stands and compares it at every read: death pressure
// has no end step, it moves with the bot's spot and its risk window.
function exclusionVersion(state = {}) {
    const excluded = new Set();
    const untilStep = addExclusions(state, excluded);
    return { revision: [...excluded].sort().join(','), untilStep };
}

function withBackoff(state = {}, backoff = null, timestamp = Date.now()) {
    const spotId = normalizedSpotId(backoff?.spotId);
    if (!spotId) return state;

    const prior = (Array.isArray(state.stats?.spotBackoffs) ? state.stats.spotBackoffs : [])
        .filter((entry) => normalizedSpotId(entry?.spotId) === spotId)
        .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0];
    // startedAt names one episode (identity), it is never compared with a time.
    const continuing = prior
        && markActive(prior, state)
        && Number(prior.startedAt || 0) === Number(backoff.startedAt || 0);
    const priorAttempts = prior ? Math.max(1, Number(prior.attempts || 1)) : 0;
    const attempts = continuing
        ? priorAttempts
        : Math.max(1, priorAttempts + 1);
    const escalationSteps = Math.min(MAX_BACKOFF_STEPS, BACKOFF_STEPS * (2 ** Math.min(3, attempts - 1)));
    const retained = activeBackoffs(state)
        .filter((entry) => entry.spotId !== spotId);
    // The receiver's own counter + its escalation: a mark copied from another
    // holder (its untilStep, a new mark's steps) does not carry its end over.
    const next = {
        ...backoff,
        spotId,
        reason: backoff.reason || 'death_pressure',
        attempts,
        startedAt: Number(backoff.startedAt || timestamp),
        untilStep: stepCount(state) + escalationSteps
    };
    delete next.until;
    delete next.steps;
    const spotBackoffs = [...retained, next]
        .sort((left, right) => right.untilStep - left.untilStep)
        .slice(0, MAX_BACKOFFS);
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            spotBackoffs
        }
    };
}

module.exports = {
    MIN_DEATHS_AT_SPOT,
    MIN_DEATH_RATE,
    RISK_WINDOW_VERSION,
    RISK_WINDOW_FIGHTS,
    MAX_LOW_WIN_RATE,
    BACKOFF_STEPS,
    MAX_BACKOFF_STEPS,
    MAX_BACKOFFS,
    MAX_SPOT_MARKS,
    spotMarks,
    withSpotMark,
    isMarked,
    marksInSteps,
    MAX_FAILED_HUNTS,
    FAILED_HUNT_RECOVERY_WINS,
    recordResolve,
    recoveryFor,
    recordRecovery,
    recordHunt,
    deathPressure,
    activeBackoffs,
    backoffForStates,
    excludedSpotIdsForStates,
    exclusionVersion,
    stepCount,
    markActive,
    withBackoff
};
