# Phase 03: End-to-End Validation and Documentation Sync

- [x] Execute and record a validation matrix covering: host typecheck, host targeted tests, agent-runner build, container image build, Claude backend smoke, and OpenCode backend smoke. Store exact commands and outcomes in `docs/SDK-COMPARISON.md` under a new "Stability Fix Validation" section. Success criteria: all required checks are green or explicitly marked with actionable blockers.
  - Completed 2026-02-14: added `Stability Fix Validation` section to `docs/SDK-COMPARISON.md` with exact commands and outcomes for all required checks.
  - Validation results: host typecheck ✅, host targeted tests ✅, agent-runner build ✅, Claude backend smoke ✅, OpenCode backend smoke ✅.
  - Actionable blocker recorded: container image build (`./container/build.sh`) failed with `container: command not found` (exit `127`), requiring Apple Container CLI availability on host.

- [ ] Update operational docs (`docs/TROUBLESHOOTING-OPENCODE.md`, `docs/OPENCODE-INTEGRATION.md`, and `README.md` if needed) to reflect the single OpenCode startup path and canonical model env behavior. Success criteria: docs match implemented behavior and remove contradictory startup/config guidance.

- [ ] Add a release note entry in `CHANGELOG.md` summarizing fixed blockers (build unblocked, OpenCode startup conflict removed, tests stabilized) and any residual known limitations. Success criteria: changelog contains a dated entry with concrete outcomes.

- Human follow-up checklist (non-automated):
- Confirm one real WhatsApp group conversation works end-to-end on Claude backend.
- Confirm one real WhatsApp group conversation works end-to-end on OpenCode backend.
- Confirm scheduled task execution still sends output to the expected group.
