---
description: Delegate read-only verification to the checker subagent
---
Use the subagent tool in single-agent mode:

- Agent: `checker`
- Task: Check the completed work for: $@

Pass along any relevant summary, changed files, expected behavior, risks, or commands already run. Ask the checker not to modify files, to inspect `git diff` when useful, to run safe targeted checks if relevant, and to return a verdict with findings and coverage gaps.
