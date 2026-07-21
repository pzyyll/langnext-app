// ABOUTME: Built-in provider adapter strategies registered at process start.
// ABOUTME: Each module owns one API family; the registry loads them as plugins would.
mod anthropic;
mod deepseek;
mod gemini;
mod openai_compatible;
mod openai_responses;
mod openai_shared;

pub use anthropic::{AnthropicAdapter, parse_anthropic_page};
pub use deepseek::DeepSeekAdapter;
pub use gemini::{GeminiAdapter, parse_gemini_page};
pub use openai_compatible::OpenAiCompatibleAdapter;
pub use openai_responses::OpenAiResponsesAdapter;
pub use openai_shared::parse_openai_page;

// Shared helpers kept crate-visible for strategy modules and tests.
pub(crate) use openai_shared::normalize_model_key;

use crate::adapters::protocol::AdapterHandle;
use crate::adapters::registry::wrap;

/// All built-in strategies, in registration order.
pub fn all_builtin_adapters() -> Vec<AdapterHandle> {
  vec![
    wrap(OpenAiCompatibleAdapter),
    wrap(OpenAiResponsesAdapter),
    wrap(AnthropicAdapter),
    wrap(GeminiAdapter),
    wrap(DeepSeekAdapter),
  ]
}
