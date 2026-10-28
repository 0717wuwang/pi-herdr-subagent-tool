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

## CI NPM_TOKEN publish

After bootstrap, configure GitHub Actions with a repository secret:

1. npmjs.com → Access Tokens → Generate New Token → **Automation**
2. GitHub repo → Settings → Secrets and variables → Actions → New repository secret, name `NPM_TOKEN`
3. Workflow publish step: `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` and `npm publish --access public`

CI needs `npm token create` for NPM_TOKEN (automation token).

## Pitfalls

1. **Missing build** — add `prepublishOnly` script
2. **Sensitive files** — always `npm pack --dry-run`
3. **Name taken** — add scope: `@yourname/tool-name`
4. **Version immutable** — bump and republish; never republish same version
5. **2FA in CI** — use automation token
6. **Credentials committed** — never commit npm tokens, session artifacts, or local config
