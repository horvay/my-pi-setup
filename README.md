# my pi setup

this is my fork of [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup).

## what i've added

- personal agent instructions in `AGENTS.md` (bun-by-default TypeScript, SvelteKit notes, numbered questions)
- custom subagents in `agents/`: planner, scout, worker, and reviewer
- reusable prompt templates in `prompts/` for scout/plan and implementation flows
- extra extensions for background processes, process cleanup, exit, undo, compact modes, Playwright MCP, opencode zen login, and subagent delegation
- Firecrawl tool wording trimmed down to reduce prompt overhead, plus small `yeet` updates for `master` branches
- Playwright MCP config and wrapper (`.mcp.json`, `bin/playwright-cli`)
- added skills: `grill-with-docs`, `impeccable`, `improve-codebase-architecture`, `prototype`, `to-prd`, and `zoom-out`
- bumped pi packages and default settings for my current setup

---

## Original Readme

my pi setup

_i don't actually recommend u use this setup. it's just a reference at what's possible_

![Preview](assets/preview.png)

## if u really want to use it

1. clone this repo to `~/.pi/agent`
2. install the packages in there (idk if this actually matters)
3. (optional) if u want the web search tools, need to get a firecrawl api key and put it in `.env`

## what u actually should do

1. install pi: https://pi.dev
2. open it, then run "/login" with codex. then pick gpt-5.5 with low reasoning (press tab to cycle reasoning levels)
3. try it, anytime u find urself wanting something make a new pi instance and ask it to make it for u. I'm serious try it, it just magically works
