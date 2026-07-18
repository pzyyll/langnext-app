# Storage Architecture for LangNext

## Conclusion

Use three purpose-specific storage mechanisms:

1. **SQLite** is the single source of truth for portable business configuration:
   - Provider instances
   - Provider models and model cache
   - Translation profiles and fallback chains
   - Portable application settings
2. **The operating system credential vault** stores API keys, bearer tokens, and proxy credentials.
3. **A versioned device-state file** stores machine-specific state such as window geometry. It is not exported.

JSON is an interchange format for explicit import and export, not a live configuration source. Translation requests, source text, translated text, and complete AI responses are not persisted.

## Storage boundaries

| Data                              | Storage              | Exported | Notes                                                      |
| --------------------------------- | -------------------- | -------- | ---------------------------------------------------------- |
| Provider instances                | SQLite               | Yes      | Credential references are omitted from export              |
| Model records and cached metadata | SQLite               | Yes      | Remote availability is cache metadata                      |
| Translation profiles              | SQLite               | Yes      | Includes prompt templates and fallback ordering            |
| Portable app settings             | SQLite               | Yes      | Language, theme, translation preferences, network settings |
| API keys and bearer tokens        | OS credential vault  | No       | Never returned to the React WebView                        |
| Proxy credentials                 | OS credential vault  | No       | Uses the same security boundary as Provider credentials    |
| Window geometry and device state  | Versioned local file | No       | Safe to delete to reset device state                       |
| Translation/request content       | Memory only          | No       | Not retained after the active task ends                    |
| Migration recovery snapshots      | Local SQLite backups | No       | Keep the latest three snapshots                            |

## Ownership and access

Only the Rust backend may access SQLite or the credential vault. React calls typed Tauri commands and receives sanitized data transfer objects.

AI requests are sent by Rust. API keys must never be returned through a Tauri command, event, log, or error payload. Streaming output can be delivered to React through Tauri channels or events.

Recommended backend layers:

```text
Tauri commands
    -> application services
        -> repositories
            -> SQLite
        -> credential service
            -> OS credential vault
        -> Provider adapters
            -> remote AI APIs
```

Database queries and migration logic should not be distributed across React components.

## Core relational model

All entity identifiers should be application-generated UUIDs. Store timestamps as UTC with one consistent representation throughout the database.

### `provider_instances`

Represents a user-created connection. Multiple instances may use the same adapter.

```sql
CREATE TABLE provider_instances (
    id                          TEXT PRIMARY KEY,
    adapter_id                  TEXT NOT NULL,
    display_name                TEXT NOT NULL,
    base_url_override           TEXT,
    credential_kind             TEXT NOT NULL
                                CHECK (credential_kind IN ('none', 'api_key', 'bearer')),
    credential_ref              TEXT,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    proxy_mode                  TEXT NOT NULL DEFAULT 'inherit'
                                CHECK (proxy_mode IN ('inherit', 'direct')),
    insecure_http_confirmed_at  TEXT,
    models_synced_at            TEXT,
    models_sync_status          TEXT NOT NULL DEFAULT 'never'
                                CHECK (models_sync_status IN ('never', 'ok', 'error')),
    models_sync_error_code      TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    -- non-none Providers may have a null reference (needs authentication).
    CHECK (credential_kind <> 'none' OR credential_ref IS NULL)
);
```

A non-`none` Provider with a null `credential_ref` is the **needs authentication** state (after creation without a secret, credential clear, or secret-free import). Only `credential_kind = 'none'` is required to have a null reference.

`adapter_id` identifies a Rust adapter such as `openai-compatible`, `anthropic`, or `gemini`. Adapter metadata, protocol behavior, icons, documentation links, authentication injection rules, and default API URLs ship with application code and are not copied into SQLite.

`base_url_override` is nullable. A null value means that the adapter default applies.

For custom non-HTTPS URLs:

- HTTP is allowed without confirmation for loopback hosts.
- Other HTTP endpoints require an explicit warning and a stored confirmation timestamp.
- URLs containing embedded usernames or passwords are rejected.

### `provider_models`

Represents a model available through one specific Provider instance.

```sql
CREATE TABLE provider_models (
    id                          TEXT PRIMARY KEY,
    provider_instance_id        TEXT NOT NULL,
    model_key                   TEXT NOT NULL,
    source                      TEXT NOT NULL
                                CHECK (source IN ('remote', 'manual', 'builtin')),
    remote_display_name         TEXT,
    display_name_override       TEXT,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    availability                TEXT NOT NULL DEFAULT 'unknown'
                                CHECK (availability IN ('available', 'missing', 'unknown')),
    remote_metadata_json        TEXT,
    capability_overrides_json   TEXT,
    last_seen_at                TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    FOREIGN KEY (provider_instance_id)
        REFERENCES provider_instances(id) ON DELETE RESTRICT,
    UNIQUE (provider_instance_id, model_key)
);
```

