const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const body = (schema) => ({ required: true, content: json(schema) });
const response = (description, schema) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const string = { type: 'string' };
const opaque = { type: 'string', minLength: 1, description: 'Opaque, short-lived, one-use identifier; never a bearer JWT. Do not log.' };
const method = { type: 'string', enum: ['authenticator', 'email'] };
const provider = { type: 'string', enum: ['google', 'apple', 'facebook'] };
const expiresAt = { type: 'string', format: 'date-time' };
const databaseParameters = [
  { $ref: '#/components/parameters/AuthDatabaseHeader' },
  { $ref: '#/components/parameters/AuthDatabaseQuery' },
];
const failures = {
  400: response('Invalid, expired, exhausted, already-used code, or security settings changed', ref('AuthError')),
  401: response('A valid access JWT is required for protected operations', ref('AuthError')),
  403: response('Email is not verified, requested account role is not approved, or social sign-in is disabled (social_login_disabled)', ref('AuthError')),
  409: response('Enrollment/account conflict', ref('AuthError')),
  429: response('Attempt budget or email cooldown exceeded', ref('AuthError')),
  500: response('Authentication failed unexpectedly', ref('AuthError')),
  503: response('Required provider, encryption, or email service is unavailable', ref('AuthError')),
};
const operation = (summary, description, schema, result, publicAccess = false) => ({
  tags: ['Authentication'], summary, description, parameters: databaseParameters,
  ...(publicAccess ? { security: [] } : {}),
  ...(schema ? { requestBody: body(schema) } : {}),
  responses: { 200: response('Successful response', result), ...failures },
});
const factorProof = object({
  code: { type: 'string', minLength: 1, description: 'Current six-digit code, or a saved backup code when useBackupCode is true.' },
  useBackupCode: { type: 'boolean', default: false },
  challengeId: { ...opaque, description: 'Required for email management codes, not for authenticator or backup codes. Must be from send-code, not login/setup.' },
}, ['code']);
const finalOrChallenge = { oneOf: [ref('LoginResponse'), ref('TwoFactorChallenge')] };
const loginResponses = {
  200: response('Access JWT and profile, or a second-factor challenge with NO token', finalOrChallenge),
  ...failures,
  400: {
    description: 'Invalid credentials, unverified email, invalid challenge, or legacy plain-text login error',
    content: { ...json(ref('AuthError')), 'text/plain': { schema: { type: 'string' } } },
  },
};
const paths = {
  '/api/v1/users/auth/social/start': {
    get: {
      tags: ['Authentication'], summary: 'Start browser-based Google, Apple, or Facebook login',
      description: 'Open in a system browser, not an API client. Persisted state binds the original database and app S256 PKCE challenge. The app redirect must exactly match OAUTH_APP_REDIRECT_URIS. A missing provider configuration redirects only to an already validated app URI with error=provider_unavailable. No automatic linking by matching email.',
      security: [], parameters: [
        ...databaseParameters,
        { in: 'query', name: 'provider', required: true, schema: provider },
        { in: 'query', name: 'redirectUri', required: true, schema: { type: 'string', example: 'addugeneteshop://auth' } },
        { in: 'query', name: 'codeChallenge', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
          description: 'Base64url SHA-256 of a random RFC 7636 verifier, without padding. Keep the verifier in the initiating client.' },
      ],
      responses: {
        302: { description: 'Continue to provider authorization', headers: { Location: { schema: string, description: 'Provider HTTPS authorization URL' } } },
        303: { description: 'Return social_login_disabled, provider_unavailable, rate_limited or social_auth_failed in app redirect query', headers: { Location: { schema: string } } },
        400: failures[400], 500: failures[500],
      },
    },
  },
  '/api/v1/users/auth/social/exchange': {
    post: operation('Exchange a PKCE-bound social login handoff',
      'Use the same selected database and verifier as start. Handoff expires after 60 seconds and can be consumed once. Provider/access tokens never appear in the app callback URL. The global social-login setting must still be enabled, including when completing a resulting 2FA challenge.',
      object({ code: opaque, codeVerifier: { type: 'string', minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
        databaseName: { type: 'string', description: 'Existing body alias for database selection.' } }, ['code', 'codeVerifier']), finalOrChallenge, true),
  },
  '/api/v1/users/auth/2fa/verify': {
    post: operation('Complete a login using a second factor or backup code',
      'No access JWT is issued until verification. Returns the original normal, driver, store-owner or role-upgrade response. Five wrong attempts exhaust the five-minute challenge; successful consumption and backup removal are atomic. Authenticator steps cannot be reused.',
      object({ challengeId: opaque, code: factorProof.properties.code,
        useBackupCode: factorProof.properties.useBackupCode }, ['challengeId', 'code']),
      { oneOf: [ref('LoginResponse'), ref('RoleUpgradeLoginResponse'), ref('StoreRegistrationLoginResponse')] }, true),
  },
  '/api/v1/users/auth/2fa/resend': {
    post: operation('Resend an email verification code',
      'Accepts an active email login challengeId, enrollment setupId as challengeId, or management challengeId. Requires 60 seconds between sends across a user. Does not reset attempts or extend expiration. This endpoint uses opaque identifiers, not bearer authentication.',
      object({ challengeId: opaque }, ['challengeId']),
      object({ expiresAt, resendAfterSeconds: { type: 'integer', example: 60 } }, ['expiresAt', 'resendAfterSeconds']), true),
  },
  '/api/v1/users/auth/security': {
    get: operation('Read the authenticated account security settings',
      'Providers are linked identities for this account, not configured server providers. No secret, backup hash, SMS or trusted-device bypass is exposed.',
      null, ref('AccountSecurity')),
  },
  '/api/v1/users/auth/2fa/setup': {
    post: operation('Start optional authenticator or verified-email enrollment',
      'An enabled factor cannot be overwritten. Email requires a verified address and successful mail delivery. Authenticator secrets are encrypted at rest. Render otpauthUri locally as a QR code and offer secret for manual entry; do not send it to a third-party QR service. Verify before enrollment becomes enabled.',
      object({ method }, ['method']), { oneOf: [ref('AuthenticatorSetup'), ref('EmailSetup')] }),
  },
  '/api/v1/users/auth/2fa/enable': {
    post: operation('Verify pending enrollment and enable two-factor authentication',
      'Requires an enrollment owned by the current user and its valid code. Displays ten single-use backup codes ONCE; only hashes are retained. The enrollment authenticator timestep is consumed, so wait for a new code before another factor operation.',
      object({ setupId: opaque, code: { type: 'string', pattern: '^[0-9]{6}$' } }, ['setupId', 'code']),
      object({ enabled: { type: 'boolean', enum: [true] }, method, backupCodes: ref('BackupCodes') }, ['enabled', 'method', 'backupCodes'])),
  },
  '/api/v1/users/auth/2fa/send-code': {
    post: operation('Send a fresh email code for factor management',
      'Requires an enrolled email factor and normal access JWT. Returns a management challenge for disable/recovery, not a login challenge. Mail failure is an explicit error; a saved backup code can still authorize management without a challenge.',
      null, ref('EmailManagementChallenge')),
  },
  '/api/v1/users/auth/2fa/disable': {
    post: operation('Disable two-factor authentication after fresh verification',
      'An existing access JWT alone is insufficient. Supply a current authenticator code, current email management code plus challengeId, or single-use backup code. Outstanding challenges are invalidated by the security version change.',
      factorProof, object({ enabled: { type: 'boolean', enum: [false] } }, ['enabled'])),
  },
  '/api/v1/users/auth/2fa/recovery': {
    post: operation('Replace all backup codes after fresh factor verification',
      'Requires the same fresh factor proof as disable. Replaces every previous backup code and invalidates outstanding challenges. Save the ten returned codes; they cannot be retrieved later.',
      factorProof, object({ backupCodes: ref('BackupCodes') }, ['backupCodes'])),
  },
};
const callbackResponses = {
  303: { description: 'Redirect to the validated app URI with a one-use code, or error=account_conflict|email_required|social_auth_failed. Never an access token.',
    headers: { Location: { schema: string } } },
  400: failures[400], 500: failures[500],
};
paths['/api/v1/users/auth/social/callback/{provider}'] = {
  get: {
    tags: ['Authentication'], summary: 'Receive a provider OAuth callback',
    description: 'Provider-owned return endpoint; do not invoke manually. Restores database from persisted state, not a callback database parameter. State expires in ten minutes. New provider subjects with an existing account email are rejected, not linked. Apple uses the POST form callback.',
    security: [], parameters: [
      { in: 'path', name: 'provider', required: true, schema: provider },
      { in: 'query', name: 'state', required: true, schema: opaque },
      { in: 'query', name: 'code', schema: string, description: 'Provider authorization code; absent on provider denial.' },
      { in: 'query', name: 'error', schema: string },
    ], responses: callbackResponses,
  },
};
paths['/api/v1/users/auth/social/callback/apple'] = {
  post: {
    tags: ['Authentication'], summary: 'Receive Apple Sign in form_post callback',
    description: 'Registered HTTPS Apple Services ID return URL. Database is recovered from state. Provider callback only; no bearer JWT. Never send an Apple private key or client secret from the mobile app.',
    security: [], requestBody: { required: true, content: {
      'application/x-www-form-urlencoded': { schema: object({ state: opaque, code: string, error: string,
        user: { type: 'string', description: 'Optional Apple first-authorization user JSON string.' } }, ['state']) },
    } }, responses: callbackResponses,
  },
};

const schemas = {
  AuthError: object({ message: string, code: string }, ['message']),
  TwoFactorChallenge: object({
    requiresTwoFactor: { type: 'boolean', enum: [true] }, challengeId: opaque, method, expiresAt,
    destination: { type: 'string', description: 'Masked email address; only for email factors.' },
    resendAfterSeconds: { type: 'integer', example: 60 },
    deliveryError: { type: 'string', description: 'Explicit send failure/cooldown warning. Offer backup-code verification; do not claim an email was sent.' },
  }, ['requiresTwoFactor', 'challengeId', 'method', 'expiresAt']),
  AccountSecurity: object({
    enabled: { type: 'boolean' }, method: { ...method, nullable: true, enum: ['authenticator', 'email', null] },
    backupCodesRemaining: { type: 'integer', minimum: 0 },
    providers: { type: 'array', items: provider },
  }, ['enabled', 'method', 'backupCodesRemaining', 'providers']),
  AuthenticatorSetup: object({
    setupId: opaque, expiresAt, secret: { type: 'string', description: 'Sensitive manual authenticator setup key. Never log.' },
    otpauthUri: { type: 'string', description: 'Sensitive otpauth provisioning URI for local QR rendering.' },
  }, ['setupId', 'expiresAt', 'secret', 'otpauthUri']),
  EmailSetup: object({ setupId: opaque, expiresAt, destination: string, resendAfterSeconds: { type: 'integer', example: 60 } },
    ['setupId', 'expiresAt', 'destination', 'resendAfterSeconds']),
  EmailManagementChallenge: object({ challengeId: opaque, method: { type: 'string', enum: ['email'] }, expiresAt,
    destination: string, resendAfterSeconds: { type: 'integer', example: 60 },
    deliveryError: { type: 'string', description: 'Delivery failure; use a backup code or retry after cooldown.' } },
  ['challengeId', 'method', 'expiresAt', 'destination', 'resendAfterSeconds']),
  BackupCodes: { type: 'array', minItems: 10, maxItems: 10, items: { type: 'string' },
    description: 'Sensitive, single-use backup codes shown only on generation. Store safely; never log.' },
  RoleUpgradeLoginResponse: object({
    user: ref('User'), token: string, success: { type: 'boolean' }, message: string,
    needsSetup: { type: 'boolean' }, driverId: string,
  }, ['user', 'token']),
  StoreRegistrationLoginResponse: object({
    success: { type: 'boolean' }, owner: object({
      id: string, fullName: string, email: { type: 'string', format: 'email' }, phone: string,
      storeId: string, storeName: string, approvalStatus: string,
    }), token: string,
  }, ['owner', 'token']),
};

module.exports = {
  paths, schemas, loginResponses,
  parameters: {
    AuthDatabaseHeader: { in: 'header', name: 'x-database-name', required: false, schema: string,
      description: 'Select the original allowed application database. Keep it unchanged throughout login and 2FA.' },
    AuthDatabaseQuery: { in: 'query', name: 'db', required: false, schema: string,
      description: 'Database selector for browser requests; use the same database at handoff exchange and verification.' },
  },
};
