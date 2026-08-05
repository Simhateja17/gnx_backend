# Razorpay recurring billing setup

Use the Razorpay **Test Mode** account for the first pass.

1. Apply `supabase/migrations/20260804000000_razorpay_recurring_subscriptions.sql`.
2. Create the six test Plans at the backend amounts. The repeatable helper is:

   ```sh
   npm run billing:provision-plans
   ```

   It prints the six `RAZORPAY_SUBSCRIPTION_PLAN_*_ID` values without writing
   them to the repository. Add them to the backend and worker environments.
   If the local key pair is not valid, use the interactive helper instead:

   ```sh
   npm run billing:setup-test-plans
   ```

   It asks for a matching Razorpay Test Mode Key ID and secret without saving
   either value, then creates or reuses the six Plans and prints the values.
   A `401 Authentication failed` result means the two Razorpay credentials do
   not belong to the same Test Mode key pair.
3. Keep currency `USD` and set `RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED=true`
   after international payments are enabled on the Razorpay account.
4. Configure this webhook URL:

   `https://api.gnxsales.com/webhooks/razorpay`

   Use the same secret as `RAZORPAY_WEBHOOK_SECRET`.
5. Select these events:

   - `subscription.authenticated`
   - `subscription.activated`
   - `subscription.charged`
   - `subscription.updated`
   - `subscription.pending`
   - `subscription.halted`
   - `subscription.cancelled`
   - `subscription.completed`

   Paused and resumed events are intentionally not selected because the app
   does not expose subscription pause controls.

Monthly subscriptions use 120 cycles. Annual subscriptions use 10 cycles.
Cancellation is scheduled at the end of the current paid cycle.
