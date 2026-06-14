# Globonexo Sales AI — Express API Contract

Base URL: `https://api.globonexo.com/api`

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
| DELETE | `/gmail/disconnect` | Remove Gmail connection | Poojitha |

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
| POST | `/billing/checkout` | Create Stripe Checkout session | Manasa |
| POST | `/billing/portal` | Create Stripe Customer Portal session | Manasa |
| POST | `/webhooks/stripe` | Stripe webhooks | Manasa |

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
