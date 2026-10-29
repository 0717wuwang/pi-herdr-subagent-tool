# Configuration

This page is the reference for the durable `config.jsonl` settings and the
config-owned model selection that drives every subagent. For a short
introduction, see [Choose models](../README.md#choose-models) in the README.

## Configuration file

The durable user configuration is `$PI_CODING_AGENT_DIR/herdr-agents/config.jsonl`,
defaulting to `~/.pi/agent/herdr-agents/config.jsonl`. It is not read from the
installed package root, so npm and git package upgrades do not overwrite it.
Create it by copying the installed package's `config.jsonl.example`, or run
`/subagents-init` to seed the skeleton. Neither source contains model
settings: the `models` section is yours to write.

The shipped `config.jsonl.example` is a complete, commented template: every
configuration section with its keys, defaults, and an example value. It can be
used directly as the runtime `config.jsonl` — comment lines (`#`) are ignored by
the parser. Copy it, keep the sections you need (replace the `models` template
with your real `provider/model-id`), and save the result as
`$PI_CODING_AGENT_DIR/herdr-agents/config.jsonl`.

Every configuration key, in template order, with its type, default, and
description:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `status.enabled` | boolean | `true` | Master switch; `false` disables every subagent feature. |
| `models.agents` | object | `{}` | Per-role model selection keyed by the `agent` name passed to `subagent`. See [Models](#models). |
| `persistent.maxAgents` | number | `3` | Cap on concurrently retained persistent specialists. |
| `supervision.forcePolling` | boolean | `false` | Force the legacy 1-second poll instead of file wake-ups. |
| `supervision.hangWarningMinutes` | number | `15` | Budget (minutes) before a no-progress hang warning; `0` disables it. |
| `panes.mode` | `"grouped"` / `"tab"` / `"split"` | `"grouped"` | Group children in one tab, one tab each, or split the parent pane. |
| `panes.direction` | `"right"` / `"down"` | `"right"` | Split direction for child panes. |
| `panes.maxPerTab` | number | `4` | Max active panes per owned tab before a new tab opens. |
| `sidebar.enabled` | boolean | `false` | Mark delegated children for the optional Herdr sidebar plugin. See [Sidebar markers](#sidebar-markers). |

`config.jsonl` must contain a `status` section; the template starts with one.
Every other section is optional, and an absent key keeps its default.

If `config.jsonl` is absent, status, role, pane, and persistent-specialist settings fall back to `config.jsonl.example`.
Model selection never reads the example or any other file: only a real
`config.jsonl` can supply a model, and without one every model-driven subagent
call fails before any Herdr resource is created.

`config.jsonl` is durable user state under the Pi agent directory and is loaded
when the extension starts. Run `/reload` after changing it. Package-root
`config.jsonl` files are ignored; move them manually or re-run `/subagents-init`.
## Models

`config.jsonl` is the only model source. The extension ships no model list, no
default provider, and no fallback to the session's parent model. It never reads
role frontmatter, `config.jsonl.example`, another package's files, or the model
registry to *choose* a model; the registry is used only to verify an exact
configured ID and its configured authentication.

`models.default` applies to every subagent that has no per-agent entry.
`models.agents` overrides it per role name, keyed by the name passed to
`subagent({ agent: ... })`. Each value is either one entry or an ordered array
of entries (a candidate chain tried in order):

```json
{
  "models": {
    "default": { "model": "your-provider/your-default-model", "thinking": "medium" },
    "agents": {
      "scout": { "model": "your-provider/your-fast-model" },
      "reviewer": [
        { "model": "your-provider/your-review-model", "thinking": "high" },
        { "model": "your-provider/your-backup-review-model" }
      ]
    }
  }
}
```

Rules:

- `model` must be an exact `provider/model-id` string that the active registry
  resolves and that has configured authentication. Aliases, prefixes, and
  partial names are configuration errors, not guesses.
- `thinking` is optional and accepts `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, or `max`. It is applied verbatim. When it is absent the extension
  does not send a thinking level at all: nothing is inferred, clamped, checked
  against model capabilities, or inherited from the parent.
- Because `config.jsonl` owns both fields, values passed to `subagent` as `model`
  or `thinking` do not take effect. The acknowledgement says so explicitly.
- A single entry is exactly equivalent to a one-element array.

The shipped `config.jsonl.example` is a commented template that documents the `models` structure; `/subagents-init` seeds a `config.jsonl` skeleton. Neither activates a model — add the `models` section yourself as shown above.

### Missing or unusable configuration fails before launch

`subagent`, `subagent_resume`, and `subagent_send` need a model, so they fail
before creating any Herdr workspace, tab, pane, worktree, or session file when:

- `config.jsonl` has no `models` section,
- neither `models.agents[<role>]` nor `models.default` has an entry for the
  role, or
- no candidate in the resolved chain is usable.

The error names the absolute configuration path, the field that is missing, and
the expected shape. `subagent_stop`, `subagent_cancel`, and
`subagent_interrupt` never need a model and keep working, so an unconfigured
session can still terminate a runaway child.

Parsing is strict: an unknown key under `models` (including the removed
`models.tasks`), a string value such as `"default": "provider/id"`, an unknown
thinking level, or invalid JSON is a configuration error that names the file and
field. There is no compatibility branch and no silent downgrade.

### Candidate chains and validation

Every candidate in the resolved chain is validated before launch: exact
registry hit plus configured authentication. Unusable candidates are skipped;
the first usable one runs. If the whole chain is unusable, the launch fails with
one line per candidate naming its own reason.

Ordinary non-persistent runs may retry later candidates after a launch failure
or after a running child settles with a provider/agent error; a completed child
result, including a negative task result, never switches models. Persistent
specialists do not advance after a running-child error. Worktree subagents take
exactly one candidate: a chain with more than one entry is rejected rather than
truncated.

Completion metadata reports the requested candidate, every attempted candidate,
the model actually used, and each raw model failure in attempt order. Pi owns
any automatic transient retrying inside a child; the extension does not infer
retry counts or permanence from error text, and a registry hit plus configured
authentication still does not prove the account may use that model. Provider
rejections are preserved verbatim with the model that produced them.

### Review independence

Cross-family independent review requires a reviewer from a different model family
than the author. For ordinary review, prefer a different authenticated model
family. When no other authenticated model family is available, ordinary review
may use a same-family reviewer in a fresh standalone session. Disclose that this
review is context-isolated, not cross-family independent. Cross-family
verification must not use this fallback. Configure reviewer models with that
boundary in mind.

Run `/reload` (or start a new session) after editing `models`.

## Persistent specialist limit

Set `persistent.maxAgents` to the maximum concurrently retained persistent specialists. It defaults to `3`; a persistent spawn at the cap is rejected before Herdr creates a pane or workspace, and no specialist is evicted.

## Deprecated `roles.bundled`

`roles.bundled` is deprecated and has no effect because this package ships no
roles. Existing `true` and `false` values are accepted so that current
configuration keeps loading; a parent session reports one warning per extension
load naming the file and asking you to remove the key. The extension never
rewrites the file. Other values remain configuration errors, as do unknown keys
under `roles`. Registered role packs are the entire package layer, and global and
project definitions keep their precedence over them.


## Sidebar markers

Set `sidebar.enabled` to `true` to mark delegated children for the optional
[Pi Herdr Agents Sidebar](../plugins/sidebar/README.md) Herdr plugin, whose Focus
action hides marked children from Herdr's Agents view. The setting defaults to
`false`.

```json
{
  "sidebar": {
    "enabled": true
  }
}
```

Add the key to your existing `config.jsonl`. The extension rejects a
`config.jsonl` without its `status` section, so copy `config.jsonl.example`
first if the file does not exist. Run `/reload` after changing the setting.
Children launched before the change stay unmarked.

Setting `sidebar.enabled` to `false` and running `/reload` retires every
existing marker and clears the markers of running children. A clear can fail to
reach Herdr, so a token still expires at most 15 seconds after the last write
Herdr accepted. Setting it back to `true` marks only later launches; a child
that was already running when you turned it off is never marked again.

With markers on, the parent reads each fresh, resumed, persistent, or managed
worktree child's pane with `pane.get` through `HERDR_SOCKET_PATH`. Once Herdr
reports the child's own session file as the pane's `agent_session`, within 15
seconds of launch, the parent reports the pane token `piha_delegated_v1` with
the value `live`, a 15-second time-to-live, and an increasing sequence number.
It renews the token on supervision checks, each time only after Herdr still
reports that session. Herdr learns each Pi's session from its own Pi
integration (`herdr integration install pi`), and drops it when that Pi exits
or is suspended back to the shell prompt, so without the integration nothing is
marked. The parent clears the token when the run finalizes or is suppressed, or
when Herdr no longer reports the child's session. A `/worktree` handoff session
is never marked.

Marker reads and writes never fail a launch or keep Pi running. Each has a
2-second timeout on an unreferenced socket. Before the marker is live, a failed
read is retried every 250 milliseconds until the 15-second discovery window
ends. Once it is live, failures are not retried, and three failed renewal
reads or writes in a row stop that child's marker. Markers work on Linux and macOS;
outside Herdr nothing is marked. After a parent crash, a marker can remain for
up to 15 seconds after the last write Herdr applied. A marker belongs to the
pane, so after the child exits or is suspended, an agent started by hand in
that pane can stay hidden by Focus until the next renewal clears the marker,
usually within 5 seconds. See
[what a marker proves](../plugins/sidebar/README.md#what-a-marker-proves) and
[reusing a delegated pane](../plugins/sidebar/README.md#reusing-a-delegated-pane).

## Supervision transport

On supported local filesystems, supervision uses file wake-ups plus one shared
4.8-second pane reconciliation. A wake-up only prompts fresh evidence
collection; it never establishes a result by itself. While any child's wait for
that check is parked, the coordinator's file watches stay referenced, so the
sidecar is still observed when the parent has no other event-loop work. The
reference is released when the wait settles, is aborted, or its child is
unregistered. With no parked wait, the watches stay unreferenced and do not
keep the process running. If the watcher
or shared pane inspection becomes unavailable, supervision quietly returns to
the legacy one-second polling cadence. No caller action is required.

Set `supervision.forcePolling` to `true` in the durable user `config.jsonl` to
disable wake-ups and use that legacy cadence deliberately. The setting is read
when the coordinator is created, so run `/reload` after changing it.
`subagents_list` reports the active transport mode (`wake+batch`,
`polling(forced)`, or `polling(fallback)`) and watcher count.

`supervision.hangWarningMinutes` defaults to `15`; set it to `0` to disable
no-progress advisories. For example, this keeps the default transport and sets
a 30-minute advisory budget:

```json
{
  "supervision": {
    "forcePolling": false,
    "hangWarningMinutes": 30
  }
}
```

While a child projects active or blocked, the parent compares durable session
JSONL and activity-snapshot updates against this budget. An advisory is warning-only, fires once per no-progress episode, and
never interrupts, kills, retries, or restarts a child. It identifies `blocked-tool` (an outstanding tool call may still complete),
`truncated-turn` (an observed `toolUse` stop with no tool call; its cause is unknown), or
`generic-no-progress` when neither condition is established, then
includes the session path and manual recovery options. Ordinary children can be
interrupted, cancelled with `subagent_cancel`, or, after termination, resumed or
newly spawned. Persistent
ordinary-pane specialists can be interrupted or stopped with `subagent_stop` and
replaced; they cannot be resumed. Managed-worktree children, including persistent
ones, retain their workspace and continue there only after the previous process
has exited; do not use `subagent_resume` or start a concurrent writer. Interactive children stay
quiet just as they do for stalled/recovered notices; their widget state still
updates. A later durable update clears the episode and sends the corresponding
recovered notice for non-interactive children.
`polling(fallback)` means at least one tracked child is using per-child polling;
other children can still use wake+batch.

A Linux manual benchmark on 2026-09-06 used isolated Herdr panes held pending,
20-second windows, and the extension's completion/supervision seams. At 10
children across three rotated rounds, wake+batch averaged 2.20 CLI launches/s
versus 14.20 for forced polling (84.5% fewer); mean evidence-to-resolver
latency was 3.2 ms versus 449.0 ms, and the largest reconciliation probe gap
was 4.82 s. The benchmark measures `/proc` CPU ticks for the supervisor and
isolated Herdr tree, not parent-model latency; raw samples are written to
`/tmp/issue29-bench/` by `test/bench/supervision-bench.mjs`.

## Pane placement

`panes.mode` defaults to `"grouped"` when omitted. Ordinary public `subagent` and `subagent_resume` launches, including bare forks, fill extension-owned `Agents`, `Agents 2`, etc. tabs in the target checkout's existing workspace. `panes.maxPerTab` is a positive safe integer, defaults to `4`, and counts all live panes in each owned tab, including user-added panes and retained shells. Overlapping launches in one parent respect this cap. It is independent of `persistent.maxAgents`.

Checkout matching uses Herdr's canonical `worktree.checkout_path` and includes descendant directories. Shell working directories do not establish workspace ownership. If no checkout matches (including non-Git directories), placement uses the caller's workspace; overflow never creates a workspace. A reviewer with `cwd` set to a managed checkout joins that workspace without creating another worktree. Resume placement uses the saved session's cwd.

Explicit `panes.mode: "tab"` preserves one new tab per ordinary child in the caller's workspace. Explicit `"split"` preserves splits of the stable parent pane. `panes.direction` is `"right"` (default) or `"down"` and applies to grouped and legacy splits. `maxPerTab` does not affect these legacy modes. Managed worktrees retain their separate workspaces.

Ownership is tracked by returned pane/tab/workspace IDs, never labels. Separate parent processes own separate groups; `/reload` preserves a parent's in-memory ownership, but a full restart does not adopt old tabs. Placement never moves existing panes or renames user tabs. Background launches preserve focus; Herdr may resize sibling panes when splitting or closing. User-added panes are never closed by automatic tab cleanup. An owned tab remains reusable while user panes remain, even after all child panes close.

Run `/reload` after changing role, model, or pane settings.

## Model resolution details

Resolution order is fixed: `models.agents[<role>]`, then `models.default`,
then a hard failure. Tool arguments, role frontmatter, the packaged example, and
the parent session's model are not inputs. See [Models](#models) for the
structure and the pre-launch validation contract.

A later candidate that launches after a parent `/reload`, `/new`, `/resume`, or
`/fork` uses the live parent session for its artifacts and lineage, as
completion delivery does. Its candidate chain and thinking level stay those of
the original call. The original parent directory and process directory remain
the bases for directory resolution. Role files are read again for each attempt,
so a changed role `cwd` can redirect a later candidate when the tool call did
not specify `cwd`. If no live parent context is available, that candidate fails
without launching.

A registry-listed model and configured authentication do not prove that the
active provider account can use that model. Providers may reject an
account/model combination only when the request is made. The completion
preserves each raw provider reason with its model and suggests checking account
access, spawning a new subagent with a usable configured model, or choosing an
appropriate configured candidate. `subagent_resume` does not select a model and
should be used only after the session's stored model is usable. Persistent
session sidecars fail closed: v1 does not resume or revive a stopped or crashed
specialist; retain its evidence and spawn a new specialist. The completion does
not claim a permanent failure or a retry count that Pi has not exposed. Reliable
structured permanence and retry counts require an upstream Pi/ExtensionAPI
diagnostics seam for final provider errors and retry outcomes.
