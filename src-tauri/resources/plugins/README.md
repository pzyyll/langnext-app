# Bundled built-in plugin content

`src-tauri/resources/plugins/` ships ten unsigned `.lnplugin` archives: the built-in Wasm
components (Edge TTS, Google Cloud, Google Translate Web, PaddleOCR native worker, Baidu OCR)
and the five built-in LLM provider packages. Each archive contains `plugin.json` plus exactly
the files listed in the manifest file index. There is no `publisher.pub`, no
`signatures/manifest.sig`, no `default-activation-policies.json`, and no vendor trust root.

On every startup the app:

1. Discovers each archive in this directory as `PluginSource::BuiltIn`.
2. Materializes it into an immutable digest-addressed snapshot under `<app-data>/plugin-cache/`.
3. Projects every definition into the service catalog, including Baidu OCR with its `api-key`
   and `secret-key` credential slots, before any instance credentials exist.
4. Treats built-in content as the automatic default for its plugin id; no database row and no
   policy file is needed.

Built-in authenticity comes from the signed application installer and this protected resource
location. The app does not verify a second plugin-level signature. An invalid or missing
built-in archive is a startup readiness failure — never a silent zero-default catalog. Missing
user credentials are configuration state: credential-required plugins (e.g. Baidu OCR) appear
immediately and become executable only after the user supplies credentials.

Required built-in archives:

- `com.langnext.google-translate-web-1.0.0.lnplugin`
- `com.langnext.edge-tts-1.0.0.lnplugin`
- `com.langnext.google-cloud-1.2.0.lnplugin`
- `com.langnext.provider.openai-compatible-1.0.0.lnplugin`
- `com.langnext.provider.openai-responses-1.0.0.lnplugin`
- `com.langnext.provider.anthropic-1.0.0.lnplugin`
- `com.langnext.provider.gemini-1.0.0.lnplugin`
- `com.langnext.provider.deepseek-1.0.0.lnplugin`
- `com.langnext.paddleocr-1.0.0.lnplugin`
- `com.langnext.baidu-ocr-1.0.0.lnplugin`

Validation:

```bash
mise run plugin:check-builtins
```

Packaging runs the same gate before `tauri build`, so a structurally invalid archive fails the
release. Never hand-author a manifest digest: restage the plugin from `runtime-plugins/<name>/`
and pack it with `mise run plugin:pack`.
