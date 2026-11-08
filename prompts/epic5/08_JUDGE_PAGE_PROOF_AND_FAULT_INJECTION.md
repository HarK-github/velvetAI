# Epic 5 · Work Package 08 — Judge Page, Technical Proof Panel, and Fault Injection

Priority: P0 (judge page + proof panel) · P1 (fault injection) · Time box: 1.5 days · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

One page, `/judge`, from which a judge can reset the demo, follow the 10-step demo path, inspect the technical proof for any booking, and trigger a dropped PayPal capture response to watch velvetAI reconcile to exactly one payment and one booking.

Spec: `SPEC_V1_1_AMENDMENT.md` J.1, J.3, J.4 item 8 (binding).

## Preconditions

1. WP 04 VERIFIED. WP 02 VERIFIED. WP 03 deployed (fault injection must be proven on hosted with real sandbox + webhook).
2. Locate and report: where provider operations are recorded (`provider_operations` or equivalent), where webhook events are recorded (`webhook_quarantine`, `verified_provider_events`), the reconciliation processor, and the PayPal adapter interface (`PaymentPort`) with its capture method signature.

## Part A — `/judge` page

Access: judge role in judge tenant. Others see "This page is for hackathon judges. Sign in with the judge account from the Devpost testing instructions."

Sections:

1. **Welcome:** 2 sentences on what velvetAI is, plus "Everything here uses PayPal Sandbox and demo data."
2. **Reset demo:** button "Reset demo data" → calls `POST /v1/judge/reset` → shows step progress from `GET /v1/judge/runs/:id` (poll 1 s) and the summary in plain words, for example "Seeded 5 services, 4 providers, 61 demo bookings. Kept 2 paid sandbox bookings (payments can't be deleted)."
3. **Guided demo path:** the 10 J.4 items as a checklist. Each item has one line of explanation and a "Go" link:

| #   | Item                                | Link target                                                                                             |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Ask AI finds a service and time     | opens Ask AI drawer with prefilled prompt "Find a haircut Saturday afternoon"                           |
| 2   | Deposit set by predicted demand     | /schedule with forecast bands on, and Ask AI prefill "What's the deposit Saturday 2 PM vs Monday 9 AM?" |
| 3   | You approve the terms               | explains the approval page appears after Ask AI prepares a hold                                         |
| 4   | Pay the deposit with PayPal Sandbox | shows sandbox buyer instructions (credentials come from Devpost testing instructions; not on the page)  |
| 5   | PayPal webhook verified             | opens proof panel for the latest booking                                                                |
| 6   | Schedule updates live               | /schedule                                                                                               |
| 7   | Attacks blocked                     | /security live run                                                                                      |
| 8   | Lost payment response recovered     | fault injection section below                                                                           |
| 9   | Weak slot found by forecast         | /schedule weak slots panel                                                                              |
| 10  | Weak slot promoted (if built)       | /schedule weak slots panel, or hidden if F6 was cut                                                     |

Checkmarks are stored in localStorage only (no server state).

4. **Recent bookings:** last 10 judge-tenant bookings (not fixtures) with status, payment state, and "View proof".
5. **Fault injection** (Part C).
6. **MCP connection info:** the public MCP URL, protected resource metadata URL, and the note "Agents can prepare bookings but cannot approve or pay." No credentials.

## Part B — Technical proof panel (J.3)

```text
GET /v1/judge/bookings/:bookingId/proof
Auth: judge:proof in judge tenant
```

Response (every field optional if not yet reached; never include secrets, tokens, notes, or PII):

```json
{
  "bookingId": "bk_…",
  "status": "CONFIRMED",
  "timeline": [
    { "at": "…", "event": "HOLD_CREATED", "detail": "Hold for 300 s (via Ask AI)" },
    { "at": "…", "event": "HUMAN_APPROVED", "detail": "Approved by signed-in buyer" },
    { "at": "…", "event": "COMMITTED" },
    { "at": "…", "event": "PAYPAL_ORDER_CREATED" },
    { "at": "…", "event": "CAPTURE_RESPONSE_LOST", "detail": "Injected by judge fault" },
    { "at": "…", "event": "WEBHOOK_VERIFIED", "detail": "PAYMENT.CAPTURE.COMPLETED" },
    { "at": "…", "event": "RECONCILED", "detail": "1 capture found, booking confirmed" }
  ],
  "intent": { "sha256Prefix": "9f3a…c21b", "algorithm": "ES256", "keyId": "…" },
  "confirmation": { "consumed": true, "consumedAt": "…" },
  "idempotency": { "commitKeyHashPrefix": "1b7e…" },
  "resourceClaim": { "blocking": true, "state": "CONFIRMED" },
  "paypal": {
    "environment": "sandbox",
    "orderIdMasked": "26B9…125W",
    "captureIdMasked": "91P4…790B",
    "captureStatus": "COMPLETED"
  },
  "webhook": {
    "eventType": "PAYMENT.CAPTURE.COMPLETED",
    "verification": "VERIFIED",
    "reconciliation": "PROCESSED"
  },
  "ledger": { "entries": 1, "balanced": true, "depositLiabilityMinor": "2000", "currency": "USD" },
  "counts": { "captures": 1, "bookingsForHold": 1, "journalEntriesForCapture": 1 }
}
```

Masking: show first 4 and last 4 characters of PayPal ids; hashes show 4…4 prefix/suffix. Put masking in one tested helper.

