# Superseded: Google Translate Profile Plan

**Status:** Superseded. Do not implement tasks from this file.

**Replacement roadmap:** [`google-service-integrations/README.md`](./google-service-integrations/README.md)

**Architecture assessment:** [`../analysis/google-cloud-plugin-architecture.md`](../analysis/google-cloud-plugin-architecture.md)

## Why This Plan Was Replaced

The original design stored Google configuration and service-account ownership directly on Translation Profiles. That would duplicate Google Cloud authentication across Translation, OCR, and future Speech configuration.

The replacement design separates:

1. bundled plugin definitions;
2. user-configured integration instances with host-owned shared credentials;
3. capability bindings from Profiles/OCR/Speech.

## Reversed Decisions

Do not implement:

- Google-specific credential/config columns owned by `translation_profiles`;
- a Profile-owned service-account vault reference;
- one mixed free/official Google channel switch;
- a hardcoded `LLM | Google` Profile type union;
- Google Cloud Translation represented as a fake provider model;
- direct plugin access to the OS vault.

The replacement roadmap uses:

- `com.langnext.google-cloud` for official Cloud Translation/Vision/Speech capabilities;
- `com.langnext.google-translate-web` for GTX/HTTPS proxy translation;
- shared integration instances;
- typed, versioned capability bindings;
- host credential/token/network brokers;
- explicit dual discovery for existing TypeScript LLM providers and Rust service integrations.

## Retained Decisions

The replacement roadmap keeps these requirements:

- Cloud Translation official API is `v3beta1` only;
- official auth uses service-account OAuth, project ID, and location;
- Google translation is non-streaming initially;
- secrets never appear in read DTOs, events, exports, logs, or Query caches;
- GTX and HTTPS proxy translation remain planned as separate free integration capabilities;
- New Profile and Add OCR choices use capability discovery.

## Historical Note

This stub intentionally preserves the former plan path so existing links fail safely into the replacement roadmap instead of pointing at stale implementation instructions.
