TypeScript: default to bun unless project uses another manager; add packages via install commands, not package.json edits; run check/format/lint when done, or suggest adding them if absent; avoid explicit return types unless needed; use real type safety and treat `as any` as last resort; ask before dev/build.

Questions: number sets of questions so answers are easy to reference.

## Default Implementation Behavior

Do not stop and ask the user questions unless the user must take an action before implementation can continue, such as choosing between product directions the agent cannot infer, providing missing credentials, approving a required dependency/build/dev command, or resolving an external blocker. If a reasonable default can be inferred, proceed with that default and state it when reporting results.

Once implementation begins, continue until everything that needs to be done for the requested change is done: code, docs, smoke checks, tests or check/format/lint when appropriate, log inspection, and cleanup. Do not pause midway to ask whether to continue, whether to verify, or whether to do the obvious next implementation step.

After completing the implementation and first-pass verification, usually run a determinative review through a subagent whose job is to decide whether everything requested was actually completed and verified. If the subagent finds gaps, continue implementation and verification, then ask the subagent again. Repeat until the subagent says everything is done, or until a genuine user action is required to proceed.

## Development Strategy: Low-Definition Whole-System First

Treat **Low-Definition Whole-System First** as a strong default, not an absolute rule.

Use `CONTEXT.md` as the canonical glossary for strategy and domain language. Prefer its terms, update it when terminology changes, and avoid inventing synonyms for resolved concepts.

Design the intended product/system as a coherent whole, then build a low-definition but real end-to-end version before deepening individual layers, abstractions, or infrastructure. The first useful implementation should be broad enough to expose the intended product/system for review and low-definition enough that every included part remains real: a complete real system that can be seen, used, criticized, and redirected.

When choosing development sequence or scope, ignore estimated effort, cost, and time. Optimize for truthful whole-system feedback and pivotability, not cheapness.

Do not treat this as MVP-first development. MVP usually optimizes for minimum scope or effort; Low-Definition Whole-System First optimizes for a broad, real, architecturally stable whole that enables feedback and pivoting.

Do not reject full upfront product/system design merely because it resembles waterfall. Waterfall was costly because feedback arrived late; AI can compress the wait time for full plans and full product drafts, making larger coherent wholes reviewable sooner and enabling better architecture than piecemeal growth usually allows.

## Low-Definition Whole-System Functionality

**Whole-system functionality** means a user can exercise the core flow end-to-end and the implementation demonstrates the application's central claim or invariant in its simplest form.

**Low-definition** means broad but real: broad product/system breadth, minimal behavioral/detail definition, and every included part real enough to create truthful whole-system feedback. It does not mean narrow, cheap, fake, mocked, or merely scaffolded.

Low-definition may reduce edge-case coverage, advanced settings, alternate flows, performance optimization, rare error recovery, permissions/security hardening, data migration/history, and automated test/proof breadth. It must not reduce architecture quality, user-observable proof of the central flow, primary failure states, or UI/UX quality when the product has a UI. Use the whole-product view to choose better boundaries, names, data flow, and module shape up front.

Do not mock or fake the core domain behavior, central claim, proof target, or external boundaries by default. Prefer reducing definition/detail depth to keep the whole system real. Simplification is allowed; deception is not.

Do not ship generic placeholders such as lorem ipsum, TODO copy, fake product language, meaningless sample users, or dummy charts. Use real product language and representative test data. Temporary content is allowed only when it is truthful, named as temporary, and still supports evaluating the product/system.

## Upfront Architecture

Before implementation, produce a whole-system architecture sketch in the conversation covering core user flows, central invariant/proof target, major modules, domain names, data model, external boundaries, and dependency direction. The sketch should prevent piecemeal architecture without becoming a fake substitute for the running system.

Record an ADR for an architecture choice when it is significant and at least two are true: hard to reverse, surprising without context, trade-off-heavy.

Treat stability and reliability as king. Upfront architecture exists to reduce churn as features are added, avoid janky systems caused by deferred refactoring, and create proper module boundaries before implementation pressure accumulates.

Choose architecture for predictable extension, not just the first version: design for the explicitly requested feature plus the obvious next 3–5 features. Do not contort the architecture for speculative futures, but use the whole-product view to avoid boundaries that will obviously collapse.

Use stable module contracts up front when they clarify boundaries, dependency direction, and future extension. Do not create abstraction noise everywhere, but do not wait for duplicate implementations if the boundary is architecturally important.

Prefer architecture-preserving structure when it protects stability, reliability, or future extension. Simplicity means conceptual clarity, not minimum file count or shortest code.

Avoid architecture cargo-culting: use domain-shaped boundaries and explicit dependency direction. Borrow named patterns when useful, but do not impose Clean Architecture, hexagonal architecture, DDD, MVC, or any other named architecture as doctrine.

