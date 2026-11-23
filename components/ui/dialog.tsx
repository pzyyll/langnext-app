import { Scroll, Text, View, type JSX, type ViewRef } from "nsh";
import { Dialog as BaseDialog } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../motion";
import { Button, type ButtonVariant } from "./button";

export type DialogSize = "sm" | "md" | "lg";

interface AppDialogProps {
  open: boolean;
  title: string;
  description?: string;
  role?: "dialog" | "alertdialog";
  size?: DialogSize;
  testID?: string;
  closeOnEscape?: boolean;
  closeOnBackdropPress?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onOpenChange: (open: boolean) => void;
  footer?: JSX.Element;
  children?: JSX.Element;
}

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: "w-96",
  md: "w-112",
  lg: "w-128",
};

/** Modal dialog matching AboutDialog's frame, border, and footer surface tokens. */
export function AppDialog(props: AppDialogProps) {
  return (
    <BaseDialog
      testID={props.testID}
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      role={props.role ?? "dialog"}
      open={props.open}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      onOpen={() => props.onOpen?.()}
      onClose={() => props.onClose?.()}
      animation={motion.dialogAnimation}
      closeOnEscape={props.closeOnEscape ?? true}
      closeOnBackdropPress={props.closeOnBackdropPress ?? true}
      backdropClass="bg-overlay"
      class={`m-auto max-w-full overflow-hidden rounded-2xl border border-border bg-background shadow-xl ${SIZE_CLASSES[props.size ?? "sm"]}`}
    >
      <View class="border-b border-border px-5 py-3">
        <Text role="header" class="text-sm font-medium text-foreground">
          {props.title}
        </Text>
      </View>
      <Scroll class="max-h-96">
        <View class="gap-4 p-5">
          <If when={props.description !== undefined}>
            <Text class="text-sm text-muted-foreground">{props.description}</Text>
          </If>
          {props.children}
        </View>
      </Scroll>
      <If when={props.footer !== undefined}>
        <View class="flex-row items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
          {props.footer}
        </View>
      </If>
    </BaseDialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  error?: string | null;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  busy?: boolean;
  testID?: string;
  cancelTestID?: string;
  confirmTestID?: string;
  cancelRef?: (node: ViewRef) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

/** Alert dialog requiring explicit user confirmation for destructive or irreversible actions. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <AppDialog
      testID={props.testID}
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy) props.onOpenChange(open);
      }}
      onOpen={props.onOpen}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      role="alertdialog"
      size="sm"
      closeOnEscape={!props.busy}
      closeOnBackdropPress={!props.busy}
      footer={
        <>
          <Button
            testID={props.cancelTestID}
            ref={(node) => props.cancelRef?.(node)}
            variant="outline"
            size="sm"
            label={props.cancelLabel ?? t("common.cancel")}
            disabled={props.busy}
            onPress={() => props.onOpenChange(false)}
          />
          <Button
            testID={props.confirmTestID}
            variant={props.confirmVariant ?? "destructive"}
            size="sm"
            label={props.confirmLabel ?? t("common.confirm")}
            disabled={props.busy}
            onPress={() => props.onConfirm()}
          />
        </>
      }
    >
      <If when={Boolean(props.error)}>
        <Text role="alert" class="text-xs text-destructive">
          {props.error}
        </Text>
      </If>
    </AppDialog>
  );
}
