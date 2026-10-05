require('./helpers/remainingProfessionHarness').runRoute(40).catch(error => {
    console.error(error); process.exitCode = 1;
});
