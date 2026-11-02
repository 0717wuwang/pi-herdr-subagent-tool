---
name: npm-publish
description: Publish an npm package. Use when bootstrapping a scoped package on npm, running npm publish with --access public, or verifying package contents before release.
---

# npm Publish

## Bootstrap

First publish of a new package. After this, steady-state uses CI trusted publishing.

```bash
npm login
npm whoami
npm publish --access public
npm view @scope/name
```

`--access public` is required for scoped packages (`@scope/name`). Without it, the package is private.

## Package contents

`package.json` `files` is a **whitelist**: only listed paths are packed. Safer than `.npmignore` blacklist.

Runtime essentials only — no development artifacts:

```json
{
  "files": [
    "pi-extension/",
    "maestro/",
    "plugins/",
    "skills/",
    "README.md",
    "LICENSE",
    "config.json.example"
  ]
}
```

**Exclude** these categories:
- Tests: `test/`, `__tests__/`, `*.test.*`
- Dev tools: `.vscode/`, `.github/`, `tools/`
- Documentation: `docs/` (access via GitHub), `AGENTS.md`, `CONTEXT.md`, `RELEASING.md`
- Examples: `examples/`
- Logs, journals, sessions, prototypes, generated evidence
- Local config: `config.json`, `.env`, `openspec/`
- Role resources: `agents/`, `skills/` outside host-owned, `pi-extension/subagents/plan-skill.md`
- Dead code: `pi-extension/subagents/workflow-worker.js`

## Pre-publish verification

```bash
npm pack --dry-run
```

Confirm the tarball contains only runtime essentials. Check for sensitive files (`.env`, credentials).

## Version management

Semantic versioning. `npm version` auto-updates `package.json` and creates a git tag.

```bash
npm version patch      # bug fix: 1.0.0 → 1.0.1
npm version minor      # feature:   1.0.0 → 1.1.0
npm version major      # breaking:  1.0.0 → 2.0.0
npm publish            # publishes
```

Skip the tag for CI-driven release:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v$(node -p "require('./package.json').version")"
git push origin main
```

Do not bump `package.json` for documentation or implementation-only changes. A version change on `main` triggers the release workflow.

## package.json essentials

```json
{
  "name": "@scope/package-name",
  "version": "1.0.0",
  "type": "module",
  "bin": { "command": "bin/cli.mjs" },
  "files": ["bin", "src", "templates"],
  "engines": { "node": ">=18" },
  "description": "One-line description",
  "keywords": ["keyword1", "keyword2"],
  "repository": { "type": "git", "url": "https://github.com/owner/repo" },
  "homepage": "https://github.com/owner/repo#readme",
  "license": "MIT",
  "author": "Author Name"
}
```

## CI trusted publishing

After bootstrap, configure GitHub Actions to publish with npm trusted publishing (OIDC) instead of a token:

1. npmjs.com → Access Tokens → **Trusted Publishing** → create a publisher for this repository and workflow
2. Allow `npm publish` (configurations created after Sep 03 2026 default to `npm stage publish` only)
3. `.github/workflows/publish.yml`: the publish job declares `id-token: write` and runs `npm publish --access public`

No `NPM_TOKEN` secret is needed. npm authenticates with the GitHub OIDC token.

## Pitfalls

1. **Missing build** — add `prepublishOnly` script
2. **Sensitive files** — always `npm pack --dry-run`
3. **Name taken** — add scope: `@yourname/tool-name`
4. **Version immutable** — bump and republish; never republish same version
5. **2FA in CI** — use trusted publishing (OIDC); no long-lived token
6. **Credentials committed** — never commit npm tokens, session artifacts, or local config
