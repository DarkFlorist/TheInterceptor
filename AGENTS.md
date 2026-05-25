# Agent Notes

- After completing a user-requested task that changes code, before handing off, run `bun test`, `bun run setup-chrome`, `bun run typecheck`, and `bun run lint`.
- Run that full validation suite after the whole task is complete, not after every intermediate edit.
- Before handing off to the user, those tools should report no errors and no test failures.
- If any of those tools report an error or test failure, fix the issue before handing off to the user.
- For a real browser communication check, build the Chrome bundle with `bun run setup-chrome`, install Chromium once with `bun run install-chrome` on Debian/Ubuntu if needed, then run `bun run test:chrome-communication`. That launches Chrome through the repo CDP harness, waits for the MV3 content scripts to register, opens a local HTTP page, approves the real Interceptor access popup, and verifies the page reaches `access-granted`.
- If Chrome or Chromium is installed outside the standard paths, set `CHROME_BIN=/path/to/chrome` when running `bun run test:chrome-communication` or `bun run benchmark:popup-lifecycle`.
- Prefer targeted changes that keep the existing architecture intact unless a broader refactor is explicitly requested.
- Do not use TypeScript directive comments such as `// @ts-expect-error`, `// @ts-ignore`, or `// @ts-nocheck`; fix the type problem directly or restructure the code so the types are correct.
- Avoid type assertions and casting, especially double-cast patterns like `as unknown as SomeType`; prefer proper typing, generic constraints, narrower APIs, or explicit runtime validation when needed.
- Avoid using `null`; prefer `undefined` for absent values unless an external API or schema explicitly requires `null`.
- Avoid classes and class-based abstractions; prefer functional programming with plain data, pure functions, and composition.
