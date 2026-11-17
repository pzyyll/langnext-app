# Provider Channels

## Goal and scope

Make channel creation provider-first. A user selects a provider preset, configures
the channel in the right pane, and manages its models before saving.

A preset defines API compatibility, default connection values, and provider-specific
request rules. It does not require an official service address. A compatible proxy
can replace the official Base URL without changing the preset or model identity.

This specification covers:

- Provider selection and the new-channel draft.
- Channel connection settings and the default API type.
- Per-model API overrides, manual entries, and model discovery.
- Local saving, cancellation, and error behavior.

This is a **breaking configuration update**. Do not require preservation of old
configurations, backward-compatible reads, or storage migration. The implementation
can use a new storage format. Migration and legacy-data preservation are not part
of the acceptance criteria.

The following are outside scope:

- New translation or inference features.
- A DeepSeek-specific request-parameter editor.
- Per-protocol or per-model Base URLs and API keys.
- Persistent drafts or persistent retry queues.
- Additional provider presets beyond the five below.

## Concepts and presets

### Four API protocols

There are exactly four API protocols:

1. OpenAI Chat Completions.
2. OpenAI Responses.
3. Anthropic Messages.
4. Gemini API.

DeepSeek is a provider preset, not a fifth protocol. Its request rules can add
provider-specific parameters to a compatible protocol. Keep these rules separate
from protocol identity. This specification does not add controls for those parameters.

### Provider presets

| Preset | Allowed API protocols | Initial default API | Preset Base URL |
| --- | --- | --- | --- |
| OpenAI | Chat Completions, Responses | Responses | `https://api.openai.com/v1` |
| Google Gemini | Gemini API | Gemini API | `https://generativelanguage.googleapis.com` |
| Anthropic | Messages | Messages | `https://api.anthropic.com` |
| DeepSeek | Chat Completions, Responses, Messages | Chat Completions | `https://api.deepseek.com` |
| Custom | All four protocols | Chat Completions | None |

These lists constrain the channel default and all per-model API selectors.
Changing the URL does not expand or reduce the list. A user who needs a different
protocol set can create a Custom channel.

A preset does not guarantee that every model or proxy supports every listed
protocol. The server can reject a request at run time. Such a rejection does not
make the local configuration invalid.

### Logical data requirements

Keep these concepts separate. This table does not prescribe storage field names.

| Object | Required distinction |
| --- | --- |
| Channel | Stable channel ID, selected provider preset, editable display name, default API, one Base URL, channel credential, and enabled state |
| Model | Owning channel ID, model ID, optional API override, and the existing model settings |
| Discovery metadata | Where or when a model was discovered; never its effective API or identity |

The owning channel ID is not the provider preset ID. Multiple channels can use the
same preset, with different names, URLs, keys, and model lists.

## Channel creation

### Provider picker

1. Both the channel rail's add action and the empty-state add action open the same
   provider-selection dialog.
2. Show OpenAI, Google Gemini, Anthropic, DeepSeek, and Custom as a grid of button
   cards. Each card contains a provider icon and name. Custom uses a neutral icon.
3. Do not put connection fields or redundant descriptions in this dialog.
4. Selecting a card closes the dialog and opens a new-channel draft in the right
   detail pane. It does not create a persisted channel or credential.
5. Dismissing the dialog without selecting a preset leaves the workspace unchanged.

### Right-pane draft

Use the existing channel detail layout. Show the selected preset, an editable
channel name, Connection, and Models. Prefill the channel name from the preset and
use the connection defaults in the table above. Preserve the existing initial
enabled states for channels and models.

The draft supports all of the following before the first channel save:

- Edit the name, enabled state, default API, Base URL, and API key.
- Test the connection.
- Fetch the remote model list.
- Add, edit, enable, disable, and remove model entries locally.
- Set model API overrides and existing model configuration fields.

Keep draft connection values, credentials, and models in memory. Do not write them
to channel, model, or credential storage before the user saves the new channel.
Draft models are ordinary local model entries. They are not a verification queue.

