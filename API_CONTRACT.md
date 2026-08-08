# Globonexo Sales AI — Express API Contract

Base URL: `https://api.gnxsales.com/api`

All authenticated endpoints require the HTTP-only session cookie set by `/api/auth/login`.

---

## Auth

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| POST | `/auth/signup` | Create account + org | Manasa |
| POST | `/auth/login` | Login, set cookie | Manasa |
| POST | `/auth/logout` | Clear cookie | Manasa |
| POST | `/auth/google` | Google OAuth callback | Manasa |
| POST | `/auth/forgot-password` | Send reset email | Manasa |
| POST | `/auth/reset-password` | Reset password | Manasa |
| GET | `/auth/me` | Current user + org | Manasa |

---

## Onboarding

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| POST | `/onboarding` | Submit onboarding, create agent config | Poojitha |
| GET | `/onboarding` | Get onboarding progress | Poojitha |
| PUT | `/onboarding` | Update agent config | Poojitha |

---

## Gmail

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/gmail/auth-url` | Get Google OAuth URL | Poojitha |
| POST | `/gmail/callback` | OAuth callback, store tokens | Poojitha |
| GET | `/gmail/status` | Check Gmail connection | Poojitha |
| POST | `/gmail/activate` | Make the saved Gmail account the active email provider | Poojitha |
| DELETE | `/gmail/disconnect` | Remove Gmail connection | Poojitha |

## Custom email

| Method | Path | Purpose | Owner |
|---|---|---|---|
| GET | `/smtp/status` | List safe status for saved Gmail/SMTP email connections | Poojitha |
| POST | `/smtp/test` | Verify SMTP sending and IMAP reply access without saving credentials | Poojitha |
| POST | `/smtp/connect` | Verify and save an encrypted custom SMTP + IMAP connection | Poojitha |
| POST | `/smtp/activate` | Make the saved custom mailbox the active email provider | Poojitha |
| DELETE | `/smtp/disconnect` | Remove the custom mailbox connection | Poojitha |

---

## Campaigns

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/campaigns` | List campaigns | Poojitha |
| POST | `/campaigns` | Create campaign | Poojitha |
| GET | `/campaigns/:id` | Get campaign details | Poojitha |
| PUT | `/campaigns/:id` | Update campaign | Poojitha |
| POST | `/campaigns/:id/launch` | Launch campaign | Poojitha |
| POST | `/campaigns/:id/pause` | Pause campaign | Poojitha |
| DELETE | `/campaigns/:id` | Delete campaign | Poojitha |

---

## Leads

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/leads` | List leads | Poojitha |
| POST | `/leads` | Add manual lead | Poojitha |
| POST | `/leads/apollo-search` | Search Apollo | Poojitha |
| POST | `/leads/apollo-enrich` | Enrich selected leads | Poojitha |
| POST | `/leads/csv-upload` | Upload CSV | Poojitha |
| DELETE | `/leads/:id` | Delete lead | Poojitha |

---

## Emails

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| POST | `/emails/:replyId/approve` | Approve AI draft | Poojitha |
| POST | `/emails/:replyId/regenerate` | Regenerate AI draft | Manasa |
| POST | `/emails/send-test` | Send test email | Manasa |

---

## Inbox

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/inbox` | List threads/replies | Poojitha |
| GET | `/inbox/:id` | Get thread details | Poojitha |
| POST | `/inbox/:id/reply` | Send manual reply | Poojitha |

---

## Voice / Calls

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| POST | `/voice/agents` | Create/update Retell agent | Manasa |
| POST | `/voice/calls/:callId/retry` | Retry failed call | Manasa |
| POST | `/webhooks/retell` | Retell webhooks | Manasa |
| GET | `/calls` | List calls | Manasa |
| GET | `/calls/:id` | Get call details | Manasa |

---

## AI

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| POST | `/ai/generate-email` | Generate email for lead | Manasa |
| POST | `/ai/generate-reply` | Generate reply draft | Manasa |
| POST | `/ai/generate-voice-prompt` | Generate Retell prompt | Manasa |

---

## Billing

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| POST | `/billing/checkout` | Create a Razorpay recurring Subscription for a monthly or annual plan | Manasa |
| POST | `/billing/checkout/verify` | Verify the Razorpay subscription authorisation signature and activate the plan | Manasa |
| PATCH | `/billing/subscription` | Change plan immediately for upgrades or at cycle end for downgrades | Manasa |
| POST | `/billing/cancel` | Cancel future renewals at the end of the current paid period | Manasa |
| GET | `/billing/history` | List organization billing charges | Manasa |
| POST | `/webhooks/razorpay` | Razorpay subscription lifecycle webhooks | Manasa |

Billing deployment prerequisites:

- Enable Razorpay International Payments on the merchant account before setting `RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED=true`.
- Configure the Razorpay webhook URL as `https://api.gnxsales.com/webhooks/razorpay` with the same `RAZORPAY_WEBHOOK_SECRET` used by the backend.
- Select `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.updated`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, and `subscription.completed`. Paused/resumed events are intentionally not enabled.
- Create six Razorpay test Plans and set their IDs in the six `RAZORPAY_SUBSCRIPTION_PLAN_*_ID` environment variables before enabling checkout.
- Run the Razorpay billing migrations before enabling checkout, including `20260804000000_razorpay_recurring_subscriptions.sql`.
- Annual amount environment variables are full annual totals in the currency's smallest unit.
- Monthly subscriptions use 120 cycles and annual subscriptions use 10 cycles. Currency is USD when international payments are enabled.

---

## Dashboard & Analytics

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/dashboard` | KPIs + activity feed | Poojitha |
| GET | `/analytics/campaigns` | Campaign performance | Poojitha |
| GET | `/analytics/calls` | Voice performance | Poojitha |

---

## Settings

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/settings` | Get settings | Poojitha |
| PUT | `/settings` | Update settings | Poojitha |

---

## Admin

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/admin/organizations` | List orgs | Poojitha |
| POST | `/admin/organizations/:id/suspend` | Suspend org | Poojitha |
| POST | `/admin/organizations/:id/impersonate` | Get impersonation token | Poojitha |
| GET | `/admin/metrics` | Top-level metrics | Poojitha |

---

## Support

| Method | Route | Description | Owner |
|--------|-------|-------------|-------|
| GET | `/support/tickets` | List user tickets | Poojitha |
| POST | `/support/tickets` | Create ticket | Poojitha |
| GET | `/support/tickets/:id/messages` | List messages | Poojitha |
| POST | `/support/tickets/:id/messages` | Send message | Poojitha |
