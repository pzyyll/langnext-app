// ABOUTME: Domain types for portable configuration and storage DTOs.
// ABOUTME: Entities live here; IPC commands only return sanitized DTOs.
#![allow(dead_code)]
pub mod cancel;
pub mod endpoint_trust;
pub mod first_party_plugins;
pub mod import_export;
pub mod integration_capability_health;
pub mod language_detection;
pub mod model;
pub mod native_worker;
pub mod ocr_service;
pub mod plugin_catalog;
pub mod plugin_model;
pub mod plugin_package;
pub mod plugin_resource;
pub mod plugin_schema;
pub mod provider;
pub mod provider_http;
pub mod runtime_lifecycle;
pub mod runtime_plugin;
pub mod runtime_provider;
pub mod service_capability;
pub mod service_integration;
pub mod settings;
pub mod speech_service;
pub mod time;
pub mod translation;
pub mod translation_history;
pub mod translation_profile;
