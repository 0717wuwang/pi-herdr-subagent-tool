# 0016 — Configuration-owned model routing

- Status: Accepted
- Date: 2026-10-28

## Context

Model choice reached the launcher from four places at once: the tool argument,
role frontmatter, `models` in `config.jsonl`, and the parent session's model. A
live registry also fed a generated catalog into the tool description and drove
`/subagents-init` to draft `models.tasks` preferences for `task:<category>`
syntax. Each additional source made the effective model of a launch depend on
whatever happened to be loaded, so an operator could not tell from configuration
alone what a child would run on, and an unconfigured host silently borrowed the
parent model.

Iteration 3.4 targets a different contract: the operator declares models, and the
host only validates and applies them.

## Decision

1. The durable configuration file is the only model source. `models.default` and
   `models.agents.<role>` hold a model entry or an ordered array of entries; the
   entry is `{ "model": "provider/model-id", "thinking"?: "<level>" }`.
2. No fallback source exists. `RuntimeSource` has no parent variant, role
   frontmatter `model`/`thinking` no longer route, and string-form values,
   `models.tasks`, `models.tasksMeta`, and `task:<category>` are rejected rather
   than migrated, with the config path and the accepted shape in the error.
3. `thinking` is applied verbatim. The host never infers, clamps, resolves, or
   inherits a thinking level; an entry without `thinking` sends none.
4. Candidates are validated before any Herdr resource exists: exact registry hit
   plus configured authentication, in order, first usable candidate wins, and a
   fully unusable chain fails with every reason listed. There is no
   create-then-delete path.
5. No configuration means no launch. `subagent`, `subagent_resume`, and
   `subagent_send` hard-fail before side effects. `subagent_stop`,
   `subagent_cancel`, and `subagent_interrupt` are exempt because stopping a
   runaway child must not depend on model configuration.
6. The registry is a validator and lookup table only. It is never used to pick,
   recommend, guess, or enumerate models to the model, so the generated catalog
   injection and the `/subagents-init` drafting flow are removed, and
   `/subagents-init` writes a models-free skeleton.

## Consequences

- An operator reads one file to know what any child runs on, and the file the
  host reports in an error is the file that decides.
- Existing configurations fail loudly instead of degrading: old shapes name the
  path and the new shape.
- A fresh `/subagents-init` skeleton cannot launch a child until models are
  configured, which is intentional: a defaults-only host would recreate the
  implicit source this ADR removes.
- The tool still accepts `model` and `thinking` so existing callers and role
  packs keep parsing, but the configuration overrides them and the
  acknowledgement says so; silent override would hide a real mismatch.
- Candidate chains cover provider-side unavailability at launch, but the
  registry check cannot prove account-level access, so runtime failures still
  surface per-candidate reasons in the completion.
