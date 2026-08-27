// ABOUTME: Shared lazy boundary for translation Markdown output.
// ABOUTME: Defers the Streamdown/Shiki renderer until a route actually paints Markdown.
import { lazy, Suspense } from "react";
import { TextLoading } from "../TextLoading";
import type { MarkdownOutputProps } from "./MarkdownOutput";

const MarkdownOutput = lazy(() =>
  import("./MarkdownOutput").then((module) => ({
    default: module.MarkdownOutput,
  })),
);

export type LazyMarkdownOutputProps = MarkdownOutputProps & {
  isLoading: boolean;
  loadingLabel: string;
};

export type { MarkdownOutputProps };

export function LazyMarkdownOutput({ isLoading, loadingLabel, ...props }: LazyMarkdownOutputProps) {
  return (
    <Suspense
      fallback={
        <TextLoading
          text={props.text}
          isLoading={isLoading}
          scramble={props.isStreaming}
          loadingLabel={loadingLabel}
          className="text-on-surface"
        />
      }
    >
      <MarkdownOutput {...props} />
    </Suspense>
  );
}
