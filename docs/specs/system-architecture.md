# System Architecture

## Decision and scope

Use an **NSH Mixed project with TypeScript as the primary application language**.
Use TSX for UI. Use Rust only for system capabilities that the available TS APIs
cannot provide, native libraries that require Rust bindings, or measured performance
problems. The Mixed template does not require a Rust business core or Rust UI.

This document records the selected architecture. It does not confirm that all
platform integrations work. The project has not yet passed the checks below.

The application is a desktop AI translator with these planned functions:

- Provider and model management, with multiple API protocols per provider.
- OpenAI Responses and Chat Completions, Anthropic Messages, and Gemini adapters.
- A main window and a shortcut-triggered translation window.
- Selected-text or clipboard input, screen capture, and OCR translation.
- Global input detection, including `Ctrl + Double C`.
- Text translation, text-to-speech (TTS), a dictionary, and a vocabulary book.
- External vocabulary integrations, such as Anki and Eudic.

The order of support for Windows, macOS, and Linux is not yet selected. System
integration must be verified on each supported platform. Mobile and web targets
are outside the current scope.

## Technology choices

| Area                  | Choice                                                          | Reason                                                               |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Application framework | NSH Mixed template                                              | TSX application with typed Rust extensions in one project.           |
| UI                    | TSX, NSH primitives, and app-owned controls built on `nsh/base` | Keep presentation in TSX and reuse framework behavior.               |
| State                 | NSH signals and computed values                                 | Use the framework's reactive model without a second state framework. |
| Model networking      | TS `fetch`, streams, and `AbortController`                      | Keep protocol adapters, streaming, and cancellation in TS.           |
| Desktop integration   | Existing `nsh` and `nsh/desktop` APIs first                     | Do not implement capabilities that NSH already exposes.              |
| Native extensions     | NSH typed Rust modules                                          | Export only the required operations and events.                      |
| Persistence           | TS-owned models and storage interfaces                          | Select the storage implementation from actual data needs.            |
| Toolchain             | mise, the `nsh` CLI, and Cargo                                  | Keep the application and native extensions in one toolchain.         |

TS runs on QuickJS in the desktop application. It is neither a full Node.js runtime
nor a browser. Verify each third-party package against NSH before adopting it.
Do not assume that DOM APIs, Node.js APIs, or native Node.js add-ons are available.

NSH components run once when created. Read changing signals and props in reactive
bindings. Do not apply React re-render or hook assumptions to NSH components.

## TS and Rust responsibilities

| Capability                                                    | Default owner                                    | Boundary                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Pages, settings, theme, and window content                    | TS/TSX                                           | Use NSH UI and desktop APIs.                                                 |
| Providers, models, and protocol configuration                 | TS                                               | Keep provider identity separate from supported protocols and models.         |
| API requests and translation streams                          | TS                                               | Normalize protocol output, errors, and cancellation.                         |
| Translation, dictionary, and vocabulary logic                 | TS                                               | Keep business rules independent of native storage and OS APIs.               |
| Remote OCR, remote TTS, and HTTP integrations                 | TS                                               | Use compatible network APIs.                                                 |
| Windows, tray, clipboard, and ordinary global shortcuts       | TS through NSH                                   | Verify existing APIs before adding Rust wrappers.                            |
| Selected-text detection and low-level keyboard or mouse hooks | Rust when needed                                 | Implement and verify each platform separately.                               |
| Screen capture and local OCR or system TTS                    | Existing TS API if suitable; otherwise Rust      | Keep capture or engine access separate from translation orchestration.       |
| Credentials                                                   | Existing secure API if available; otherwise Rust | Use a system credential store. Do not store API keys in plain-text settings. |

A typical remote OCR path is:

```text
Rust screen capture -> TS remote OCR -> TS translation -> TSX result
```

A local OCR engine can run in Rust without moving translation or provider logic
there. Persistence follows the same rule: TS owns the data model and business
operations, even when a native implementation stores the data.

## Application modules

Keep one repository, one application project, and one Rust crate initially.
The following layout defines responsibilities, not a list of empty directories
to create before features exist:

```text
App.tsx                      Application entry; calls mount once
nsh.json                     Metadata, theme, and capability declarations
theme.json                   Semantic theme tokens
tsconfig.json                NSH TypeScript configuration
Cargo.toml                   Native extension crate
app/
  shell.tsx                  Windows, the system tray, and application lifecycle
  store.ts                   State that must be shared across windows
features/
  providers/                 Provider and model management
  translation/               Translation workflow, state, and UI
  vocabulary/                Vocabulary workflow and UI
  settings/                  Application settings
services/
  protocols/                 Model API protocol adapters
  integrations/              OCR, TTS, and external vocabulary integrations
platform/
  desktop.ts                 Access to existing NSH desktop APIs
  native.ts                  Access to the application's Rust exports
components/                  Styled controls composed from nsh/base
assets/
  logo@2x.png                Imported images
  Inter.ttf                  Imported fonts
locales/                     Translations, rust-i18n's files: t("hello") (I18n)
src/
  lib.rs                     Native module registration
  selection.rs               Selected-text access
  input.rs                   Low-level input detection
  capture.rs                 Screen capture
```

Dependency rules:

- `app/` composes features and owns application-wide lifecycle work.
- Features own their local state and use services and platform interfaces.
- Keep only state that multiple windows need in the shared store. Keep mutable
  signals private and expose read functions and business operations.
- Protocol adapters do not depend on UI, windows, or native input hooks. They
  produce a common translation stream for the feature to consume.
