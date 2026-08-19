function evaluate(input = {}) {
    const {
        cadenceRatio = 0,
        playerSchedule = {},
        playerHandler = {},
        observerLatency = {},
        observerBuilds = 0,
        eventLoopMaxMs = 0,
        population = {},
        preparedDue = 0,
        databaseFailures = 0,
        thresholds = {}
    } = input;
    const violations = [];

    if (cadenceRatio < 0.85) violations.push('player_probe_cadence');
    if (playerSchedule.p95Ms > thresholds.scheduleP95Ms) violations.push('player_schedule_p95');
    if (playerSchedule.p99Ms > thresholds.scheduleP99Ms) violations.push('player_schedule_p99');
    if (playerSchedule.maxMs > thresholds.scheduleMaxMs) violations.push('player_schedule_max');
    if (playerHandler.p95Ms > thresholds.handlerP95Ms) violations.push('player_handler_p95');
    if (playerHandler.p99Ms > thresholds.handlerP99Ms) violations.push('player_handler_p99');
    if (observerLatency.p95Ms > thresholds.observerP95Ms) violations.push('observer_p95');
    if (eventLoopMaxMs > thresholds.eventLoopMaxMs) violations.push('event_loop_max');
    if (observerBuilds < 1 || observerLatency.samples < 1) violations.push('observer_inactive');
    if (population.activity?.mode !== 'player' || population.activity?.realPlayers !== 1) {
        violations.push('player_protection_inactive');
    }
    if (population.counts?.total < population.coldMinimum) violations.push('cold_population_missing');
    if (preparedDue < 1) violations.push('cold_due_probe_missing');
    if (population.delta?.coldOwnerResolved < 1 || population.delta?.coldOwnerCommitted < 1) {
        violations.push('cold_world_stalled');
    }
    if (population.delta?.coldOwnerErrors > 0 || population.delta?.coldOwnerTimeouts > 0) {
        violations.push('cold_worker_errors');
    }
    if (databaseFailures > 0) violations.push('database_failures');

    return violations;
}

module.exports = { evaluate };
