# ADR-0021: Preserve known tabs when a newer tab kind is encountered

- Status: accepted
- Date: 2026-09-13

## Context

The version-1 state envelope is parsed as JSON before deserializing its typed state.
An unknown `TabKind` previously failed that conversion, causing the entire state to
be backed up as corrupt and replaced with an empty app. Adding one viewer kind could
therefore lose every workspace, split, and terminal cwd when an older build loaded
that file. This failure exists independently of any particular viewer feature.

## Decision

During disk loading only, recognize unknown string tags inside a tab's `kind` object.
Temporarily substitute a known terminal kind so the existing typed deserializer and
whole-app validation can check the remaining fields and original ID/reference structure.
No terminal is spawned during this operation. Remove the marked tabs after validation.
If a removed tab was active, select the first surviving tab in that pane, or leave a
valid empty pane when none survive. Preserve workspaces, panes, split ratios, and all
surviving tab fields under the existing restart sanitization rules.

Report each removal through `LoadOutcome::Restored.repairs`, including its kind and ID.
Reserve removed IDs when repairing `nextId`; a future tab's history key must not be
reused after downgrade. Missing/non-string kind tags, malformed common tab fields,
malformed known kinds, and unrelated structural corruption still take the explicit
corrupt-state backup path. The command/snapshot wire deserializers remain strict, and
the state envelope version remains 1.

## Rollout

Ship this compatibility repair in a release before introducing a new persisted tab kind.
A repair shipped alongside the new kind cannot change already-installed older binaries.
Only downgrades to a build containing this repair gain protection; older releases still
discard the whole state. Keep a separate copy of `state.json` before testing a downgrade
to an unprotected build. New tab implementations must update the recognized-kind list
and include a persistence round-trip test so their own tabs are not pruned.

## Verification

Persistence tests cover unknown active/inactive/only tabs, split workspaces, terminal
cwd preservation, removal diagnostics, ID reservation, malformed fields and kinds, and
preexisting ID/reference corruption. Repository gates exercise both Windows targets and
both frontends. No Windows downgrade session was run on the Linux development host.
