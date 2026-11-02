# ADR-0017: Parent-session model as the last-resort fallback

- **Status:** Accepted; amends 0016
- **Date:** 2026-11-02

## Context

[ADR-0016](0016-config-owned-model-routing.md) made `config.jsonl` the only model
source and removed every other input, including the parent session's model. That
contract is still right for *routing*: no role frontmatter, tool argument,
registry catalog, or sibling file may choose a model.

It is too strict for *availability*. The host runs inside a parent Pi session that
already holds an authenticated `provider/model-id` and thinking level. A freshly
installed extension, a `/subagents-init` template whose `models` block is still
commented out, or a `config.jsonl` without a `models` section therefore blocked
every `subagent` call, even though the operator was clearly working on a usable
model. The only recovery was to write a model entry before the first launch.

## Decision

1. Model routing keeps the 0016 order: `models.agents.<role>`, then
   `models.default`, each an entry or an ordered candidate chain, validated
   against the registry before any Herdr resource exists.
2. When no configured slot resolves a usable entry, the launch falls back to the
   parent session's model and thinking level, captured at launch time as
   `provider/model-id` plus the parent's `thinkingLevel`.
3. The fallback is a last resort, never an override: a configured chain always
   wins, even when the parent model is also available. A configured chain whose
   candidates are all unusable still fails; it does not silently degrade to the
   parent.
4. The fallback is recorded explicitly in the launch snapshot
   (`parent.model`, `parent.thinking`) so dispatch and resume read the same
   source. Resume uses the recorded values, not a fresh read of the parent.
5. A launch still hard-fails before any side effect when there is neither a
   usable configured chain nor a parent model, and the error names the
   configuration path. `subagent_stop`, `subagent_cancel`, and
   `subagent_interrupt` remain model-free.
6. `model` and `thinking` passed to `subagent` stay inert. The fallback reads the
   session, not the call arguments, so 0016's silent-override rule is intact.
7. The registry stays a validator. Nothing enumerates or recommends models, and
   `/subagents-init` still writes only the commented template without an active
   `models` record.

## Consequences

- A fresh install can delegate immediately: the child inherits the model the
  operator is already paying for, instead of failing on an empty configuration.
- `config.jsonl` remains the only way to *choose* a model for a role; the parent
  model is only a default when the file says nothing.
- An operator who relies on the fallback sees the parent model in use, so a
  per-role override stays an explicit configuration change rather than a
  requirement.
- The old "no configuration means no launch" guarantee narrows to "no
  configuration and no parent model". Hosts driving the extension headlessly,
  where no parent model exists, still fail loudly rather than guessing.
- The acknowledgement still reports configured overrides of `model`/`thinking`;
  it does not claim the parent model was configured.
