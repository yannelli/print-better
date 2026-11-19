# Self-Hosting

Print Better runs as 1 Cloudflare Worker (API, web app, MCP server, install scripts). It uses D1 for data, R2 for documents and client downloads, and 1 Durable Object per workspace for live device connections.

## Requirements
- A Cloudflare account on **Workers Paid**. Password hashing (scrypt) needs more CPU time than the Free plan allows, and Cloudflare's email sending is paid-only.
- Node.js 22.12 or later, pnpm, `jq`, and `openssl`. Everything else (wrangler included) installs inside `server/`.
- To build clients: a Mac with Rust 1.92 or later (targets listed in [Releasing the Client](release.md#requirements)), `zig`, and `cargo-zigbuild`. The macOS client also needs Developer ID Application and Developer ID Installer certificates. Without them, leave macOS out with `--platforms "linux windows"`.

## Deploy
```sh
pnpm --dir server install
pnpm --dir server exec wrangler login
scripts/deploy.sh
```
`scripts/deploy.sh` does these steps:

1. Builds the app and deploys the Worker. D1 and R2 are created on the first deploy.
2. Applies the database migrations.
3. Creates the 3 secrets below if they're missing.
4. Prints a one-time setup link.

Open the setup link to create the owner account and the first workspace.

| Secret | What it protects | If lost |
|---|---|---|
| `SETUP_TOKEN` | Who may create the first account | Harmless after setup; delete it with `wrangler secret delete SETUP_TOKEN` |
| `APP_SECRET` | Encrypts stored secrets (SSO client secrets, Resend key, webhook secret) | Re-enter those secrets in Server admin |
| `AUTH_PEPPER` | Mixed into every password hash | Every password stops working; people sign in with a passkey or SSO, or an admin sends reset links |

Cloudflare won't show a secret again. When `scripts/deploy.sh` creates `APP_SECRET` or `AUTH_PEPPER`, it saves a copy to `~/.config/print-better/secrets.env` (readable only by you). Copy both to a password manager.

## Publish Client Downloads
The install commands and the web app's **Add a device** page download clients from your own R2 bucket. Publish a release once after deploying and again for each update:
```sh
scripts/release.sh --publish remote
```
See [Releasing the Client](release.md) for signing, notarization, and platform options.

Macs and Linux devices check your server for a new version about every 6 hours and install it on their own, unless someone turned off **Install updates automatically**. To update one sooner, select **Update now** on its page in the web app, re-run its install command (it keeps the pairing), or install the new macOS pkg.

## Custom Domain
Add one in the Cloudflare dashboard under **Workers & Pages > print-better > Settings > Domains & Routes**, or in `server/wrangler.jsonc`:
```jsonc
"routes": [{ "pattern": "print.example.com", "custom_domain": true }]
```
Pick the final domain **before** people register passkeys. Passkeys are tied to the hostname they were created on.

Paired devices keep using the address they paired with. After you switch, leave the `workers.dev` address enabled or re-pair the devices.

## Sign-In Options
Set these in **Server admin > Sign-in options**. Username and password sign-in and passkeys work out of the box. New accounts are invite-only unless you switch sign-up to open.

Once Google or OIDC is on, people can connect it to an existing account in **Your account > Sign-in and security > Connected accounts**.

Email verification links need outbound email (see [Email](#email)).

**Google**
1. In Google Cloud Console, go to **APIs & Services > Credentials** and create an OAuth client ID of type **Web application**.
2. Add the authorized redirect URI `https://<your-domain>/api/auth/sso/google/callback`.
3. Paste the client ID and secret into **Server admin > Sign-in options** and turn Google on.

**Any OpenID Connect provider** (Okta, Entra ID, Authentik, Keycloak, …)
1. Create a confidential web client with the redirect URI `https://<your-domain>/api/auth/sso/oidc/callback` and the scopes `openid email profile`.
2. In **Server admin > Sign-in options**, enter the issuer URL, the client ID and secret, and the button name people should see. Discovery must be at `<issuer>/.well-known/openid-configuration`.

## Email
Email is optional. Without it, invites and password resets are shared as links, and email to print is unavailable.

**Sending** (invites, password resets, printer alerts) is set in **Server admin > Email**. Pick one:
- **Resend:** Create an API key with sending access and verify your domain in Resend. Then enter the key and a From address on that domain.
- **Cloudflare Email Service** (public beta): Onboard your domain for Email Sending, add `"send_email": [{ "name": "EMAIL" }]` to `server/wrangler.jsonc`, and redeploy. Then choose Cloudflare and a From address on that domain.

**Email to print** is off everywhere by default. Turning it on takes 3 steps:
1. Set up receiving on the server. Pick one:
   - **Cloudflare Email Routing:** Enable Email Routing on your domain, then add a catch-all (or per-address) rule with the action **Send to a Worker** and the Worker `print-better`. In **Server admin > Email**, choose Cloudflare and enter the domain.
   - **Resend:** Add Resend's MX records for a receiving domain, then add a webhook for `email.received` that points to `https://<your-domain>/api/hooks/resend`. In **Server admin > Email**, enter the domain and the webhook signing secret (`whsec_…`).
2. In **Workspace settings > Email to print**, turn it on and choose who may send (workspace members, plus extra addresses or `@domain` entries).
3. On the printer's page, under **Sharing**, turn on **Print by email** and give the printer an email name. People send mail to that name at your domain, for example `office@print.example.com`.

The server drops mail that fails DMARC or comes from someone who isn't allowed.

Attachments (PDF, JPEG, PNG, text) print. If a message has no attachments, its body prints.

## AI Assistants (MCP)
The MCP server is at `https://<your-domain>/mcp`. The web app's **Connect AI** page (`/connect`) has step-by-step instructions.

Claude and ChatGPT connect with OAuth: add the URL as a custom connector and approve access in the browser.

Claude Code connects with OAuth too. Run `claude mcp add --transport http print-better https://<your-domain>/mcp`, then type `/mcp` in Claude Code, pick print-better, and sign in when the browser opens.

Other tools can send a personal token from **Your account > Apps and tokens** as a Bearer token.

## Backups
```sh
pnpm --dir server exec wrangler d1 export print-better --remote --output print-better.sql
pnpm --dir server exec wrangler d1 time-travel info print-better   # point-in-time restore, last 30 days
```
The database export plus your 2 secrets are everything worth backing up. R2 only holds:
- Print documents, deleted automatically after the workspace's **Keep documents for** setting
- Client downloads, which `scripts/release.sh` rebuilds

## Updating the Server
```sh
git pull && scripts/deploy.sh
```
Deploys have no downtime. New migrations apply right after the deploy, and connected devices reconnect on their own.
