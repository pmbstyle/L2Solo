require('./helpers/remainingProfessionHarness').runRoute(33).catch(error => {
    console.error(error); process.exitCode = 1;
});
