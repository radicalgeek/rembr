# Security Policy

## Supported Public Components

The public Rembr repository contains open-source client, protocol, example, and self-hosting components. Hosted SaaS infrastructure, private production manifests, internal runbooks, credentials, and tenant data are not part of the public security boundary.

## Reporting A Vulnerability

Please report suspected vulnerabilities privately by emailing security@rembr.ai.

Do not open public issues for vulnerabilities that could expose secrets, tenant data, production infrastructure, or exploit details.

Please include:

- Affected package or path.
- Impact and attack scenario.
- Reproduction steps or proof of concept.
- Any logs or screenshots with secrets and personal data redacted.

We aim to acknowledge valid reports within 5 business days.

## Secret Handling

Never commit real API keys, tokens, passwords, private keys, production URLs with credentials, tenant exports, or customer data.

Use environment variables and checked-in `.example` files for configuration. Public examples must use placeholder values only.