Provide Save and Cancel actions whose scope is the new channel and its current
model list. Saving does not require a prior test or model fetch. Do not start a test
or fetch automatically when the user selects a preset or saves a channel.

### Leaving the draft

Allow only one new-channel draft at a time. Before switching to an existing channel,
leaving Models within the application, cancelling the draft, or starting another
channel, ask whether to discard the draft.

- Cancel the leave action: keep all input and remain in the draft.
- Discard: clear the connection values, credential, and model list, then perform the
  requested navigation. Cancelling creation returns to the previous channel, or the
  empty state if no saved channel exists.

Dismissal of a model dialog does not discard the channel draft. A provider picker
that has not yet produced a draft needs no discard confirmation.

Drafts do not survive application exit. This scope does not add an application-exit
interceptor or draft recovery.

## Connection and API selection

### One root address and credential

Each channel has one editable Base URL and one API key. All of its model requests
use those connection values. A model API override changes the protocol, not the
address or credential.

The Base URL can contain a service path prefix. Preserve that prefix when building
requests. The preset and protocol own the endpoint path and authentication rules.
Do not infer the preset from the hostname, require an official hostname, or switch
to an official host when a proxy request fails.

For example, DeepSeek documents Chat Completions and Responses under its API root,
but Messages under `/anthropic/v1/messages`. Its preset must account for this path
difference while keeping one configured root. Custom uses the standard protocol
path rules, without a per-endpoint path editor. A proxy must support the path rules
of the selected preset and protocol.

Custom has no official URL preset. An empty Custom URL can be saved locally, but a
network action requires an explicit usable URL. Built-in presets supply their
listed official URL when the user has not supplied a replacement.

Keep the existing URL-format checks and insecure HTTP policy. Loopback HTTP remains
allowed. Non-loopback HTTP requires the existing explicit consent before use. Do
not add a domain allowlist or remote verification to local saving.

### Default API type

Rename the channel-level API Type field to **Default API type**. Show only protocols
allowed by the selected preset. For a single-protocol preset, show its fixed value
without implying that another protocol is available.

Use the default in two places:

- Requests for models that have no explicit API override.
- Connection testing and model discovery, with the preset's discovery rules.

Remove the Models section's separate discovery-protocol selector. Test and Fetch
use the current connection configuration, including draft values. They must not
silently use a previous URL, credential, or API selection.

Model discovery can use a shared catalog endpoint across protocols. For example,
DeepSeek documents `GET /models` for its catalog. Selecting Messages must not blindly
turn that into an unsupported catalog path.

### Model overrides

Every model API selector offers **Use channel default** and the preset's allowed
protocols. Use the same choices for manual model creation and model editing.

Resolve the effective API as follows:

```text
effective API = model API override, if set
                otherwise channel default API
```

Changing the channel default changes the effective API of all models without an
override, including remotely discovered models. Explicit overrides remain unchanged.
Clearing an override restores dynamic inheritance; it does not copy a fixed value.

The source protocol never takes priority over the channel default. Remove
source-based fallback behavior and source-based API labels. A model row must make
its inherited or explicit API state clear, including the effective protocol.

Changing the Base URL preserves the channel ID, preset, model IDs, and overrides.
Models with the same IDs remain available for requests through the new compatible
endpoint. No brand or domain matching is required.

## Model list behavior

### Local configuration, not a verified catalog

The model list is user-owned configuration. Remote discovery is only a way to
populate and refresh it.

- Allow an empty model list.
- Allow manual model IDs that have never appeared in a remote response.
- Do not check whether a manually entered model exists on the server.
- Do not require a successful fetch before a manual entry can be saved or enabled.
- Keep existing local model fields, capability overrides, token limits, and controls.
- Preserve the existing distinction between default states for fetched and manually
  added models; discovery does not automatically enable every returned model.

A plausible but nonexistent model ID is valid local configuration. A later request
can fail because the server does not provide it. That failure does not prevent
saving the channel or model.

### Identity and merge rules

