# Setup

## User installation

Download:

- Install the hosted PWA using Safari's Add to Home Screen on iOS or Chrome's Add to Home screen/Install on Android, as in the [README installation instructions](../../README.md#pwa-install-on-your-phone). There is no app-store binary.
- The service worker caches the shell only; API data and writes require the network. It preserves invite navigation without token-bearing cache keys. See [cache design](../architecture/design.md#component-10).
- Installed iOS/Android PWA flows must pass the same [CSRF proof](../architecture/security.md#api-security) as browser requests. No no-header fallback is implemented. Local engine checks do not certify physical installed PWAs; hosted install, login, JSON writes, raw uploads and bodyless logout/deletion still require verification after service-worker activation.

Initial configuration:

- Open the app against an empty database to bootstrap the owner coach, then use invitations for subsequent accounts. See [README first run](../../README.md#first-run-accounts-roles-invites) and [signup experience](experience.md#signup-and-account). Hosted verification remains [required and pending](../../README.md#verification-status).

Superuser access:

- The owner is the highest application role, with the additional coach-invite/roster and invitation capabilities in [foundation](../foundation.md#personas). Database-level administration is separate; use the [operations runbook](../devops/operations.md#admin-runbook).
- Ownership transfer is available in Settings; see [account management](experience.md#signup-and-account) for the picker and [foundation](../foundation.md#personas) for permissions.
