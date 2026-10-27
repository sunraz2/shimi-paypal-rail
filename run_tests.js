// One-command test runner: `npm test`.
// Starts the server twice on private ports and runs BOTH suites exactly as documented:
//   1) security suite against a normal (fail-closed) server
//   2) ledger suite against a server with ALLOW_UNSIGNED_TEST_WEBHOOKS=1 (local only)
const { spawn } = require("child_process");
const wait = ms => new Promise(r => setTimeout(r, ms));
function start(port, env) {
  return spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(port), ...env }, stdio: "ignore" });
}
function run(file, base) {
  return new Promise(res => {
    const p = spawn(process.execPath, [file], { env: { ...process.env, BASE: base }, stdio: "inherit" });
    p.on("exit", code => res(code));
  });
}
(async () => {
  const strict = start(8090, { ALLOW_UNSIGNED_TEST_WEBHOOKS: "" });
  const local  = start(8091, { ALLOW_UNSIGNED_TEST_WEBHOOKS: "1" });
  await wait(1500);
  const a = await run("test_security.js", "http://localhost:8090");
  const b = await run("test.js", "http://localhost:8091");
  strict.kill(); local.kill();
  console.log(a === 0 && b === 0 ? "\nALL SUITES PASSED (security + ledger)" : "\nSOME SUITES FAILED");
  process.exit(a === 0 && b === 0 ? 0 : 1);
})();
