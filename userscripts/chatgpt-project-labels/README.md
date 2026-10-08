# ChatGPT Project Labels

Independent ScriptCat userscript for showing a project's name after each project conversation title in the ChatGPT **Recents** sidebar.

## Install

Open the raw file with ScriptCat and confirm the install:

https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-project-labels.user.js

The metadata update endpoint is `chatgpt-project-labels.meta.js`. This script has a different `@name` from **ChatGPT Recent Messages**, so ScriptCat manages their updates and enable/disable state separately.

## Behavior

- For a Recents link like `/g/g-p-<project-id>/c/<conversation-id>`, show a small, muted project-name suffix beside the title.
- Read project names from the actual sidebar's `data-app-action-sidebar-project-id` / `data-app-action-sidebar-project-label` attributes, with an in-tab cache if the project row is temporarily unmounted.
- When a Recents link contains only `/c/<id>`, use a project-specific link for **the same conversation ID** if one is also present in the sidebar. Otherwise leave it unlabelled instead of guessing.
- Use a CSS `::after` label generated from a link attribute. No extra elements are injected into React-owned chat title markup.
- Keep the project suffix visible alongside long conversation titles by reserving space for the suffix and truncating overflow.
- Observe only relevant sidebar changes, so new, re-rendered or re-ordered Recents rows get labels automatically.
- Project labels are visual only. The server-side conversation title, project membership, and links are not modified.

**No dependency on ChatGPT Recent Messages:** this script does not compress messages, intercept network requests, modify history, or load Turbo features. Both scripts can be installed together, or either can be enabled alone.

## Limitations

ChatGPT's frontend DOM is not a public API and can change. A conversation whose only visible link is `/c/<id>` cannot be safely assigned to a project without other explicit project membership evidence. The script intentionally does not guess a project from the conversation title. The current implementation uses project links/labels already rendered by ChatGPT, with no additional network calls.

## Development and release

Keep the unique userscript `@name` / `@namespace` identity unchanged. Update the full `.user.js` first, then the matching `.meta.js` **last**, after the full source and documentation are available to users. Run source checks through GitHub Actions.
