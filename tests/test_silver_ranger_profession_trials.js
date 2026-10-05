require('./helpers/remainingProfessionHarness').runRoute(24).catch(error => {
    console.error(error); process.exitCode = 1;
});
