We are finishing this working session.

Before ending, update our project documentation so that the next Claude Code session can continue without relying on this conversation history.

Every fact has exactly one home:

| Where | What |
| --- | --- |
| `docs/session-log.md` | Checkpoint of THIS session only (rewritten, not appended) |
| `docs/learning/current-phase.md` | Active phase: plan, decisions, step checklist |
| `docs/learning-roadmap.md` | Phase status table (one row per phase), current phase pointer |
| `docs/progress/<topic>.md` | Durable technical details: decisions with why, failure modes, verification |
| `docs/learning/phases.md` | Plans/status notes of inactive phases (incl. deferred items) |
| `docs/learning/implementation-status.md` | Implemented / gaps / missing; testing strategy |
| `docs/sessions/archive/YYYY-MM.md` | Previous checkpoints (append-only history) |

Follow these steps:

1. Review what we actually accomplished during this session.
2. Review the current Git changes and relevant files.
3. Archive the previous checkpoint: append the current contents of `docs/session-log.md` (below its header)
   to `docs/sessions/archive/YYYY-MM.md` (month of that checkpoint; create the file if missing), preceded
   by `---`. Skip sections already present verbatim in the archive (no duplicates).
   Never edit or reorder existing archive content. Verify the append before step 4.
4. Rewrite `docs/session-log.md` (keep the header, max ~60 lines) with this session only:
   - Date, branch, commits.
   - What was completed.
   - Important technical decisions (one line each; the reasoning goes to `docs/progress/<topic>.md`).
   - Verification: commands that actually ran + results (assistant vs owner); what was NOT verified.
   - Known issues and blockers, incl. still-open items carried over from the previous checkpoint.
   - Exact next steps.
5. Update `docs/learning/current-phase.md`: tick finished steps, update decisions, set the next task.
   Keep it ≤ ~120 lines.
6. Update `docs/learning-roadmap.md` only if a phase status or the current phase changed.
   When a phase is finished: move its section from `current-phase.md` back into `docs/learning/phases.md`
   (in phase order) and put the next phase into `current-phase.md`.
7. Put durable technical details into `docs/progress/<topic>.md`; update
   `docs/learning/implementation-status.md` when implemented capabilities or gaps changed.
8. If a fact in `CLAUDE.md` "Current state" became outdated, propose the exact update (don't edit silently).

Important rules:

- Do not mark unfinished work as completed.
- Do not invent test results.
- Do not duplicate existing documentation; link to the one home instead.
- Preserve the existing roadmap structure, phase order and statuses.
- Keep session notes concise and useful.
- Do not delete information: move it to its home or to the archive.
- Do not modify source code during this documentation update.

Finally, show me:

1. Files updated.
2. Summary of progress.
3. Remaining tasks.
4. Recommended starting point for the next session.

Do not finish until the documentation updates have been completed and verified.