A model is unique by **channel ID + model ID**. Discovery protocol, preset name,
Base URL, and model API override are not part of that identity.

When a fetch returns an existing model ID:

- Update the same local record, not a second protocol-specific copy.
- Preserve its stable local ID, enabled state, user name, API override, capability
  overrides, and user-configured limits.
- Refresh remote metadata and discovery status using the existing merge behavior.

New remote IDs create new entries. Repeated fetches, a changed default API, or a
changed proxy address must not create duplicates for the same channel and model ID.
Manual addition of an existing ID reports the duplicate instead of creating a copy.

Keep existing missing-model behavior: mark previously discovered entries as missing
when absent from a later successful fetch; do not delete them or manual entries.
A failed fetch leaves the current list intact. A successful fetch does not remove
manual entries merely because the server did not return them.

### Capability and limit seeding

Model entries need capability flags and token limits before a user can select them
for translation. Discovery fills them from the models.dev catalog
(`https://models.dev/models.json`):

- The catalog request is best effort. A timeout, an offline machine, or a malformed
  body leaves discovery unchanged and does not fail the fetch or sync.
- The catalog is fetched at most once per 24 hours. The derived facts are cached
  in app storage, so later discoveries and manual additions need no request. An
  expired cache is used when a refresh fails.
- Lookup uses the provider ID that matches the preset (`openai`, `anthropic`,
  `google` for Gemini, `deepseek`) with the model ID, then falls back to the model
  ID alone, case-insensitively. A Custom channel has no catalog provider and
  matches by model ID only.
- Capability flags come from the catalog when it knows the model; otherwise the
  protocol adapter keeps its model-ID heuristic.
- Token limits prefer the value the provider's own listing reports. The catalog
  fills a limit the listing omits. Discovery never replaces a limit already stored
  on the model record.
- A model added by hand also receives catalog facts when the catalog knows it.
  These facts are discovery data: a user capability override still wins, and no
  model is enabled automatically.

## Saving and errors

### Local save rules

Save local configuration without requiring any of the following:

- A reachable service.
- A valid or nonempty API key.
- A successful connection test or model fetch.
- A nonempty model list.
- Server confirmation that a model ID exists or supports the selected protocol.

Retain local structural checks, such as a nonempty channel name, a nonempty model
ID for each model entry, a supported protocol selection, valid supplied URL syntax,
and valid numeric fields. Do not confuse these checks with server validation.

The first Save writes the channel, its credential if supplied, and its current model
entries. A successful save selects the created channel and continues in its detail
pane. It must not add a second channel because the user presses Save again.

Do not require an atomic transaction across channel, credential, and model records.
If a local write fails, report what was not saved and keep the relevant input
available in the current editor. Already saved data can remain. Do not report that
all changes were saved when some writes failed. No persistent retry queue is required.

After creation, retain the existing connection-save and per-model editing scopes.
Cancelling unsaved connection changes does not roll back model changes already saved.

### Network state

Connection tests retain their current purpose: check the configured catalog endpoint
and credentials. A successful catalog request is not proof that every inference
protocol or model works. This scope does not add a paid inference probe.

Show loading and errors on the action that caused them. Authentication failures,
timeouts, rejected requests, and catalog errors do not prevent local configuration
saving or manual model entry. Saving does not require waiting for a network result.

Prevent duplicate local save submissions. Cancel or ignore network results when
their draft is discarded or their connection inputs are no longer current. A late
response must not populate another draft or overwrite a different channel's models.

## UI and delivery constraints

Reuse the existing desktop master-detail layout, shared controls, semantic theme
tokens, and dialog styling in [Design System](../ui/DESIGNE.md). Do not redesign
unrelated settings or navigation. Keep controls and model actions usable at the
configured minimum window size of 720 × 520.

Keep interface copy bare. Use concise titles, labels, and actions; add explanations
only for scope, consequences, or recovery. All app-authored strings, including
accessibility labels and errors, use `t()` and exist in both `locales/en.yml` and
`locales/zh-CN.yml`.

