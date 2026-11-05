# SWARM

**A local-first, multi-agent copilot for one X (Twitter) account.** Chrome extension (Manifest V3), no backend, no data leaving your browser except to the LLM provider you choose.

![Tests](https://img.shields.io/badge/tests-1023%20passing-2ea44f?style=flat-square)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Local-first](https://img.shields.io/badge/data-local--first-111?style=flat-square)

> 🇫🇷 Full documentation is in French: [README.fr.md](./README.fr.md), [SPEC.md](./SPEC.md), [INSTALL.md](./INSTALL.md).

---

## In one sentence

Existing tools do **one-shot generation**: a post goes in, an AI reply comes out. SWARM is a **system**: a squad of agents that observe, qualify, write, critique, stage, **measure the real outcome and correct themselves**. The feedback loop is the product.

## The swarm

```
                    ┌─────────────────────────────────────────┐
                    │     ORCHESTRATOR (XState, persisted)    │
                    └─────────────────────────────────────────┘
                                       │
   ┌───────────┬───────────┬───────────┼───────────┬───────────┬───────────┐
   ▼           ▼           ▼           ▼           ▼           ▼           ▼
┌───────┐  ┌────────┐  ┌────────┐  ┌───────┐  ┌───────┐  ┌────────┐  ┌────────┐
│ SCOUT │→ │QUALIF. │→ │STRATEG.│→ │WRITER │→ │CRITIC │→ │PUBLISH.│→ │ANALYST │
│  DOM  │  │ triage │  │ angle  │  │3 var. │  │ VETO  │  │staging │  │D+1/D+7 │
│passive│  │   EV   │  │ memory │  │ voice │  │       │  │        │  │        │
└───────┘  └────────┘  └────────┘  └───────┘  └───────┘  └────────┘  └────────┘
                            ▲                                             │
                            └────────── winning patterns ─────────────────┘
                                       (the closed loop)
```

- **Scout** passively reads what you already see on X. It never opens a tab on its own.
- **Qualifier** triages posts in batches for a few cents (200 posts under 0.05 €).
- **Writer** drafts three variants in three angles, in your voice.
- **Critic** has a veto. If no variant passes the threshold, the opportunity is dropped. The threshold is enforced in code, not just asked of the model, because an LLM judge often says "it passes" while giving a score that doesn't.
- **Publisher** never clicks "Post". It pre-fills X's composer and you click. The auto-submit code does not exist, and a test proves it.
- **Analyst** measures results at D+1 and D+7, passively, and the winning patterns flow back into the prompts.

The **Voice Profile** separates form from content: your writing statistics (length, rhythm, punctuation, tics) come from all your posts, but your *examples* and rules only come from posts that pass the product's guardrails. Otherwise the profile would become the path through which forbidden content sneaks back in as "your style".

## What SWARM will not do

- Run several accounts in a coordinated way
- Send DMs automatically
- Publish without a human click
- Reply on health, grief, politics or crises
- Give financial advice, predict a price or promote an unsolicited ticker
- Scrape X outside your own browsing session
- Send anything to a server other than your LLM provider
- Collect telemetry without explicit consent

This list is a product commitment, not a footnote. See [docs/risks-and-limits.md](./docs/risks-and-limits.md).

## Engineering highlights

- **Zero outbound data, enforced by tests:** a test reads the sources and rejects `fetch`, `WebSocket`, `sendBeacon`, telemetry SDKs and any unexpected host outside `src/llm/`. Three more tests check that no key pattern ends up in `dist/` and that `.env` never reaches the bundle.
- **Bring your own LLM:** OpenRouter, Anthropic, or a local Ollama / LM Studio endpoint, in which case nothing leaves your machine.
- **Encrypted local vault** for the API key, unlocked by a passphrase that is stored nowhere, for one browser session of eight hours at most.
- **Hard daily budget:** the real cost of every call is read from the provider's response, never estimated, and the cap cuts.
- **Zod at every boundary** (LLM, DOM, storage, cross-context messages): malformed JSON from a model never breaks the app.
- **Deterministic by design:** no `Date.now()` or `Math.random()` in `src/`, an injectable clock and a seedable RNG, enforced by a lint rule.
- **Resilient to X's DOM changes:** selector cascades, anonymized DOM fragments kept as fixtures, and a `check:selectors` script that replays them.
- **Hermetic tests:** `npm test` makes no network call and needs no key. Paid live measurements (prompt cache, qualifier cost, critic calibration) are separate, named and gated behind `.env`.

## Quick start

```bash
npm install
npm run dev              # watch build + HMR
npm run check            # lint + typecheck + tests + selector check
npm run build            # dist/ ready to load in developer mode
npm run e2e              # local E2E: the extension in a real Chromium, no X account
```

Then open `chrome://extensions`, enable developer mode, click **Load unpacked** and pick `dist/`. The full setup (consent, key, niche pack, test call, corpus collection) is in [INSTALL.md](./INSTALL.md).

## Status

All nine phases are written and tested. Three definitions of done need the real world: an instrumented day without exceeding the caps, seven days of measurements, and a three-judge blind test. Autopilot does not exist in the binary.

## License

Copyright © 2026 Orlando R. All rights reserved. The source is published for review only, see [LICENSE](./LICENSE).
