// ABOUTME: Boundary tests for the shared lazy Markdown renderer.
// ABOUTME: Asserts a visible TextLoading fallback, then deferred Markdown content.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
import { afterEach, describe, expect, test } from "bun:test";

const PLAIN_MARKDOWN_TEXT = "plain";
const TRANSLATING_LABEL = "Translating";

afterEach(() => {
  cleanup();
  resetDom();
});

describe("LazyMarkdownOutput", () => {
  test("keeps visible output and loading status while Markdown is suspended", async () => {
    const { LazyMarkdownOutput } = await import("./LazyMarkdownOutput");
    render(<LazyMarkdownOutput text={PLAIN_MARKDOWN_TEXT} isLoading loadingLabel={TRANSLATING_LABEL} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.textContent ?? "").toContain(PLAIN_MARKDOWN_TEXT);
    expect(status.querySelector(".loading-dots")).toBeTruthy();

    await waitFor(() => {
      expect(document.querySelector(".markdown-output")).toBeTruthy();
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector(".markdown-output")?.textContent ?? "").toContain(PLAIN_MARKDOWN_TEXT);
  });
});