Provider cards and draft controls must work by keyboard and expose names and state
to assistive technology. Move focus into the picker, then into the draft after
selection. Return focus to the trigger when the picker is dismissed. Discard
confirmation must leave focus in the correct retained or destination view.

Reuse existing interaction and popup motion. Before implementation, record the
picker, draft entry, discard confirmation, loading states, and model-list updates
in the design document's motion inventory. Honor reduced motion. Validate the new
surfaces in light and dark appearances; behavior tests alone do not prove layout.

## Acceptance scenarios

| ID | Scenario | Required result |
| --- | --- | --- |
| AC-01 | Open Add channel from either entry point | The same five icon-and-name cards appear in a grid. No connection form appears in the picker. |
| AC-02 | Select a preset, then cancel creation | The right pane shows an editable draft. Discarding it leaves no persisted channel, credential, or model entries. |
| AC-03 | Attempt to leave or replace a draft | Confirmation offers retaining all input or discarding it. Only one new-channel draft exists. |
| AC-04 | Create each preset | Allowed APIs and initial defaults match the preset table. DeepSeek never appears as an API protocol choice. |
| AC-05 | Replace an OpenAI preset URL with a compatible proxy | The preset and allowed protocols remain unchanged. Requests use the configured proxy, not the official host. |
| AC-06 | Use multiple APIs in one channel | Every model shares its channel root and credential. Endpoint paths follow the preset and effective protocol, including DeepSeek's Messages path. |
| AC-07 | Add and edit models before saving a channel | Manual entries, fetched entries, API overrides, and other model settings remain editable in the draft and are included on Save. |
| AC-08 | Save with an empty list, invalid key, failed test, failed fetch, or nonexistent manual model ID | Local saving remains available if structural checks pass. No remote verification is required. |
| AC-09 | Change the default API after adding models | All models without overrides follow the new default. Explicit overrides remain unchanged. Discovery source has no effect. |
| AC-10 | Fetch the same model ID through another allowed API or proxy | The existing record is updated. User settings and local identity remain. No duplicate is created. |
| AC-11 | Fetch fails or a successful fetch omits a model | Failure preserves the list. Missing remote entries are retained with missing status. Manual entries are not removed. |
| AC-12 | Test or fetch from a draft | The request uses current connection inputs and the default API's discovery rules. There is no independent protocol selector. |
| AC-13 | Save or discard while a network request is pending | Local saving does not depend on the request succeeding. Discarded or stale results cannot modify another editor. |
| AC-14 | A local write fails after another write succeeds | The user sees an accurate error and can retain unsaved input. Saved data need not be rolled back. No false full-success message appears. |
| AC-15 | Use Custom with no URL | Local configuration can be saved. Network actions require an explicit usable URL and do not silently target an official service. |
| AC-16 | Complete the flow by keyboard in English and Chinese | Controls have accessible names and visible focus. Picker, draft, model dialogs, and discard confirmation follow the documented focus behavior. |
| AC-17 | Review light and dark UI at normal and minimum window sizes | Provider cards, connection fields, model controls, error states, and focus indicators remain visible and usable. |
| AC-18 | Implement the new storage format | There is no requirement to read, preserve, or migrate old configuration data. Legacy compatibility is not an acceptance condition. |

## Evidence and references

Existing behavior was inspected in `features/models/`, including channel creation,
connection validation, model editing, model identity, and synchronization. Protocol
networking was inspected in `services/protocols/`. These files are implementation
context, not a requirement to keep the current provider/protocol coupling.

DeepSeek's official documentation confirms the three compatible chat protocols,
the Messages path prefix, and the shared model catalog:

- [Build a Chatbot](https://api-docs.deepseek.com/guides/build_a_chatbot/).
- [Using the Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api.md).
- [Lists Models](https://api-docs.deepseek.com/api/list-models.md).

Compatibility does not mean that all provider-specific parameters behave identically.
Implement only the configuration changes in this specification; do not expand this
work into a new inference implementation.