The effective display name is `display_name_override`, then the remote display name, then `model_key`.

The effective capabilities are calculated from:

1. Adapter defaults and known model metadata
2. Remote metadata
3. User capability overrides

Only sparse user overrides are stored in `capability_overrides_json`. The JSON is versioned and validated by the owning adapter before it is persisted.

Remote synchronization never deletes a model merely because it disappeared from one response. It marks remote models as `missing`. A later response can restore them to `available`. Manual models are not marked missing by remote synchronization.

### `translation_profiles`

Represents a named translation behavior such as Fast Translation or Technical Documents.

```sql
CREATE TABLE translation_profiles (
    id                          TEXT PRIMARY KEY,
    name                        TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    template_version            INTEGER NOT NULL,
    system_template             TEXT NOT NULL,
    user_template               TEXT NOT NULL,
    temperature                 REAL,
    max_output_tokens           INTEGER,
    provider_options_json       TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    CHECK (temperature IS NULL OR temperature >= 0),
    CHECK (max_output_tokens IS NULL OR max_output_tokens > 0)
);
```

Prompt templates support only documented variables such as:

- `{{source_language}}`
- `{{target_language}}`
- `{{text}}`

Templates are parsed and validated before saving. Arbitrary scripts are not supported.

Invocation parameters belong only to the translation profile. Provider instances contain connection settings, and model records contain metadata. This avoids implicit parameter inheritance.

Common parameters use typed columns. Adapter-specific parameters use `provider_options_json`, which the selected adapter validates. Only user overrides are stored; adapter defaults are resolved at runtime.

### `translation_profile_models`

Defines one primary model and an ordered fallback chain.

```sql
CREATE TABLE translation_profile_models (
    translation_profile_id     TEXT NOT NULL,
    provider_model_id           TEXT NOT NULL,
    priority                    INTEGER NOT NULL CHECK (priority >= 0),
    PRIMARY KEY (translation_profile_id, provider_model_id),
    UNIQUE (translation_profile_id, priority),
    FOREIGN KEY (translation_profile_id)
        REFERENCES translation_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (provider_model_id)
        REFERENCES provider_models(id) ON DELETE RESTRICT
);
```

Priority `0` is the primary model. Higher values are fallback models.

The fallback policy is code-defined in the first release:

- Try the next model for connection failures, timeouts, HTTP 408, HTTP 429, and HTTP 5xx responses.
- Stop for authentication failures, invalid requests, and content-policy refusals.

Do not persist a configurable fallback-policy field until the product needs one.

### `app_settings`

Stores one strongly typed, portable settings document.

