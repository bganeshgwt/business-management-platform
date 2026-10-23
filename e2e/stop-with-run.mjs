// Loaded into the test API before it starts (node --import): the API ends
// when the test run that started it is gone, however the run ended. The run
// holds the other end of this IPC channel, which closes with its process.
// Windows already ends a process's own children with it; Linux and macOS do
// not, and a run killed outright would leave its API holding the test port.
import process from "node:process";

process.on("disconnect", () => process.exit(0));
