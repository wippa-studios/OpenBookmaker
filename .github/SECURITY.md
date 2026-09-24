# Security Policy

## Scope

OpenBookmaker is **paper-money software**: every balance is play money and
there is no real-money execution path, no payment integration and no
withdrawal. Reports about the accuracy of the demo economy, the fairness of the
bot's prices, or the quality of the seeded data are bug reports, not security
issues.

What *is* in scope:

- Anything that could let a user affect another user's balance, escrow or
  position.
- Authentication and session handling: forging a session, escalating to the
  admin role, bypassing the origin guard, using a revoked session.
- The money engine: a way to place a bet, settle a market, take a payout or a
  cash-out without the arithmetic the client would compute (a conservation
  failure is a security issue, not a cosmetic bug).
- Injection: SQL, stored XSS via admin-authored names, server-side request
  forgery in any outbound path.
- Exposure: anything that makes the service reachable or readable beyond the
  intended loopback-only, local, paper-money boundary.

Out of scope: the demo credentials in `README.md` (they are deliberately
committed for the demo and the server refuses any non-loopback bind), running
the project as a real-money bookmaker, and the bot's price randomness.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion.**

Report it privately via GitHub's security advisory form for this repository
(**Security → Report a vulnerability** at
<https://github.com/wippa-studios/OpenBookmaker/security/advisories/new>), or by
email to the maintainer. Include:

- what an attacker can do, and what they need in order to do it;
- the endpoint, module or file, with the exact request sequence if you have one;
- the balance/escrow before and after, in cents, for money issues;
- anything you tried that did not reproduce it.

You should get an acknowledgement within a few days. Because this is an
unscheduled hobby project, a full fix may take longer; you will be kept in the
loop and credited in the advisory unless you prefer otherwise.

## What the project already does

Stated so a report can be judged against a baseline rather than a guess:

- **Loopback only.** `HOST` is validated at boot; `0.0.0.0` and any routable
  address abort the launch. The test suite binds explicitly to `127.0.0.1`.
- **Origin guard before body parsing.** Mutating requests are rejected with
  `403` unless they carry no `Origin` (local tooling) or a loopback origin.
- **Sessions** are 32-byte random tokens in the database, delivered in an
  `HttpOnly; SameSite=Lax` cookie (a `Bearer` header is accepted for scripted
  clients). Expired sessions are rejected and purged at boot.
- **Passwords** are scrypt with a per-user random salt and compared with
  `timingSafeEqual`; a missing user still pays the scrypt cost so usernames
  cannot be enumerated by timing.
- **Password hashes are never returned** by any endpoint, and 5xx responses are
  replaced with a generic message so database errors and paths never reach a
  client.
- **All SQL is parameterised.** The only dynamic SQL fragments are fixed
  direction/suffix choices chosen by the server.
- **Output escaping** in the browser for every server-provided string,
  including admin-authored names.
- **Money invariants are enforced in the database** with `CHECK` constraints
  (non-negative integer cents, `matched <= stake`, price inside the ladder), not
  only in JavaScript.
- **Every money-moving operation is a single transaction** via `lib/tx.js`; a
  failure anywhere leaves no partial state.

## Deployment guidance

This project is not hardened for public deployment. If you expose it to anyone
else: change every seeded password, set a strong `SESSION_TTL_DAYS`-appropriate
cookie policy behind TLS, put authentication and rate limiting in front of it,
and remember that the money engine has no real-world regulatory compliance
attached to it.