```sql
CREATE TABLE app_settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version  INTEGER NOT NULL,
    value_json      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

Rust deserializes `value_json` into a versioned `AppSettings` type. Invalid or unknown data does not flow directly into runtime behavior.

Expected categories include:

- UI language and theme
- Default translation profile ID
- Translation interaction preferences
- Shortcut definitions
- Global network proxy mode and proxy URL

The default translation profile reference should be validated at the application-service layer. If the referenced profile is unavailable, the UI must request a replacement rather than silently selecting a different paid model.

Provider proxy behavior supports `inherit` or `direct`. Global networking supports the system proxy or a custom HTTP/SOCKS5 proxy. Proxy authentication secrets remain in the credential vault and are omitted from export.

## Device state

Store device-specific state outside SQLite in a versioned file, for example:

```text
<app-data>/device-state.json
```

Window geometry is debounced with a real delayed flush (default 300 ms generation-based task). Failed writes retain pending state for retry. Tray exit attempts a final flush; failures log a bounded warning and preserve the previous durable file.

Geometry validation requires finite, positive, bounded dimensions. While maximized, only the maximized flag is updated so the last normal restore rectangle is retained.

Deleting the device-state file must reset device state without affecting Provider instances, models, credentials, translation profiles, or portable application settings.

Do not use frontend `localStorage` as the authoritative device-state store when multiple windows need consistent state.

## Credential model

The credential vault stores secrets under application-owned references. A Provider record stores only an opaque `credential_ref`.

Conceptually:

```text
provider_instances.credential_ref = "provider/<provider-uuid>/primary"
OS credential vault entry          = actual secret
```

Rules:

- `credential_kind = none` requires a null credential reference.
- API keys cannot be revealed after saving. Users may replace or delete them.
- Leaving a credential field empty while editing means keep the current credential.
- Connection tests execute in Rust using the stored credential.
- Provider DTOs expose only a boolean credential status, never the reference or secret.
- Export omits credential references and secrets.
- Imported Provider instances begin in a `needs authentication` state unless their authentication kind is `none`.

SQLite and an OS credential vault cannot participate in one real atomic transaction. The Rust application service therefore needs compensation and reconciliation:

1. Insert a `prepared` credential journal for the owner.
2. Write a replacement credential under a new reference in the OS vault.
3. Commit the SQLite reference update and mark the journal `db_committed`.
4. Finalize by deleting the old vault secret when present, then delete the journal **only after** vault cleanup succeeds or is confirmed absent (`NoEntry` is success).
5. If vault cleanup fails after a committed write, retain the `db_committed` journal and return the successful business DTO; emit a bounded `cleanup_deferred` diagnostic. Do not roll back the committed reference.
6. If the database commit fails, attempt to delete the unused new vault secret while retaining `prepared` when that delete also fails.
7. On startup and before every credential mutation (and before import busy checks for affected owners), recover unfinished journals for those owners. A temporary vault outage returns `credential_unavailable` rather than a permanent `credential_busy` after recovery is attempted.

Never overwrite the existing vault entry before SQLite accepts the corresponding configuration update. Never delete a journal to artificially unblock a stuck owner.

## CRUD and referential behavior

Use `ON DELETE RESTRICT` for Provider and model records referenced by other entities.

- A referenced Provider or model can be disabled but not deleted.
- A disabled Provider cannot start a new request.
- A profile remains editable if one of its models is unavailable.
- A profile can execute if it has at least one enabled, available model through an enabled Provider.
- Deleting a translation profile may cascade only to its own fallback-chain rows.

Provider, credential, and translation-profile forms use explicit Save actions. Rust validates and commits the complete change. Simple settings such as theme or language may be saved immediately.

## Model synchronization

Support manual refresh plus stale-while-revalidate behavior:

1. Cached models are immediately available.
2. A user can explicitly refresh one Provider instance.
3. When a cache is older than 24 hours, opening or using the Provider may trigger a background refresh.
4. Refresh failure does not block use of cached models.
5. Error details stored in SQLite are bounded, classified, and stripped of URLs containing secrets, headers, and response bodies.
6. A failed refresh updates only status, bounded error code, and `updated_at`. It must **not** clear `models_synced_at` from the last successful merge.

A synchronization transaction should:

1. Upsert all returned remote models by `(provider_instance_id, model_key)`.
2. Mark returned records as `available` and update `last_seen_at`.
3. Mark previously remote-sourced but absent models as `missing`.
4. Preserve manual records, aliases, enablement, and versioned capability overrides (`CapabilityOverridesV1`).
5. Update Provider-level synchronization status only after the model transaction succeeds.

## Import and export

The export format is a versioned application document, not a copy of the SQLite database.

```json
{
  "formatVersion": 1,
  "exportedAt": "UTC timestamp",
  "providers": [],
  "models": [],
  "translationProfiles": [],
  "profileModels": [],
  "appSettings": {}
}
```

It excludes:

- API keys, bearer tokens, and proxy credentials
- Credential references
- Device state
- Request or translation content
- Migration backups
- Built-in adapter metadata

Before import, show a preview. For conflicting UUIDs, users choose:

- **Merge:** update the matching entities after validation.
- **Copy:** generate new UUIDs and rewrite all internal references in the imported document.

Import preview and apply share one normalized `ValidatedImportPlan`:

- Reject duplicate IDs, unknown adapters, orphan targets, empty fallback chains, non-contiguous priorities, invalid capability overrides, and incomplete graphs (every reference must resolve inside the document).
- System proxy mode requires `proxy_url = null`; custom URLs reject userinfo, query, and fragment.
- Apply rebuilds and revalidates the plan inside the write transaction against current local rows.
- Import clears only credential bindings it owns in that transaction and finalizes exact import-owned journal operations afterward. Unrelated unfinished journals are never swept.

Export and other aggregate DTOs (settings + proxy flag) must use one deferred SQLite **read snapshot** so concurrent commits cannot produce half-updated aggregates.

## Migration and recovery

Maintain a monotonic database schema version and forward-only migrations in Rust.

Before applying migrations:

1. Open and integrity-check the existing database.
2. Write a snapshot to a same-directory `.partial` file via SQLite's backup API, integrity-check it read-only, then atomically rename to `.sqlite3`.
3. After success, rotate to the latest three **integrity-checked** snapshots; quarantine corrupt candidates with an `.invalid` suffix.
4. Run migrations transactionally where SQLite permits.
5. If migration fails, keep the original database and stop normal writes.

JSON settings and template documents have their own explicit schema versions. Database schema versioning does not replace document-level versioning.

## SQLite runtime configuration

Recommended connection behavior:

- Enable foreign keys on every connection.
- Use WAL mode for responsive reads while Rust performs a write.
- Configure a bounded busy timeout.
- Keep all writes behind repository/application-service methods.
- Use short transactions and never hold a database transaction open during a network request or credential-vault prompt.
- Run remote synchronization first, then apply its result in a short database transaction.

The application is a single local-user product. Do not add unused `user_id` or `workspace_id` columns in the first schema.

## Privacy and logging

Do not persist source text, translated text, rendered prompts, full Provider requests, or Provider responses.

Operational logging may include bounded and sanitized information such as:

- Adapter identifier
- Provider instance UUID
- Error category
- HTTP status code
- Duration
- Token counts, when available

It must exclude:

- Authorization headers and API keys
- Prompt and translation content
- Credential-vault references when they reveal account identity
- Raw error bodies that may echo request content

SQLite does not require application-level encryption for this threat model because secrets and translation content are excluded. Rely on operating-system account permissions and disk encryption. SQLCipher should be considered only after a separate enterprise threat-model review.

## Recommended initial implementation order

1. Add the Rust persistence boundary, SQLite migrations, and repository traits.
2. Implement Provider-instance CRUD and the credential service.
3. Implement model CRUD and remote synchronization merge behavior.
4. Implement translation profiles and ordered fallback targets.
5. Implement the typed `AppSettings` document and separate device state.
6. Add versioned import/export with preview and transactional conflict handling.
7. Add migration snapshots, integrity checks, credential reconciliation, and privacy-focused tests.

## Rejected alternatives

- **A single JSON configuration file:** weak transactional behavior and poor relational integrity for Provider/model/profile references.
- **Frontend-owned SQL:** scatters validation and exposes the persistence boundary to the WebView.
- **Persisted adapter definitions:** duplicates code-owned protocol behavior and creates version drift.
- **Plaintext or application-encrypted API keys:** weaker than platform credential storage and introduces a second key-management problem.
- **Automatic deletion of missing remote models:** unsafe when Provider responses are incomplete and destructive to profile references.
- **Persisting complete request logs:** violates the agreed scope and effectively creates translation history.

## Implemented storage locations

Under the Tauri 2 app-data directory (`BaseDirectory::AppData` for identifier `com.balaenis.langnext-app`):

| Path                                                 | Purpose                                                        | Exported                |
| ---------------------------------------------------- | -------------------------------------------------------------- | ----------------------- |
| `langnext.sqlite3`                                   | Portable configuration (Providers, models, profiles, settings) | Via versioned JSON only |
| `backups/langnext-v<old>-<YYYYMMDDTHHMMSSZ>.sqlite3` | Pre-migration recovery snapshots (keep 3 newest)               | No                      |
| `device-state.json`                                  | Machine-specific window geometry                               | No                      |

OS credential vault service name: `com.balaenis.langnext-app`.

Account names:

- Provider: `provider/<provider-uuid>/<operation-uuid>`
- Global proxy: `proxy/global/<operation-uuid>`

### Internal credential metadata tables

These tables are **never exported**:

1. **`app_credentials`** — singleton bindings such as `global_proxy` → opaque `credential_ref`.
2. **`credential_operations`** — crash-recovery journal with states `prepared` and `db_committed`. Unique on `(owner_kind, owner_id)` so only one unfinished mutation exists per Provider or the global proxy. Replacement writes use a new vault account; SQLite compare-and-sets the previous reference before the old vault entry is deleted.

### Theme authority

In the desktop (Tauri) app, **SQLite `AppSettings.theme` is authoritative**. `localStorage` (`langnext-theme`) is only a pre-paint / browser-development cache. First Tauri bootstrap may persist a valid legacy cache value or OS preference when the SQLite theme is still null.

### Reset behavior

| Action                                  | Effect                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Delete `device-state.json`              | Resets window geometry only                                                                                                              |
| Delete `langnext.sqlite3` (and WAL/SHM) | Removes portable configuration; does **not** automatically delete OS vault entries until conservative reconciliation can prove ownership |
| Clear a Provider credential via IPC     | Nulls the SQLite reference and deletes the vault entry when available                                                                    |
| Import (merge or copy)                  | Clears matching Provider credential references and custom-proxy binding; imported authenticated Providers require re-authentication      |

### Import / export privacy

- Exports contain no secrets, credential references, device state, journals, or migration backups.
- Every imported non-`none` Provider starts without a credential (`has_credential = false` / needs authentication).
- Importing custom proxy settings clears the local proxy credential binding.

### Native vault smoke tests

Headless CI uses the test-only in-memory `CredentialVault`. Interactive release platforms should run:

```bash
mise exec -- cargo test --manifest-path src-tauri/Cargo.toml native_vault_smoke -- --ignored
```

This requires a logged-in desktop session with the platform credential store available (Windows Credential Manager, macOS Keychain, or Linux Secret Service).
