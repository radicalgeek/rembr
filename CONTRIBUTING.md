# Contributing

Thanks for helping improve Rembr.

## Development

Use Node.js 20 LTS or a later supported LTS release.

Run package-level checks before opening a pull request:

```sh
npm audit
npm test
npm run build
```

Some packages may have additional scripts documented in their local README.

## Pull Requests

Keep pull requests focused and include:

- What changed.
- Why it changed.
- How it was tested.
- Any security or compatibility notes.

## Public Repo Rules

Do not add private production manifests, internal runbooks, credential-bearing scripts, tenant/customer data, or private agent workflow files to the public repository.

All examples must use placeholder credentials.
