## What this changes

<!-- One or two sentences. Link the issue it closes, if any. -->

Closes #

## Why

<!-- The problem being solved, not a restatement of the diff. -->

## Checklist

- [ ] `npm test` passes (unit + API integration)
- [ ] `npm run test:smoke` passes (live end-to-end)
- [ ] `npm run test:ui` passes, if the change touches the frontend
- [ ] `node --check` clean on every changed `.js`
- [ ] Money paths: hand-computed examples added to the test diff, one
      `Math.round` per computation, conservation of cents asserted
- [ ] New public API documented in `README.md`; new domain rules in
      `docs/EXCHANGE_RULES.md`
- [ ] No secrets, tokens or real-money paths introduced

## Risk

<!-- What could break, and how would we notice? For engine changes, name the
     invariant that protects users and the test that proves it. -->

## Screenshots

<!-- For UI changes: before/after. -->
