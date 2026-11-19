# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x | Yes |
| Older | No |

## Reporting a Vulnerability

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repo's Security tab. Don't open public issues, discussions, or pull requests for security problems.

Include:
- The affected version or commit, and whether it is the server, the client, or both
- Steps to reproduce
- The security impact and how an attacker could use it
- A proof of concept or minimal example, if you have one (remove tokens, server addresses, printer names, and personal data)

I'll acknowledge reports within 48 hours and keep you updated until a fix ships. Fixes are released as patch versions and announced in GitHub releases.

## Scope

Print Better is self-hosted. Each deployment holds its owner's accounts, passkeys, API and device tokens, OAuth grants, SSO and email keys, and the documents people print. Each paired client can reach printers on its local network. Reports about these are in scope:

- Reading another workspace's printers, jobs, documents, devices, or members
- Printing, pairing a device, or changing settings without a valid session, token, or role
- Getting past token scopes (`read`, `write`, `print`), roles, single-use pairing codes, or revocation
- Flaws in sign-in: passwords, passkeys, Google or OIDC sign-in, recovery codes, email verification, or the OAuth 2.1 server for MCP
- Cross-site request forgery or script injection in the web app or the OAuth consent page
- Reaching the client's local status page and API (port 47631) or its loopback print server (port 8632) from another machine or from a web page
- Install scripts or downloads that skip the SHA-256 check, or a macOS install that runs code it did not sign
- Email to print accepting mail that fails DMARC or comes from a sender who is not allowed

How Print Better stores secrets and checks requests: [Security](README.md#security) in the README, and [Architecture](docs/architecture.md).
