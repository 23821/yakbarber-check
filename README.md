# yakbarber

Find the outside APIs and AI models your code uses that are being retired, with the date, the company's own words and what to use instead.

```sh
npx yakbarber check
```

- **Free, read-only and local.** Nothing from your code leaves your computer. The only network request is the public [Retirement Radar](https://yakbarber.com/radar/) data. No account, no AI calls, and nothing from your project is run.
- **Secret files are never opened** (`.env`, keys, credentials). Templates such as `.env.example` are read for setting names.
- **What it reads:** your dependency files, imports, the web addresses in the code, the key names it reads, and every exact model and endpoint name on the radar.
- **Over 500 retirements from more than 170 companies** on the radar (OpenAI, Google, Anthropic, ElevenLabs, Cartesia, Deepgram, Twilio, Stripe and more), every date and quote from the company's own page.

## Usage

```sh
npx yakbarber check                      # the current folder
npx yakbarber check path/to/project      # another folder
npx yakbarber check --repo owner/repo    # a public GitHub repository (cloned read-only, deleted after)
npx yakbarber check --json               # machine-readable report
npx yakbarber check --out report.md      # also save the report
npx yakbarber skill                      # let your coding agent fix what the check finds (see below)
```

Needs Node.js 22 or newer, and `git` for `--repo`.

## The report

- **Broken now:** switched off and still used.
- **In the next 90 days**, and **later:** with the date, the company's own words and a link to its page.
- **Offered in a menu or list:** whoever picks it gets an error.
- **Newer options from companies you already use:** nothing is retiring, but the company now offers a newer model or version, with its own words and the price change.
- **Only in docs and tests:** these don't break, but readers still copy them.
- **What to use instead:** the company's own replacement and the price change, from its pricing page.
- **Outside APIs the radar doesn't cover yet.**

A company that only asks integrations to move by a date is never reported as "breaks".

## Fix it with your coding agent

```sh
npx yakbarber skill
```

Saves a skill to `.claude/skills/yakbarber/SKILL.md` and `.agents/skills/yakbarber/SKILL.md` (the only files it writes). Then type `/yakbarber` in Claude Code, or ask Codex or another agent that reads `.agents/skills` to use the yakbarber skill: it runs the check, moves each retiring call to the company's own replacement, updates the docs and tests that name it, runs your tests and checks again.

## Fix it automatically

The [YakBarber GitHub App](https://github.com/apps/yakbarber-ai) keeps checking your repositories and opens a tested pull request before a deadline. Free for developers.

Fixes already merged: [bolna-ai/bolna#1082](https://github.com/bolna-ai/bolna/pull/1082) (Cartesia `sonic-english` was switched off June 1).

## Source and data

The check's code is open source ([MIT](LICENSE)) at [github.com/23821/yakbarber-check](https://github.com/23821/yakbarber-check), and the radar's data is in [`radar.json`](radar.json) ([CC BY 4.0](LICENSE-DATA)). A wrong date, a missing retirement or a company we should watch: [open an issue](https://github.com/23821/yakbarber-check/issues).

[yakbarber.com](https://yakbarber.com)

## Run from source

```sh
npm install
node --experimental-strip-types src/bin.ts check path/to/project
npm run typecheck
npm run build        # dist/yakbarber.mjs, the file published on npm
```

`src/core/` is the check itself: `inventory.ts` (dependency files, imports, addresses and key names), `match.ts` (every name on the radar, line by line), `report.ts` (the report). The radar's data is fetched from https://yakbarber.com/radar/radar.json on each run; `radar.json` here is a copy, refreshed with each release.
