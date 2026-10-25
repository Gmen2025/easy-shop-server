# Social sign-in and optional two-factor authentication

All paths below start with `/api/v1`. Keep the existing selected-database header
(`x-database-name`) or `db` query parameter on every request. The exchange body
also accepts the existing `databaseName` selector. OAuth callbacks recover the
original database from a one-use server-side state record; they do not trust a
callback database parameter.

## Admin-controlled social sign-in

Google, Apple, and Facebook have independent switches stored in the
`social-login` SiteSetting document in `DEFAULT_DB_NAME`. Each defaults to **OFF**
when absent. Region selectors do not change these settings: a provider's switch
controls that provider across all regions and development/production clients
connected to the same backend. Independent deployments remain separate.

* `GET /settings/social-login` is public and returns
  `{ "success": true, "enabled": false, "providers": { "google": false, "apple": false, "facebook": false }, "updatedAt": null }`
  before configuration. `enabled` is a legacy aggregate meaning **any** provider
  is enabled; new clients use `providers`. Responses use `Cache-Control: no-store`.
* `PUT /settings/social-login` requires a valid admin bearer token and a partial
  provider map, for example `{ "providers": { "google": true } }`. Omitted
  providers are unchanged. Unknown providers, empty maps, arrays, nonboolean
  values, and combining `providers` with `enabled` return 400; non-admins return
  403. Per-field atomic updates avoid overwriting another provider's setting.
  A successful response contains the full provider map and timestamp.
  The existing unique SiteSetting key
  index supports the single-document upsert; no provider credentials are exposed.
* Mobile control: **Admin > Maintenance & Login > Social sign-in**.
  Website control: **Admin Dashboard > Social sign-in**. Deploy this backend
  before the updated clients. No restart/rebuild is required for later toggles.
* Existing shared `socialLoginEnabled` values are inherited individually until
  each provider is explicitly saved, preserving the current state without a
  manual data migration. Old admin `{ "enabled": true/false }` requests still
  explicitly set all three providers; upgrade admin clients to manage them
  separately. Old login clients may show all three buttons when any is enabled,
  but the backend rejects disabled providers. Deploy backend first; new clients
  reject a server response missing the provider map with an explicit settings error.
* Mobile login refreshes on focus/foreground and every 30 seconds while focused.
  Read failures hide the buttons and display an error; email login still works.
  The prior `EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN` build flag is no longer used.
* Backend checks occur at OAuth start, callback, exchange, and before issuing
  tokens or completing a social-origin 2FA challenge, using the provider saved
  in the server's state/handoff/challenge, never a client-supplied replacement.
  Pre-upgrade handoffs/challenges without a provider can finish only if all
  providers are enabled; otherwise restart sign-in. A disabled setting yields
  `social_login_disabled` (403 for JSON exchange; allowlisted redirects carry
  that error for browser flows). Settings database failures fail closed.
  Existing access tokens and password sign-in/2FA are not revoked or disabled.

These switches control availability, not provider configuration. Configure and
test each provider's credentials/callbacks before enabling it for real users.

## Deployment

Requires Node.js 18+ (built-in `fetch`) and MongoDB. No provider credentials are
bundled. Set these using deployment secrets, not client bundles:

* `secret`: existing strong JWT/HMAC signing secret.
* `AUTH_ENCRYPTION_KEY`: independent, random 32-byte AES key encoded as **64 hex
  characters**. Back it up securely. Rotation requires decrypting/re-encrypting
  existing authenticator secrets; simply replacing it breaks enrolled factors.
* `OAUTH_CALLBACK_BASE_URL`: public HTTPS base **including `/api/v1`**.
* `OAUTH_APP_REDIRECT_URIS`: exact comma-separated redirect allowlist, default
  `addugeneteshop://auth`. No queries, fragments, credentials or wildcards.
* Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` for a Web OAuth client.
* Apple: `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`,
  `APPLE_PRIVATE_KEY` (PKCS#8 ES256 key; escaped `\n` supported).
* Facebook: `FACEBOOK_CLIENT_ID` (app ID), `FACEBOOK_CLIENT_SECRET`;
  `FACEBOOK_GRAPH_VERSION` defaults to `v22.0`.
* Email: configure the existing mailer's SMTP or Resend credentials and
  `FROM_EMAIL` (see `.env.example`). A skipped/failed send is a **503 error**,
  never a successful enrollment. For login only, an opaque challenge with an
  explicit `deliveryError` warning remains usable with a backup code (no access
  token is issued). Management `send-code` returns the error; a backup code can
  still be submitted directly to disable/recovery without a challenge ID.

Register these exact HTTPS return URLs in each provider's console:

```
https://api.example.com/api/v1/users/auth/social/callback/google
https://api.example.com/api/v1/users/auth/social/callback/apple
https://api.example.com/api/v1/users/auth/social/callback/facebook
```

Enable Google email/profile/openid consent, Apple Sign in with Apple with the
Services ID's website domain and **form_post** return URL, and Facebook Login's
email/public_profile permissions and valid redirect URL. Production provider app
review/domain verification may be required. Real-provider smoke tests remain
blocked until credentials and registered callbacks are configured.

**Before deployment, build indexes in every allowed application database**:
the case-insensitive unique User email index (resolve existing duplicate emails
first), AuthIdentity's unique `(provider, subject)` index, and AuthRecord's unique
`key` and TTL `expiresAt` indexes. OAuth state additionally uses AuthRecord in
`DEFAULT_DB_NAME`. Ensure these indexes are ready before accepting traffic;
unique indexes are required for distributed abuse/cooldown enforcement and social
account race protection. Do not rely on production `autoIndex` if it is disabled.
Keep database/key backups protected; AuthRecord contains short-lived encrypted
enrollment secrets and provider-flow metadata. TTL cleanup is asynchronous, but
every operation independently enforces expiration.

## Browser flow

1. Generate a cryptographically random RFC 7636 verifier (43–128 unreserved
   characters), keep it only for this attempt, and compute its S256 base64url hash.
2. Open
   `GET /users/auth/social/start?provider=google|apple|facebook&redirectUri=addugeneteshop%3A%2F%2Fauth&codeChallenge=...&db=...`
   in a system browser. The backend redirects to the real provider authorization
   endpoint. An unconfigured provider redirects to the **validated** app URI with
   `?error=provider_unavailable`; invalid redirect URIs never redirect.
3. The backend exchanges the provider authorization code, verifies Google/Apple
   signatures, audience, issuer, expiry, nonce and verified email, or verifies
   Facebook tokens through Graph's app-bound debug_token and appsecret_proof.
   An existing provider subject signs in its original user. A new subject whose
   email matches **any existing account** is rejected with `account_conflict`.
   There is deliberately no automatic email-based account linking.
4. The backend redirects to the allowlisted app URI with `?code=<opaque-handoff>`
   or `?error=account_conflict|email_required|social_auth_failed`. **No access or
   provider tokens appear in app URLs.** State expires in ten minutes; the handoff
   expires in 60 seconds and is one-use, PKCE-bound and database-bound.
5. `POST /users/auth/social/exchange` with `{code, codeVerifier}` returns the
   ordinary full user login response or the 2FA challenge below.

Provider-created customer accounts can omit phone/password. Normal password
registration's required fields are unchanged. Existing driver/store-owner
password logins retain their checks, approval rules, JWT claims and responses.

## Login and factor verification

`POST /users/login`, `/users/driver-login`, `/users/store-owner-login` and the social
exchange return their original response when the factor is disabled. If enrolled:

```json
{
  "requiresTwoFactor": true,
  "challengeId": "<opaque>",
  "method": "authenticator",
  "expiresAt": "<ISO date>"
}
```

Email additionally includes masked `destination` and `resendAfterSeconds: 60`.
If mail delivery fails or is cooling down, email login additionally returns
`deliveryError: "<user-visible explanation>"`. Display this warning, offer backup
codes, and permit resend after cooldown; never claim an email was sent.
No provisional JWT is issued. `POST /users/auth/2fa/verify` with
`{challengeId, code, useBackupCode: false}` returns the **complete original login
response**, including its access token and original driver/store scope.
Use `useBackupCode: true` for recovery codes. Five wrong attempts exhaust a
five-minute challenge; consumption and recovery-code removal are atomic.
Authenticator codes use six digits, SHA-1, 30-second steps and ±1-step clock
tolerance; accepted time steps cannot be reused, including across login and
management. Synchronize server/device clocks.

`POST /users/auth/2fa/resend` with `{challengeId}` returns
`{expiresAt, resendAfterSeconds: 60}` for an active email challenge. It does **not**
extend expiration or reset attempts. It can also resend email enrollment using
the `setupId` as `challengeId`, or an email management challenge. Sending codes
shares a persisted per-user **60-second cooldown** across setup, resend and
management, plus per-user/IP abuse budgets. A 429 means wait before retrying.

All access JWT issuance, including role upgrades and existing-account store
registration, uses the same factor gate. Existing access sessions do not count
as fresh factor proof for factor disable or recovery regeneration.

## Security settings (all require a normal bearer access JWT)

* `GET /users/auth/security` →
  `{enabled, method: 'authenticator'|'email'|null, backupCodesRemaining, providers: string[]}`.
  Providers are the account's linked provider names, not a list of configured
  deployments. No trusted-device or SMS API is exposed.
* `POST /users/auth/2fa/setup` with `{method: 'authenticator'|'email'}` →
  `{setupId, expiresAt, secret, otpauthUri}` for authenticator, or
  `{setupId, expiresAt, destination, resendAfterSeconds: 60}` for email.
  Render `otpauthUri` using a QR renderer and offer `secret` for manual setup.
  Authenticator secrets are encrypted at rest, including pending setups.
  Rate-limited pending setups may be restarted; an **enabled** enrollment can
  never be overwritten. A code must be verified before anything is enabled.
* `POST /users/auth/2fa/enable` with `{setupId, code}` →
  `{enabled: true, method, backupCodes: string[]}`. Display these ten codes once.
  Only hashes are retained. Enabling consumes the enrollment authenticator
  timestep; wait for the next code before another authenticator operation.
* `POST /users/auth/2fa/send-code` with `{}` → email management
  `{challengeId, method, destination, expiresAt, resendAfterSeconds: 60}`.
  Calling again after cooldown issues a new challenge. Only enrolled email
  factors can use this endpoint.
* `POST /users/auth/2fa/disable` with
  `{code, useBackupCode, challengeId?}` → `{enabled: false}`.
* `POST /users/auth/2fa/recovery` with
  `{code, useBackupCode, challengeId?}` → `{backupCodes: string[]}`.
  Replaces every old recovery code and invalidates outstanding challenges.

Disable/recovery always require a **fresh current factor** or a valid single-use
backup code. For email use `send-code` first and include its `challengeId`; login
and setup challenges cannot authorize management. For authenticator provide the
current TOTP directly. Possession of an old JWT alone cannot bypass enrollment.

Errors use `{message, code}` with 400 (invalid/expired), 401 (unauthorized),
409 (already enrolled/account conflict), 429 (budget/cooldown), or 503 (missing
configuration/mail unavailable). Keep OTPs, manual secrets, recovery codes,
handoffs and challenge IDs out of client logs and persistent analytics.

## Validation

```
node --test tests/auth.test.js tests/company-profile.test.js tests/db-manager-sessions.test.js
```

Tests cover challenge expiry/attempts/atomic reuse, database isolation,
backup-code single use, token gating and scope retention, TOTP replay,
authenticated encryption/tampering, PKCE, OAuth state replay/type confusion,
email conflict rejection, cooldowns, protected routes, setup verification,
enrollment overwrite protection and fresh-factor management. In-memory atomic
model doubles do not replace deployment index checks or live provider/SMTP
smoke tests. No tests load `.env` or contact provider/mail services.
