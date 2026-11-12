# Gemini Usage & Timeline

Independent Tampermonkey / ScriptCat userscript for **Gemini Web** (`gemini.google.com`) that adds:

1. **5-Hour & Weekly Usage Quota Indicator** directly beside the bottom-left Gemini sidebar profile avatar (`5h` & `周` dual progress bars + popover with reset countdowns).
2. **Codex Desktop-Style Turn Timeline** along the left margin of the conversation pane with active-turn scroll tracking, hover prompt preview cards, turn bookmarking, and one-click smooth jump.

## Install

Open the raw `.user.js` URL in Tampermonkey or ScriptCat to install:

https://raw.githubusercontent.com/nonlog/my_scripts/master/gemini-usage-timeline.user.js

Updates check `gemini-usage-timeline.meta.js`.

## Features

- **Native Material 3 Aesthetics**: Matches Gemini Web's typography (`Google Sans`), subtle borders, rounded surfaces, and automatic light/dark theme switching (`.theme-host.light-theme` / `.theme-host.dark-theme`).
- **5-Hour & Weekly Quota (`GXU_FIVE_HOURLY` & `GXU_WEEKLY`)**:
  - Reads your signed-in account's exact quota pools via Gemini Web's same-origin `GEMINI_WEB_GRAPHQL/executeQuery` endpoint, including `/u/<index>` multi-account path & `X-Goog-AuthUser` routing.
  - Automatically discovers updated `UsagePageQuery` persisted query signatures from Gemini's `UsagePageLoading` bundle if Google rotates the query hash on frontend deploys.
  - Refreshes automatically right after Gemini finishes generating a reply, plus periodic background sync while the tab is visible.
  - Click the badge next to your avatar to view exact reset countdowns, switch between **已用%** and **剩余%**, manually refresh, or open `/usage`.
- **Codex Desktop-Style Conversation Timeline**:
  - Minimal horizontal tick rail anchored cleanly in the left gutter beside `bard-sidenav`.
  - Highlights the active turn in viewport as you scroll; hover any tick to preview the prompt's title and body snippet, bookmark important turns (persisted per conversation in `localStorage`), or click to smoothly scroll to that turn.
- **Zero `innerHTML` / Trusted Types Safe**: Built entirely with DOM APIs (`createElement` / `createElementNS`), ensuring full compatibility with Google's strict `require-trusted-types-for 'script'` CSP.
