# Agent Notes

- After completing a user-requested task that changes code, before handing off, run `bun test`, `bun run build`, `bun run typecheck`, and `bun run biome:check`.
- Run that full validation suite after the whole task is complete, not after every intermediate edit.
- Do not stop after local edits if any validation step fails; fix the failures or explain the blocker clearly.
- Prefer targeted changes that keep the existing architecture intact unless a broader refactor is explicitly requested.
- Do not use TypeScript directive comments such as `// @ts-expect-error`, `// @ts-ignore`, or `// @ts-nocheck`; fix the type problem directly or restructure the code so the types are correct.
- Avoid type assertions and casting, especially double-cast patterns like `as unknown as SomeType`; prefer proper typing, generic constraints, narrower APIs, or explicit runtime validation when needed.
- Avoid using `null`; prefer `undefined` for absent values unless an external API or schema explicitly requires `null`.
- Avoid classes and class-based abstractions; prefer functional programming with plain data, pure functions, and composition.
