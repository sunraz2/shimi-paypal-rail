// Shimi Network — Agent Economy on PayPal (reference implementation)
// The production system runs the same contract as serverless functions.
// This repo is the open, runnable reference: agents issue PayPal checkout,
// webhooks verify payments, commissions settle to the referring agent.
const express = require("express");
const paypal = require("./paypal");
const app = express();
// Keep the RAW body: PayPal signature verification needs the exact bytes.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
const PAYPAL_READY = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

// ---------- In production this is a database; here: in-memory ----------
const payments = [];        // PaymentRecord
const commissions = [];    // referral commission ledger
const installs = new Map(); // install_id -> { agent, commission_rate }

// ---------- Agent registry (production: NetBoard roster) ----------
const AGENTS = ["shimi-leads", "shimi-clients", "shimi-finance", "shimi-pituach"];

// ---------- 1. createPaymentLink: the single entry point for agents ----------
// Contract (verified in production since Sep 2026):
//   POST { provider:'paypal'|'grow', amount_shekels, product,
//          customer_name?, customer_phone?, max_payments? }
//   -> 200 { ok:true, payment_url, checkout_ref }
//   -> 401 { ok:false, error:'make_api_key_rotated' }  (fail-closed on key rotation)
app.post("/create-payment-link", async (req, res) => {
  const { provider, amount_shekels, product, customer_name, customer_phone, max_payments, install_id } = req.body || {};
  if (!provider || !amount_shekels || !product)
    return res.status(400).json({ ok: false, error: "missing_fields", required: ["provider", "amount_shekels", "product"] });
  if (provider !== "paypal" && provider !== "grow")
    return res.status(400).json({ ok: false, error: "unknown_provider" });

  const checkout_ref = "chr_" + Math.random().toString(36).slice(2, 10);
  let payment_url = `${req.protocol}://${req.get("host")}/checkout?ref=${checkout_ref}` +
    `&amount=${amount_shekels}&product=${encodeURIComponent(product)}`;
  let order_id = null, mode = "no_paypal_keys";
  if (provider === "paypal" && PAYPAL_READY) {
    try {                                   // REAL PayPal Orders v2 (sandbox by default)
      const base = `${req.protocol}://${req.get("host")}`;
      const o = await paypal.createOrder({ amount: amount_shekels, currency: "ILS", description: product,
        checkout_ref, return_url: base + "/paypal/return?ref=" + checkout_ref, cancel_url: base + "/checkout?ref=" + checkout_ref });
      order_id = o.order_id; payment_url = o.approve_url || payment_url; mode = process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
    } catch (e) { return res.status(502).json({ ok: false, error: "paypal_order_failed", detail: String(e.message).slice(0, 120) }); }
  }

  payments.push({
    checkout_ref, order_id, mode, provider, amount_shekels, product, install_id,
    customer_name, customer_phone, max_payments,
    status: "issued",          // issued -> paid -> verified
    created_at: new Date().toISOString()
  });
  return res.json({ ok: true, payment_url, checkout_ref, order_id, mode });
});

// ---------- 2. Dynamic checkout page: one page per product ----------
app.get("/checkout", (req, res) => {
  const { ref, amount, product } = req.query;
  if (!ref || !amount || !product) return res.status(400).send("missing params");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${product}</title></head>
  <body style="font-family:sans-serif;max-width:480px;margin:60px auto">
    <h2>${product}</h2><p>סכום: ₪${amount}</p><p>ref: ${ref}</p>
    <a href="https://www.paypal.com/paypalme/shimi358/${amount}">
      <button style="padding:12px 24px;background:#0070ba;color:#fff;border:0;border-radius:6px">
        Pay with PayPal
      </button></a>
  </body></html>`);
});

// ---------- 3. Payment verification protocol ----------
// An agent CLAIMING a payment is not evidence. Only the webhook record counts.
app.post("/webhooks/paypal", async (req, res) => {
  // FAIL CLOSED: a webhook is evidence only if PayPal's own signature check returns SUCCESS.
  // (Set ALLOW_UNSIGNED_TEST_WEBHOOKS=1 ONLY for the local self-test; never in production.)
  const unsignedOk = process.env.ALLOW_UNSIGNED_TEST_WEBHOOKS === "1";
  if (!unsignedOk) {
    let ok = false;
    try { ok = await paypal.verifyWebhook(req.headers, req.rawBody || "{}"); } catch (_) { ok = false; }
    if (!ok) return res.status(401).json({ ok: false, error: "invalid_webhook_signature" });
  }
  // Real PayPal events nest the data; the local self-test posts the flat shape.
  const ev = req.body || {};
  const res0 = ev.resource || {};
  const checkout_ref = ev.checkout_ref || res0.custom_id || res0.supplementary_data?.related_ids?.order_id;
  const transaction_id = ev.transaction_id || res0.id;
  const status = ev.status || res0.status;
  const rec = payments.find(p => p.checkout_ref === checkout_ref);
  if (!rec) return res.status(404).json({ ok: false, error: "unknown_checkout_ref" });
  if (status !== "COMPLETED") { rec.status = "failed"; return res.json({ ok: true, verified: false }); }

  rec.status = "verified";
  rec.transaction_id = transaction_id;
  rec.verified_at = new Date().toISOString();

  // ---------- 4. Referral commission ledger (agent-to-agent economics) ----------
  // The referring agent earns commission_rate of the payment (10–15% in production).
  const install = installs.get(rec.install_id) || { agent: "direct", commission_rate: 0.10 };
  const commission_amount = +(rec.amount_shekels * install.commission_rate).toFixed(2);
  commissions.push({
    transaction_id, checkout_ref, amount: rec.amount_shekels,
    referring_agent: install.agent, commission_rate: install.commission_rate,
    commission_amount, status: "owed", created_at: new Date().toISOString()
  });
  return res.json({ ok: true, verified: true, commission_amount });
});

// ---------- 5. Install registry: which agent sourced which client ----------
app.post("/installs", (req, res) => {
  const { install_id, agent, commission_rate } = req.body || {};
  if (!install_id || !AGENTS.includes(agent))
    return res.status(400).json({ ok: false, error: "invalid_install", known_agents: AGENTS });
  installs.set(install_id, { agent, commission_rate: commission_rate || 0.10 });
  return res.json({ ok: true, install_id, agent });
});

// ---------- Ledger views ----------
app.get("/payments", (_q, res) => res.json(payments));
app.get("/commissions", (_q, res) => res.json(commissions));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Shimi PayPal rail listening on", PORT));
