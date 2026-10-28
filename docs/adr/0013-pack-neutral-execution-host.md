# ADR-0013: Ship a pack-neutral execution host

- **Status:** Accepted
- **Date:** 2026-10-05
- **Scope:** `0717wuwang/pi-herdr-agents`
- **Supersedes:** [ADR-0001](0001-btw-ephemeral-side-questions.md); the bundled-role
  provisions of [ADR-0003](0003-installable-role-packs.md); the shipped role and
  workflow mapping in [ADR-0002](0002-agent-workflow-skill-runtime-taxonomy.md)
  and the bundled-skill provision of [ADR-0009](0009-remove-workflow-subsystem.md)

## Decision

`pi-herdr-agents` is an execution host. It owns child execution, supervision,
sessions, persistence, worktrees, model routing, role parsing and discovery, and
parent delivery. It ships no agent roles and no planning or review workflows.
The only Pi skill it ships is `pi-herdr-agents`, a general operating guide to its
own control tools; methodology and workflow skills stay in separate packs.

- The seven formerly bundled roles move to separately installed role packs:
  `scout`, `planner`, `worker`, `reviewer`, `adversarial-reviewer`, and
  `visual-tester` to the optional general-purpose `pi-herdr-roles` pack, and
  `poteto` to `pi-herdr-pstack`. Neither pack has privileged discovery status.
- `/plan`, its plan prompt, and the top-level `orchestrate` skill with its
  supporting resources and evaluation corpus move to `pi-herdr-roles`.
- `/iterate`, `/btw`, and `/btw-close` are removed, not relocated, together with
  their exclusive session snapshot, surface, and launch code. Direct
  `subagent({ fork: true, interactive: true, ... })` launches, resume,
  persistent specialists, and `/worktree` handoff remain.
- Registered role packs are the entire package layer. Effective precedence stays
  project > global > package. An empty catalog is valid; bare launches need no
  role; a missing or invalid named role fails before Herdr creates resources.
- Existing valid `roles.bundled` booleans are accepted as deprecated no-ops. A
  parent session reports one warning per extension load and never rewrites the
  file. Malformed values and unknown `roles` keys remain errors.
- The bundled-role worktree warning table is removed. The host keeps only
  role-independent worktree guidance and does not infer write capability from
  a `tools` allowlist.
- Host guidance describes model-selection mechanics, not named pack workflows.
- `PI_SUBAGENT_ID` is documented as a child-context hint: set for fresh and
  resumed children, absent from `/worktree` handoffs, inherited by nested
  processes, and not a security boundary. No new parent/child protocol is added.

## Why

Bundled roles were privileged fallbacks that blocked same-named pack roles, and
the bundled workflows made one methodology the default for every installation.
Separate packs let users choose the generic roles, pstack, another pack, their
own definitions, or bare launches, and let packs release independently.

The existing v1 role-pack event already supports independently installed packs,
so no new contribution registry is needed. `/iterate` and `/btw` were unused in
production and duplicated generic fork and session behavior.

## Consequences

- This is a breaking product change. Users install the packs they want; nothing
  is installed or migrated automatically, and user role files are not edited.
- Older hosts that still bundle the roles, `/plan`, or `orchestrate` collide with
  the replacement packs. `roles.bundled: false` on an older host removes only the
  role layer. Replacement packs must not claim compatibility with those hosts.
- Lifecycle tests use test-only role fixtures instead of production roles.
- The release version, deprecation removal date, and published compatibility
  ranges are decided at release planning, not by this ADR.