- `components/` does not depend on features. Pages use shared controls rather than repeat
  base-component styling.
- `platform/native.ts` is the application boundary for Rust imports. It does not
  duplicate the generated Rust API types.

Use the semantic color roles in [the design system](../ui/DESIGNE.md) when defining
`theme.json`. Keep raw theme colors out of feature and component styles.

## Multi-window model

Mount one application root. Create the translation window with NSH's `Window`
component or `Window.open`, rather than a second independently embedded app.

Windows created this way belong to the same application tree and can read the
same signals and context. Do not introduce IPC, a local HTTP server, or WebSockets
only to share state between the main window and the translation window.

```text
Application root
├── Main window
└── Translation window
    └── Shared provider configuration and translation services
```

Do not confuse these windows with independently embedded app surfaces, which have
separate engines and module state.

## System tray and app icon

The shell installs the tray once, for the app's lifetime. A primary press brings
the main window back, and the menu holds one item, `Exit`, which uses NSH's native
`quit` role so it follows the platform's own quit path. The tray owns no state and
shows no app data, so it stays with the window lifecycle in `app/shell.tsx` rather
than in a feature.

`nsh.json` `icon` names a square PNG, not an SVG: NSH reads it with its image
decoder, embeds it in the packaged executable and writes `nsh/icon.ico` beside the
bundle, which is what the window, the taskbar, and Explorer draw. Keep the white
tile (`assets/logos/icon.png`): the mark is black, so a transparent icon disappears
on a dark taskbar. The tray's glyph is a separate one-colour SVG
(`assets/logos/icon128.svg`), which NSH paints through its alpha in the taskbar's
or menu bar's text colour.

Select `popup` or `panel` after checking focus and closing behavior. A popup closes
on blur by default. A panel does not activate the application by default. An
`overlay` defaults to no focus and pointer pass-through, so it is not the default
for an editable translation window.

Application-level listeners belong to the application lifecycle, not to the
translation window. Hiding a window must not dispose the listeners needed to open
it again. Window-specific work must stop when its owner is disposed.

## TS and Rust contract

Use NSH's native module exports, including `#[native_module]` and `#[module]`.
Export functions and events; Rust UI components are not required.

- Use asynchronous operations for capture and other work that can take time.
  NSH exposes exported Rust async functions as Promises to TS.
- Report native input through callbacks. A subscription must provide a way to stop
  listening. Use NSH's supported callback and subscription lifecycle mechanisms.
- Use generated declarations in `.nsh/types` as the native API type source. Do not
  maintain a second hand-written copy of the contract.
- Keep system hooks and blocking work off the engine thread. Return results through
  runtime-supported mechanisms. Use main-thread scheduling when an OS API requires it.
- Keep permissions, unavailable capabilities, and operation failures distinguishable
  in the application contract.
- Rust reports facts, such as a copy gesture or captured text. TS decides whether
  to translate, which model to call, and how to show the result.

Do not add a generic string-command and JSON bridge when typed exports are enough.
Do not create a separate native service process without a concrete requirement.

## Data and permissions

Use existing NSH storage or file APIs when they meet the data requirements. A
specific database, local OCR engine, and TTS backend are not selected by this
architecture. Add a native database implementation only when the required queries,
transactions, or library support justify it.

Declare the required NSH capabilities for network, files, clipboard, windows, and
other framework services. Account for user-configured provider endpoints and local
integrations when selecting network grants. NSH declarations do not replace OS
permission prompts. The application's own Rust code runs with process permissions,
so native exports must validate their inputs and permission requirements too.

Selected-text access is not guaranteed in every application. Report permission or
read failures explicitly. Do not treat unrelated clipboard content as successfully
captured selected text.

## Required verification

Complete these checks before treating the architecture as proven:

1. Run a TSX entry with the application's Rust crate. Call an exported async
   function and receive a native event. Confirm that stopping the subscription
   removes the listener, including after a TS hot update.
2. Open both windows and confirm shared state. Hide the main window, invoke the
   translation shortcut, and verify focus, placement, and closing behavior.
3. Test real selected-text access, `Ctrl + Double C`, screen capture, and permission
   failures on the first supported OS. Preserve ordinary copy behavior.
4. Test a real model response stream and request cancellation in QuickJS. Verify
   third-party SDK compatibility before using an SDK in place of protocol adapters.
5. Check both light and dark appearances. Record which target platforms were tested
   and which remain unverified.
6. Check the tray on every supported platform. On Windows with NSH 0.5.1 the icon
   shows in a TSX-only run but not in this project's mixed build, in the development
   host and in the packaged runner alike; a minimal app and a minimal `nsh.json`
   reproduce it, so the generated mixed host is what to check after an NSH update.

Use `nsh check` and `nsh test` for TS application checks, and `cargo test` for native
extension tests when those parts exist. Headless tests do not prove global hooks,
screen capture, system permissions, or desktop window behavior; verify those on the
actual target OS.

## References

- [NSH documentation index](../llms.txt)
- [Rust and TSX interoperability](https://nsh.dev/docs/rust.md)
- [Desktop windows and system APIs](https://nsh.dev/modules/nsh-desktop.md)
- [Networking and streams](https://nsh.dev/docs/networking.md)
- [Standard modules and runtime compatibility](https://nsh.dev/modules/standard-modules.md)
- [Sandbox and capabilities](https://nsh.dev/docs/sandbox-and-capabilities.md)
- [Application coding guide](https://nsh.dev/docs/coding-guides.md)
