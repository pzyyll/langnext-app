// ABOUTME: Adapter catalog, strategy registry, and HTTP model-list / chat transport.
// ABOUTME: Built-in strategies register like plugins; transport dispatches by adapter id.
pub mod builtin;
pub mod catalog;
pub mod protocol;
pub mod registry;
pub mod transport;
