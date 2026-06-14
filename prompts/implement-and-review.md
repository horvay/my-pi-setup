---
description: General implements, checker verifies, general applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the `general` agent to implement: $@
2. Then, use the `checker` agent to check the implementation from the previous step. Include the original request "$@" and the previous output via `{previous}`.
3. Finally, use the `general` agent to apply any checker feedback from the previous step. If the checker passed with no findings, make no changes and report that verification passed.

Execute this as a chain, passing output between steps via `{previous}`.
