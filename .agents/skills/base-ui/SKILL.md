---
name: base-ui
description: >-
  Implement and troubleshoot React interfaces with Base UI. Use when choosing a
  Base UI primitive, checking its current API, styling or animating it, composing
  custom components, building accessible forms, or diagnosing Base UI behavior.
---

# Base UI

Use the vendored Base UI documentation as the source of truth for `@base-ui/react`.

## Steps

1. Read [`references/index.md`](references/index.md) and select every page relevant to the requested component or handbook topic.
   - For a component, read its component page plus any handbook pages needed for styling, animation, composition, forms, or TypeScript.
   - For package setup or cross-cutting behavior, start with the matching overview or handbook page.
   - Completion criterion: every API, prop, state attribute, accessibility behavior, and styling pattern used in the answer or implementation is supported by the selected local pages.
2. Inspect the project's installed `@base-ui/react` version and existing component conventions, then apply the local documentation to the requested work.
   - Preserve project conventions when they are compatible with the documented API.
   - Surface a version mismatch when the vendored documentation describes an API unavailable in the installed package.
   - Completion criterion: the result uses documented Base UI primitives and matches the project's package version and surrounding style.
3. Validate changed code with the narrowest relevant typecheck, lint, test, or build command.
   - Completion criterion: validation passes, or the final response names the exact command and blocker.

## Refreshing the reference

Run the vendored updater from the repository root:

```bash
python .agents/skills/base-ui/scripts/update-docs.py
```

The standalone Python updater uses only the standard library. It downloads `https://base-ui.com/llms.txt`, recursively vendors every same-origin Markdown page it references, rewrites Markdown links to local relative paths, and removes stale pages from the previous mirror.
