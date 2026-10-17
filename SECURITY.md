# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository.
Don't open a public issue for a security problem.

Design notes:
- No secrets or client data are stored in this repository. CI fails if a client registry or a generated config is
  committed. Deploy workflows read the private registry and secrets only on pushes to `main` and manual runs, never on
  pull requests from forks.
- The usage collector's page has no login of its own — put Cloudflare Access in front of it (docs/SETUP.md, step 6).
- The Cloudflare analytics token is read-only (Account Analytics: Read).
