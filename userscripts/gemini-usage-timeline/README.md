# Gemini Usage & Timeline

Independent Tampermonkey / ScriptCat userscript for **Gemini Web** (`gemini.google.com`) that adds:

1. **5-Hour & Weekly Usage Quota Indicator** flush inside the bottom-left Gemini sidebar footer row between your profile (`avatar / tier`) and the Settings gear (`5h` & `7d` progress bars + English Material 3 popover with reset countdowns).
2. **Codex-Style Right-Side Turn Timeline** along the right margin of the conversation pane with active-turn scroll tracking, left-opening hover prompt preview cards, turn bookmarking, and one-click smooth jump.

## Install

Open the raw `.user.js` URL in Tampermonkey or ScriptCat to install or update:

https://raw.githubusercontent.com/nonlog/my_scripts/master/gemini-usage-timeline.user.js

Updates check `gemini-usage-timeline.meta.js`.

## Features

- **Native Material 3 English UI**: Matches Gemini Web's typography (`Google Sans`), flat sidebar integration, rounded popover surfaces, and automatic light/dark theme switching (`.theme-host.light-theme` / `.theme-host.dark-theme`).
- **5-Hour & Weekly Quota (`GXU_FIVE_HOURLY` & `GXU_WEEKLY`)**:
  - Uses real rendered button & glyph geometry rather than custom-element host rects (`0×0` on `<bard-sidenav>`) so the indicator always sits cleanly between the profile avatar/name and Settings button without overlapping your avatar, and hides cleanly when the sidebar is collapsed.
  - Reads your signed-in account's exact quota pools via Gemini Web's same-origin `GEMINI_WEB_GRAPHQL/executeQuery` endpoint, including `/u/<index>` multi-account path & `X-Goog-AuthUser` routing.
  - Automatically discovers updated `UsagePageQuery` persisted query signatures from Gemini's `UsagePageLoading` bundle if Google rotates the query hash on frontend deploys.
  - Refreshes automatically right after Gemini finishes generating a reply, plus periodic background sync while the tab is visible.
  - Click the badge to view exact reset countdowns, toggle between **Used %** and **Left %**, manually refresh, or open `/usage`.
- **Right-Side Turn Timeline**:
  - Minimal right-aligned horizontal tick rail anchored cleanly along the right edge of the conversation scroller (automatically shifting left if a right-side Canvas/immersive panel opens).
  - Highlights the active turn in viewport as you scroll; hover any tick to preview the prompt's title and body snippet in a left-opening card, bookmark important turns (persisted per conversation in `localStorage`), or click to smoothly scroll to that turn.
- **Zero `innerHTML` / Trusted Types Safe**: Built entirely with DOM APIs (`createElement` / `createElementNS`), ensuring full compatibility with Google's strict `require-trusted-types-for 'script'` CSP.
