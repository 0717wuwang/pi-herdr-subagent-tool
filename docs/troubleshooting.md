# Troubleshooting

This page collects the checks for common problems. Each section links to the full reference.

## Troubleshooting completion delivery

If a child finishes but the parent returns an empty or unrelated response, first verify that the result reached the parent session:

```bash
jq -c 'select(.type == "custom_message" and .customType == "subagent_result")' "$PI_SESSION_FILE" | tail -1
```

If the entry exists, spawning and result extraction worked; investigate parent wake-up and model-facing delivery rather than the child process. Completion wake-ups must contain the bounded result directly—do not send a separate message that merely tells the parent to look at an adjacent custom message.

Git package refs are pinned. To move an installed development copy back to the current `main`, install that ref explicitly and reload the active Pi session:

```bash
pi install git:github.com/0717wuwang/pi-herdr-agents@main
# Then run /reload inside Pi.
```

Smoke-test delivery with an autonomous subagent instructed to return one exact marker. Success means the marker itself—not only a generic wake-up notice—automatically appears in the parent turn.

Subagent tabs, panes, and worktree workspaces are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. If a fresh or resumed launch fails, the extension closes the ordinary pane that it created and preserves the original launch error. It does not close a caller-supplied surface, and managed worktree workspaces remain retained on failure. Note: the `interactive` option controls parent status notifications, not terminal focus.

## A child is stalled or makes no progress

The widget shows `stalled` when pane inspection fails or the pane disappears without a completion record. Time alone never makes a run stalled. A no-progress advisory warns once per episode and never interrupts, kills, retries, or restarts a child. Interrupt the child with `subagent_interrupt`, end an ordinary run with `subagent_cancel`, or stop a persistent specialist with `subagent_stop`. See [In-progress status updates](tools.md#in-progress-status-updates) and [Supervision transport](configuration.md#supervision-transport).

## No model is configured
A launch that needs a model fails before any Herdr workspace, tab, pane, or
worktree exists. The message names the configuration path and the reason (no
`models` section, an empty one, or no `default` and no `agents` entry for that
role). Add the missing entry under `models.default` or `models.agents` in
`$PI_CODING_AGENT_DIR/herdr-agents/config.jsonl`, then run `/reload`. A
`/subagents-init` skeleton deliberately contains no `models` section, so a fresh
skeleton never launches a child on its own. `subagent_stop`,
`subagent_cancel`, and `subagent_interrupt` need no model and keep working, so an
unconfigured host can still stop a running child.

## A model fails
A registry hit and configured authentication do not prove that your provider
account can use the model. The completion keeps each raw provider reason with
its model. Check account access, then fix the `models` entry: an ordered array
tries later candidates in order. A candidate that fails the pre-launch check is
skipped with its reason listed; a chain with no usable candidate fails before
any resource is created. See [Models](configuration.md#models).
## Worktree removal is refused

Removal reports each blocker, such as dirty files, a live process, or an unknown inspection. Commit the work or pass `--preserve`, stop any process in the checkout, and start the parent Pi session at the source repository or an ancestor of it. See [Explicit worktree cleanup](tools.md#explicit-worktree-cleanup) and [cleanup and recovery](worktree-subagents.md#cleanup).

## Sidebar Focus hides nothing

Check that `sidebar.enabled` is `true`, that you ran `/reload` in the parent, and that you launched the child after the reload. Run `herdr pane get <child-pane-id>`: the pane must report the child's session file as `agent_session`. If it reports none, install Herdr's Pi integration with `herdr integration install pi` in the agent directory children use, then launch new children. Read the plugin log with `herdr plugin log list --plugin pi-herdr-agents.sidebar`. See the plugin's [troubleshooting](../plugins/sidebar/README.md#troubleshooting).
