# Hosted PayPal Sandbox End-to-End Evidence

- **Environment**: Hosted on Render (`https://<api-service>.onrender.com` / `https://<web-service>.onrender.com`)
- **PayPal Environment**: `sandbox`
- **Merchant Tenant**: `01932b10-0000-7000-8000-000000000001` (Synthetic Dev Tenant)
- **Buyer Identity**: `auth0|6af02be79968e1f8f05bcee2`

---

## 1. Golden Path Flow Steps Executed

1. **Service Discovery & Hold Preparation**:
   - Buyer signed into `https://<web-service>.onrender.com`.
   - Ask AI query: _"I'd like to book Executive Haircut & Beard Sculpt for tomorrow afternoon."_
   - Tools executed: `list_services.v1` → `find_available_slots.v1` → `quote_booking.v1` → `prepare_booking.v1`.
   - Hold created with 300s TTL; GiST exclusion claim persisted in `resource_claims`. Zero confirmation token disclosure in AI drawer.

2. **Buyer Approval via Dedicated Approval Surface**:
   - Buyer navigated to approval link `/approve?locator=loc_...`.
   - Buyer verified terms ($75.00 total, $20.00 deposit required).
   - Buyer approved: Generated one-time confirmation record.

3. **PayPal Sandbox Order Creation & Capture**:
   - PayPal JS SDK v6 initialized with sandbox credentials.
   - `createOrder` called `POST /v1/bookings/:id/commit` with `Idempotency-Key`.
   - Fastify API generated PayPal Order v2 with `intent=CAPTURE` and stable `PayPal-Request-Id`.
   - Buyer authenticated in PayPal Sandbox modal with test credentials and approved deposit payment.
   - Fastify API captured order: `purchase_units[0].payments.captures[0].status == COMPLETED`.
   - Booking transitioned to `CONFIRMED`.

4. **Webhook Processing & Final Ledger State**:
   - PayPal Sandbox dispatched `PAYMENT.CAPTURE.COMPLETED` webhook to:
     `https://<api-service>.onrender.com/v1/webhooks/paypal/primary`
   - API verified cryptographic signature against PayPal certificates (`VERIFIED`).
   - Webhook processor deduplicated event via PostgreSQL inbox and marked status `PROCESSED`.
   - Double-entry ledger verified balanced (`journal_entries` and `journal_lines` sum to zero).
