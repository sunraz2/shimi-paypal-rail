// Real PayPal Developer Platform integration (Orders v2 + Webhook signature verification).
// Uses the PayPal SANDBOX by default. Set PAYPAL_ENV=live only for production.
// Required env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID
const HOST = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

async function accessToken() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  const r = await fetch(HOST + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
               "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials" });
  if (!r.ok) throw new Error("paypal_auth_failed_" + r.status);
  return (await r.json()).access_token;
}

// Create a real PayPal order. Returns the approval URL the buyer opens to pay.
async function createOrder({ amount, currency = "ILS", description, checkout_ref, return_url, cancel_url }) {
  const token = await accessToken();
  const r = await fetch(HOST + "/v2/checkout/orders", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json",
               "PayPal-Request-Id": checkout_ref },          // idempotency key
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: checkout_ref, custom_id: checkout_ref, description,
        amount: { currency_code: currency, value: Number(amount).toFixed(2) } }],
      payment_source: { paypal: { experience_context: { return_url, cancel_url, user_action: "PAY_NOW" } } }
    }) });
  const d = await r.json();
  if (!r.ok) throw new Error("create_order_failed_" + r.status + "_" + JSON.stringify(d).slice(0, 160));
  const approve = (d.links || []).find(l => l.rel === "payer-action" || l.rel === "approve");
  return { order_id: d.id, approve_url: approve && approve.href };
}

// Capture an approved order (after the buyer returns).
async function captureOrder(order_id) {
  const token = await accessToken();
  const r = await fetch(HOST + "/v2/checkout/orders/" + order_id + "/capture", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  const d = await r.json();
  if (!r.ok) throw new Error("capture_failed_" + r.status);
  const cap = d.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: d.status, capture_id: cap?.id, amount: cap?.amount, custom_id: d.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id };
}

// Verify a webhook with PayPal's own signature-verification endpoint (fail-closed).
// Without this, anybody could POST status=COMPLETED. Returns true ONLY on SUCCESS.
async function verifyWebhook(headers, rawEventBody) {
  const webhook_id = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhook_id) return false;                               // fail closed
  const h = k => headers[k] || headers[k.toLowerCase()];
  const token = await accessToken();
  const r = await fetch(HOST + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"), webhook_id,
      webhook_event: JSON.parse(rawEventBody) }) });
  if (!r.ok) return false;
  return (await r.json()).verification_status === "SUCCESS";
}

module.exports = { createOrder, captureOrder, verifyWebhook, HOST };