UI: a side drawer reachable from /judge recent bookings, /schedule event panel (judge only), and the approval page confirmed state (judge only). Timeline rendered as a vertical list with plain-English labels; a "Show technical fields" toggle reveals the rest.

Tests: proof for a confirmed booking has all sections; no key in the JSON named `token`, `secret`, `note`, `email`, `password`; masking helper tests; non-judge → 403; dev-tenant booking id → 404.

## Part C — Fault injection: "Drop the next capture response" (P1)

### Data

Migration: `judge_fault_flags` (tenant table, RLS):

```text
id           uuid pk
tenant_id    uuid not null CHECK (tenant_id = '01932b10-0000-7000-8000-000000000a01')
fault_type   text not null CHECK (fault_type IN ('DROP_NEXT_CAPTURE_RESPONSE'))
armed_by     uuid not null
armed_at     timestamptz not null default now()
expires_at   timestamptz not null      -- armed_at + 10 minutes
consumed_at  timestamptz
consumed_for_payment_intent uuid
```

At most one unconsumed, unexpired flag per tenant (partial unique index on `(tenant_id, fault_type) WHERE consumed_at IS NULL`).

### API

```text
POST   /v1/judge/faults          { "faultType": "DROP_NEXT_CAPTURE_RESPONSE" }   judge:fault_injection, Idempotency-Key
DELETE /v1/judge/faults/current  disarm
GET    /v1/judge/faults/current
```

### Adapter wrapper

`packages/integrations-paypal/src/fault-injecting-payment-port.ts` (or application layer if the port lives there):

```ts
class FaultInjectingPaymentPort implements PaymentPort {
  constructor(
    private inner: PaymentPort,
    private faults: JudgeFaultStore,
    private judgeTenantId: string,
  ) {}
  async captureOrder(args) {
    const result = await this.inner.captureOrder(args); // REAL sandbox capture happens
    if (args.tenantId === this.judgeTenantId) {
      const consumed = await this.faults.consumeIfArmed(
        args.tenantId,
        "DROP_NEXT_CAPTURE_RESPONSE",
        args.paymentIntentId,
      );
      if (consumed) {
        throw new PayPalUnknownOutcomeError("Injected: capture response dropped"); // use the existing error class
      }
    }
    return result;
  }
  // all other methods delegate unchanged
}
```

Match the real method names and argument shapes of `PaymentPort`; the code above is a shape, not exact names.

Rules:

- The wrapper is installed in the API composition root for all environments, but it can only ever affect the judge tenant (tenant check in code + DB CHECK on flags).
- `consumeIfArmed` is a single atomic UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING, inside the judge tenant transaction.
- The resulting state must follow the existing unknown-outcome path: payment `SENT_UNKNOWN`/booking `CAPTURE_UNCERTAIN`, claim stays blocking, no second capture is attempted blindly.
- Convergence: the verified webhook `PAYMENT.CAPTURE.COMPLETED` and/or the reconciliation processor (which queries the order by id) moves it to CONFIRMED with exactly one capture row and one balanced journal entry. If the reconciliation interval is long, add a judge-only "Reconcile now" button calling the existing reconciliation for that payment intent (Idempotency-Key).

### UI (on /judge)

Card "Lost payment response":

1. Text: "We'll make velvetAI lose PayPal's reply for your next deposit payment. PayPal still takes the payment. Watch velvetAI recover without charging twice."
2. Button "Arm for my next payment" → shows "Armed · expires in 9:58".
3. After the judge pays a booking, the approval page shows "Verifying payment" (CAPTURE_UNCERTAIN), then CONFIRMED when the webhook/reconciliation arrives.
4. The proof panel timeline shows CAPTURE_RESPONSE_LOST → WEBHOOK_VERIFIED → RECONCILED, and counts `captures: 1`, `journalEntriesForCapture: 1`.

### Tests

1. Armed flag + mocked inner capture success → service sees unknown outcome; booking CAPTURE_UNCERTAIN; claim blocking; flag consumed.
2. Then simulate verified webhook COMPLETED → CONFIRMED; exactly 1 capture row; 1 journal entry; balanced.
3. Alternative: reconciliation path instead of webhook → same final counts.
4. Both webhook and reconciliation arrive → still exactly 1 capture and 1 journal entry.
5. Flag in dev tenant cannot be inserted (CHECK violation); wrapper ignores non-judge tenants even if a flag somehow existed (unit test with a fake store returning armed).
6. Expired flag is not consumed.
7. Two concurrent captures with one armed flag → exactly one is affected.

### Hosted proof (required for P1 completion)

On Render with real PayPal Sandbox and the registered webhook:

1. Reset demo. Arm the fault. Book via Ask AI → approve → pay with sandbox buyer.
2. Observe Verifying → Confirmed. Open proof panel. Screenshot.
3. In the PayPal sandbox dashboard (business account activity), confirm exactly one payment for that order.

Evidence: `docs/evidence/fault-injection-render.md`.

## Definition of done

- [ ] /judge page with reset, guided path, recent bookings, MCP info.
- [ ] Proof endpoint + panel with masking and no-secret tests.
- [ ] Fault injection with DB-enforced judge scope, tests 1–7, hosted proof.
- [ ] Checklist items 5, 8, J.3 updated.

## Cut list

If late: drop "Recent bookings" (proof panel still reachable from schedule and approval page) and the localStorage checklist marks. Fault injection may become P2 only with user approval; it is one of the strongest demo moments.
