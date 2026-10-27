// Security test: an unsigned/forged webhook must be REJECTED (fail closed).
const BASE = process.env.BASE || "http://localhost:8090";
const assert = require("assert");
(async () => {
  let r = await fetch(BASE + "/create-payment-link", {method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({provider:"paypal", amount_shekels:50, product:"forgery test"})});
  const link = await r.json(); assert.ok(link.ok, "link issued");
  assert.equal(link.mode, "no_paypal_keys", "must NOT pretend to be sandbox/live without keys");
  r = await fetch(BASE + "/webhooks/paypal", {method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({checkout_ref: link.checkout_ref, transaction_id:"FORGED-1", status:"COMPLETED"})});
  assert.equal(r.status, 401, "forged webhook must be rejected with 401");
  const pay = (await (await fetch(BASE + "/payments")).json()).find(p => p.checkout_ref === link.checkout_ref);
  assert.equal(pay.status, "issued", "forged webhook must NOT flip the payment to verified");
  const ledger = await (await fetch(BASE + "/commissions")).json();
  assert.ok(!ledger.find(c => c.checkout_ref === link.checkout_ref), "no commission may be created by a forgery");
  console.log("SECURITY TEST PASSED: forged webhook rejected, no payment verified, no commission");
  process.exit(0);
})().catch(e => { console.error("SECURITY TEST FAILED:", e.message); process.exit(1); });
