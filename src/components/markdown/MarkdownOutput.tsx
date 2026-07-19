// ABOUTME: Streaming-safe Markdown renderer for translation output panes.
// ABOUTME: Wraps Streamdown + Shiki code plugin; raw text stays the copy source.
import { createCodePlugin } from "@streamdown/code";
import { Streamdown } from "streamdown";
import { cn } from "../../lib/cn";

/** Shiki dual theme: light / dark (pairs with data-theme via Tailwind dark:). */
const CODE_SHIKI_THEME = ["github-light", "github-dark"] as const;

/** Stable plugin map so Streamdown does not remount on every parent render. */
const MARKDOWN_PLUGINS = {
  code: createCodePlugin({ themes: [...CODE_SHIKI_THEME] }),
} as const;

export type MarkdownOutputProps = {
  /** Accumulated markdown source (grows while streaming). */
  text: string;
  /** True after the first stream chunk of the current run. */
  isStreaming?: boolean;
  className?: string;
};

/**
 * Render translation markdown with incomplete-block handling for stream chunks.
 * Does not append scramble glyphs — those would pollute the markdown parse.
 * Fenced code uses Shiki via `@streamdown/code` (languages lazy-loaded).
 */
export function MarkdownOutput({ text, isStreaming = false, className }: MarkdownOutputProps) {
  if (!text) {
    return null;
  }

  return (
    <div
      className={cn(
        "markdown-output min-w-0 max-w-none wrap-break-word text-body-md text-on-surface select-text",
        className,
      )}
      role={isStreaming ? "status" : undefined}
      aria-busy={isStreaming || undefined}
    >
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        isAnimating={isStreaming}
        // Built-in stream caret on the last block (block | circle); only while isStreaming.
        caret={isStreaming ? "block" : undefined}
        parseIncompleteMarkdown
        plugins={MARKDOWN_PLUGINS}
        shikiTheme={[...CODE_SHIKI_THEME]}
        // Translation panes: no code/table chrome (copy uses raw result.text).
        controls={false}
        // Dense cards: highlight only; no gutter line numbers.
        lineNumbers={false}
        className="size-full min-w-0"
      >
        {text}
      </Streamdown>
    </div>
  );
}
