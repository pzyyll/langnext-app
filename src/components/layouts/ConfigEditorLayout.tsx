// ABOUTME: Shared config detail shell: title header, scrollable body, sticky footer.
// ABOUTME: Used by Models, OCR, and Profiles so title/body/footer spacing stays aligned.
import type { ComponentPropsWithoutRef, ReactNode, SubmitEventHandler } from "react";
import { ScrollArea } from "../ScrollArea";
import { cn } from "../../lib/cn";

/** Inline rename field used in Models/OCR title rows. */
export const configEditorRenameInputClassName = `
  h-10 w-full max-w-md rounded-none border border-line bg-surface px-2 text-headline-display font-bold
  text-on-surface
  focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface
  disabled:border-disabled disabled:text-disabled
`;

/** Sticky action bar under the scroll body. */
export const configEditorFooterClassName =
  "flex shrink-0 items-center justify-end gap-3 border-t border-line bg-surface px-8 py-4";

type ConfigEditorLayoutBaseProps = {
  /** Left side of the title row (heading and optional rename controls). */
  title: ReactNode;
  /** Right side of the title row (e.g. enabled switch). */
  titleTrailing?: ReactNode;
  /** Optional content between the title row and divider (e.g. rename error). */
  titleMeta?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
};

export type ConfigEditorLayoutProps = ConfigEditorLayoutBaseProps &
  (
    | ({
        as?: "div";
        onSubmit?: never;
      } & Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "title">)
    | ({
        as: "form";
        onSubmit?: SubmitEventHandler<HTMLFormElement>;
      } & Omit<ComponentPropsWithoutRef<"form">, "children" | "className" | "title" | "onSubmit">)
  );

/**
 * Config detail pane layout shared by Models / OCR / Profiles editors.
 * Title header and body share one ScrollArea with `p-8`; footer stays pinned.
 */
export function ConfigEditorLayout({
  title,
  titleTrailing,
  titleMeta,
  children,
  footer,
  className,
  as = "div",
  onSubmit,
  ...rest
}: ConfigEditorLayoutProps) {
  const rootClassName = cn("flex min-h-0 min-w-0 flex-1 flex-col", className);

  const body = (
    <>
      <ScrollArea className="min-h-0 flex-1" contentClassName="p-8">
        <header className="mb-8">
          <div className="mb-2 flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">{title}</div>
            {titleTrailing}
          </div>
          {titleMeta}
          <hr className="border-line" />
        </header>
        {children}
      </ScrollArea>
      <footer className={configEditorFooterClassName}>{footer}</footer>
    </>
  );

  if (as === "form") {
    return (
      <form
        className={rootClassName}
        onSubmit={onSubmit}
        {...(rest as Omit<ComponentPropsWithoutRef<"form">, "children" | "className" | "title" | "onSubmit">)}
      >
        {body}
      </form>
    );
  }

  return (
    <div
      className={rootClassName}
      {...(rest as Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "title">)}
    >
      {body}
    </div>
  );
}
