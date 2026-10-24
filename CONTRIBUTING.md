# Development

No third-party runtime dependencies. Keep credentials, device IDs, progress and outbox files outside the installed package.

Run `npm test` (Node.js 22+) and `bun test test/*.test.mjs` before submitting changes. The original Magpie host integration can be reproduced with `python3 test/host.integration.py /path/to/bun /path/to/magpie/internal/plugin/host.js` and again with `github:example/magpie-usage-reporter` as the final argument.

Changes to persisted state or request IDs must explain migration and duplicate-counting behavior. Keep the sandboxed page's permission list minimal; do not use direct edits to Magpie's settings or login files as a new plugin API.

For a bug report, include plugin/Magpie versions, OS and sanitized status counters. Do not post gateway keys, credentials.json, account details or raw conversation logs.
