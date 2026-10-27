# Shimi Network: Agent Economy on PayPal

A production payment rail for autonomous AI agents. Built for the
[PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

Shimi Network is a live economy of 58 autonomous AI agents (lead-gen, finance,
development, client service) that serve real clients. The open question this
project answers: **how does an agent move money safely — and prove it?**

## The architecture

```
Agent (closes a service)
   │  POST /create-payment-link {provider, amount, product, customer}
   ▼
Payment rail  ────► dynamic checkout page (one page per product, PayPal first)
   ▲                        │ client pays
   │                        ▼
   └──── PayPal webhook (the ONLY accepted evidence)
   │
   ▼
PaymentRecord → verification protocol → flips business object (appointment → paid)
   │
   ▼
Referral commission ledger (which agent sourced the client, 10–15%, per payment)
```

## Core principles

1. **Agents issue checkout, humans confirm it.** Any agent that closes a deal
   calls one endpoint and gets a live payment page. No human needs to build
   the payment step.
2. **A claim is not evidence.** An agent saying "payment received" proves
   nothing. Only the webhook-verified `PaymentRecord` counts — the same
   verification discipline we apply to every agent action (see
   [LandingVerify](https://github.com/sunraz2/shimi-landingverify)).
3. **The money trail is auditable.** Every payment link issued, payment
   verified and commission owed is logged on the shared network board.
4. **Fail-closed key management.** Payment hook keys rotate without warning;
   the rail returns `make_api_key_rotated` and no key is ever embedded in code.

## This repo

The production system runs this contract as serverless functions on Base44
(agent platform). This repository is the open, runnable **reference
implementation** of the same contract:

- `server.js` — the full rail: create-payment-link, dynamic checkout,
  PayPal webhook verification, install registry, commission ledger.
- `test.js` — end-to-end flow test: agent issues → client pays → webhook
  verifies → commission lands in the ledger.

## Run it

```bash
npm install express
node server.js          # in another shell:
node test.js             # ALL TESTS PASSED: issue -> checkout -> webhook verify -> commission
```

## API contract (as verified in production)

```bash
# Agent issues a payment link
curl -X POST $HOST/create-payment-link -H 'Content-Type: application/json' \
  -d '{"provider":"paypal","amount_shekels":99.90,"product":"Mini-Shimi monthly plan"}'
# -> {"ok":true,"payment_url":".../checkout?ref=chr_xxx&amount=99.90&...","checkout_ref":"chr_xxx"}

# PayPal webhook (verification is the only accepted payment evidence)
curl -X POST $HOST/webhooks/paypal -H 'Content-Type: application/json' \
  -d '{"checkout_ref":"chr_xxx","transaction_id":"PAY-123","status":"COMPLETED"}'
# -> {"ok":true,"verified":true,"commission_amount":14.99}
```

## What's next

- PayPal Orders API (create/capture inside the agent conversation)
- Payouts API for settling the referral commission ledger agent-to-agent
- Subscriptions for recurring agent services

MIT license. Built by Shimi Network.

## Status and honest disclosure (updated 26 Oct 2026)

**What is real in this repository**
- `paypal.js`: a real PayPal Developer Platform integration (OAuth2, **Orders v2** create/capture with idempotency keys, and **webhook signature verification** through PayPal's `verify-webhook-signature` endpoint). Sandbox by default (`PAYPAL_ENV=live` for production).
- `server.js`: the agent-facing rail. `POST /webhooks/paypal` is **fail-closed**: an event is accepted only if PayPal's own verification returns `SUCCESS`. A forged `status: COMPLETED` is rejected with `401`.
- `test_security.js`: proves a forged webhook is rejected, no payment is marked verified and no commission is created.
- `test.js`: the end-to-end ledger test (issue, verify, commission 14.98). It posts a flat event to itself, so it runs **only** with `ALLOW_UNSIGNED_TEST_WEBHOOKS=1`. It tests the ledger math, not a real PayPal payment.

**What is not yet proven**
- A real sandbox payment end to end. This needs sandbox credentials from developer.paypal.com (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`). Until they are set, `/create-payment-link` returns `"mode": "no_paypal_keys"` and does not pretend otherwise.
- The in-memory ledger is a reference. Production uses a database.

**Run it**
```bash
npm install
npm test        # one command: starts the server itself and runs BOTH suites
                # (security: forged webhook rejected; ledger: issue -> verify -> commission 14.98)

# Real sandbox flow (needs credentials from developer.paypal.com)
export PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_WEBHOOK_ID=...
node server.js
```
`npm test` starts two private server instances: one strict (fail-closed, used by the security suite) and one with
`ALLOW_UNSIGNED_TEST_WEBHOOKS=1` (local ledger test only). That flag must never be set in production.

License: MIT (see `LICENSE`).
