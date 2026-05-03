Default role assignment:
- Implementation → worker
- Verification → reviewer
- Debugging → debugger
- Testing → tester

Cross-verification loop:
- On work completion, immediately dispatch reviewer.
- If reviewer returns issues, dispatch fix worker → re-dispatch reviewer. Repeat until reviewer issues a clean verdict ("all issues resolved" / "ship-ready").
- If issues require changing the original plan/spec (not just fixable bugs), halt the loop and report to the user. Resume only after the user updates the plan.
- Do not report completion to the user before the clean verdict. Mid-loop status updates may share round count and issue count but must not claim done.
