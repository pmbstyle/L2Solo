require('./helpers/remainingProfessionHarness').runRoute(6).catch(error => {
    console.error(error); process.exitCode = 1;
});
