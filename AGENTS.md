# Agent Notes

The Interceptor is a Bun-managed TypeScript browser extension. Main extension source lives in `app/ts`, injected inpage-provider source lives in `app/inpage/ts`, tests live in `test`, build tooling lives in `build` and `scripts`, and extension pages/assets live under `app`.

## Required Validation

- After completing a user-requested task that changes code, tests, configuration, tooling, or repository instructions, run these commands separately and in this order before handing off:
  ```bash
  bun run test
  bun run setup-chrome
  bun run typecheck
  bun run lint
  ```
- Run that full validation suite after the whole task is complete, not after every intermediate edit.
- Before handing off to the user, those tools should report no errors and no test failures.
- If any of those tools report an error or test failure, fix the issue and rerun the required validation before handing off.
- For documentation-only or read-only tasks that cannot affect executable behavior, state which checks were skipped and why.

## Browser Checks

- For a real browser communication check, build the Chrome bundle with `bun run setup-chrome`, install Chromium once with `bun run install-chrome` on Debian/Ubuntu if needed, then run `bun run test:chrome-communication`.
- `bun run test:chrome-communication` launches Chrome through the repo CDP harness, waits for the MV3 content scripts to register, opens a local HTTP page, approves the real Interceptor access popup, and verifies the page reaches `access-granted`.
- If Chrome or Chromium is installed outside the standard paths, set `CHROME_BIN=/path/to/chrome` when running `bun run test:chrome-communication` or `bun run benchmark:popup-lifecycle`.

## Final Review Gate

For any task that changes code, tests, configuration, tooling, or repository instructions, after the required validation passes, the main agent must spawn the project-scoped `reviewer` custom agent defined in `.codex/agents/reviewer.toml` and wait for it to complete before responding to the user. Start the reviewer from a clear task summary instead of relying on inherited conversation context.

Give the reviewer a structured request summary that includes:

- A brief verbatim excerpt or exact summary of the original user request.
- Acceptance criteria derived from the request.
- Intentional non-goals or exclusions.
- Implementation summary.
- Changed files or areas.
- Validation commands and results, including concrete scope-based reasons for skipped checks.
- Known risks, tradeoffs, or areas needing close attention.

Send the reviewer a prompt with this shape:

```text
Use the project-scoped reviewer instructions from .codex/agents/reviewer.toml.

Original user request:
<brief verbatim excerpt or exact task summary>

Acceptance criteria:
- <requirement 1>
- <requirement 2>

Intentional non-goals / exclusions:
- <anything intentionally not implemented>

Implementation summary:
- <what changed and why>

Changed files / areas:
- <file or area list>

Validation:
- <command>: <passed/failed/skipped>
- <skip reason, if skipped>

Known risks or areas needing close attention:
- <risk, tradeoff, or "none known">

Review the current worktree diff against origin/main, including committed branch changes, staged changes, unstaged changes, and untracked files intended for the task. Review the stated acceptance criteria and whether the changed code is named clearly, readable, and easy to understand.
Do not modify files.
Return findings grouped by High, Medium, and Low.

Also include:
- Validation assessment
- Review limitations, or "None" if there are no limitations
- Worktree-diff quality score from 0 to 100 using the reviewer rubric
```

After the reviewer finishes, the main agent must read the full review and decide how to handle every finding:

- Fix all valid High, Medium, and Low issues before completing the task.
- If a finding is a non-issue, improve the code, tests, names, or local explanation so a future reviewer can understand why the concern does not apply without needing this conversation.
- If no High, Medium, or Low issues are found, the task may be marked complete.
- If any High, Medium, or Low issues are fixed, rerun the required checks and repeat the reviewer gate until no valid findings remain.

In the final response to the user, summarize the reviewer feedback received, report the score from each review pass, state which findings were addressed, note any findings considered non-issues and what readability or self-documenting improvements were made, and list the checks run after the final changes.

## Code Style

- Prefer targeted changes that keep the existing extension architecture intact unless a broader refactor is explicitly requested.
- Do not use TypeScript directive comments such as `// @ts-expect-error`, `// @ts-ignore`, or `// @ts-nocheck`; fix the type problem directly or restructure the code so the types are correct.
- Avoid type assertions and casting, especially double-cast patterns like `as unknown as SomeType`; prefer proper typing, generic constraints, narrower APIs, or explicit runtime validation when needed.
- Avoid using `null`; prefer `undefined` for absent values unless an external API or schema explicitly requires `null`.
- Avoid classes and class-based abstractions; prefer functional programming with plain data, pure functions, and composition.
- Use single quotes for TypeScript strings unless escaping makes double quotes clearer. Run `bun run lint:quotes` through `bun run lint` to enforce this.
- Keep error reporting explicit. Await unexpected-error reporting helpers when the surrounding code expects durable reporting before continuing.
- Do not leave comment-only `catch` blocks or console-error-only catches; handle, propagate, or report the error according to the local pattern.
- All dependency versions in `package.json` must be exact, with no `^` or `~` ranges.

## Generated Output

- Do not manually edit generated JavaScript under `app/js` or `app/inpage/js`. Change the corresponding TypeScript under `app/ts` or `app/inpage/ts`, then let the setup/build scripts regenerate output.
- `bun run setup-chrome` runs vendor setup, builds the inpage bundle, builds the Chrome extension output, and writes `app/manifest.json` from `app/manifestV3.json`.
- `bun run setup-firefox` builds the Firefox extension output and writes `app/manifest.json` from `app/manifestV2.json`.
- Treat build outputs from `build/` vendor and bundle scripts as generated unless the task explicitly asks to update generated artifacts.
- Do not commit regenerated output just because validation ran; review the diff and keep only intentional source/config/instruction changes.

## Testing Guidance

- Add or update focused tests when behavior changes, a bug is fixed, or a regression would otherwise be easy to reintroduce.
- For browser-extension workflow changes, prefer existing test harnesses in `test/tests` and the Chrome benchmark harness in `test/benchmarks` before adding new infrastructure.
- Use `bun run test:chrome-communication` when changes affect MV3 content-script registration, access approval popups, injected provider communication, or page-to-extension messaging in ways unit tests cannot cover.