When product feedback changes the product/system direction, refactor the architecture immediately instead of forcing new behavior into stale boundaries. Re-architecture should be whole-system-aware and scoped to affected boundaries by default, but full re-architecture is acceptable when needed. Cost is not a reason to defer architectural correction. Code is cheap; stability, reliability, and correct architecture are expensive to lose.

Agents may rewrite aggressively to improve architecture, but must preserve verified behavior, smoke checks, and central invariants unless intentionally changing them.

## Rewrites, Compatibility, and Migrations

Assume the product is unreleased unless the user explicitly says it is released, has real users, or has compatibility obligations. For unreleased products, backwards compatibility is not a default constraint: APIs, data shapes, configs, UI flows, and internal contracts may be broken freely when doing so improves product direction, architecture, stability, or reliability. For released products, preserve external contracts and user data unless the user explicitly approves a breaking change or migration plan.

During rewrites, treat existing code as evidence of intent, not as a constraint. Mine it for domain concepts, flows, edge cases, and hidden requirements, but do not preserve its structure, APIs, data model, or implementation if a better whole-system architecture is available.

Never leave old behavior as an if/then fallback merely to preserve compatibility. Assume the new code path is correct unless the user explicitly requires legacy fallback behavior.

If old configs/state exist inside the development folder, convert them to the new shape as part of the rewrite. Do not write user-facing migration scripts unless the user says the product is released, has real user data, or explicitly requires migration support.

## Dependencies

Use libraries when they fit the intended architecture and improve reliability. Do not let a library dictate bad domain boundaries or add compatibility baggage. Since effort is not the optimization target, do not choose a dependency merely because it is faster.

Ask before adding major runtime dependencies or dependencies that shape architecture. For small dev/test utilities, proceed if clearly justified and mention it.

## Proof, Verification, and Smoke Checks

Every project must identify its central claim or invariant up front and choose the appropriate proof method: type model, automated tests, runtime checks, formal proof, user-observable validation, or a combination.

Automated tests can wait during the first low-definition whole, but user-observable proof cannot. Proving the real system works through tools such as Playwright MCP or Playwright Electron MCP should be part of implementation.

Agents should use automation tools to exercise the core flow and report concrete observations; capture screenshots/traces when available. Instructions-only verification is not enough unless tooling cannot run.

Maintain `smoke.md` as the product grows. It should be an agent-run procedural checklist for regression checking in the real user-observable system, with exact setup, launch commands, URLs, credentials/test data, steps, expected user-visible observations, expected `logs/last-run.log` evidence, and known limitations. Avoid vague manual instructions.

Update `smoke.md` after completing and verifying that a major feature works.

## Automated Tests

After a major feature is verified through the real user-observable flow, add automated tests for central invariants and regression-prone logic.

Automated tests should not default to small isolated unit tests. Prefer module/section-level integration tests that exercise behavior from the real entry point through the complete implementation path, such as receiving a tool call and executing the full handler. Tests should protect behavior, invariants, and module contracts rather than mirror tiny implementation layers.

Avoid mocks by default; use real dependencies where practical. If a dependency is impossible or unsafe to use in tests, use an explicit test adapter that preserves the real contract and makes the seam visible.

## Errors and Logging

Primary failure modes need designed, truthful user-facing states from the start. Exhaustive recovery and rare edge cases can be low-definition.

Always maintain `logs/last-run.log` for the last run of the app, replacing the whole file at the start of each run rather than appending across runs. All errors, exceptions, failed assertions, and relevant internal verification events should appear in that log.

Never consume an error silently: handle it, surface it, or at minimum dump it to the log with enough context to debug.

Logs may be used as verification evidence for internal behavior when appropriate. If the platform strongly requires another log location, document the exact path in `smoke.md`. Keep `logs/.gitkeep` committed, but ignore volatile `logs/*.log` content.

After any run or verification, inspect `logs/last-run.log` and report whether it contains errors, exceptions, or failed assertions. If errors are expected, explain why.

Use whatever log format fits the app, but include enough structure for agents to inspect it: timestamp, level, component/module, message, and relevant context. Prefer JSONL for complex apps.

Log major internal verification milestones such as app startup, config load, tool-call receipt/completion, core-flow completion, and smoke-step pass/fail so the log proves important internal behavior when UI/browser evidence cannot fully show it.

## UI/UX

For products with a UI, build final-grade UI/UX from the start. Do not treat the interface as disposable scaffolding or defer product feel. UI is cheap, known, and easy relative to the cost of getting product direction wrong, so the first broad low-definition whole should already be visually and interactionally judgeable.

Use the `impeccable` skill for frontend UI/UX work.

Establish product/design context before UI implementation: `PRODUCT.md` is required and `DESIGN.md` is strongly preferred.

Create an intentional product design direction from the start: layout, hierarchy, typography, color strategy, motion, empty/error states, and UX copy should be deliberate. Default component styling is not final-grade unless the product deliberately calls for that aesthetic.

Use live browser iteration for UI work: inspect the interface in browser, interact with it, verify responsive states, and polish obvious visual or interaction issues before reporting completion.

