// ABOUTME: Dialog to choose LLM vs integration engine when creating a translation profile.
// ABOUTME: Mirrors AddOcrServiceDialog grid layout; does not register Google in the provider registry.
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { dialogBackdropClassName, dialogPopupClassName, outlineButtonClassName } from "../../components/ui";
import type { TranslationEngineOption } from "./translationEngineOptions";

const ENGINE_OPTION_MAX_COLUMNS = 3;

type AddTranslationProfileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly TranslationEngineOption[];
  onSelect: (option: TranslationEngineOption) => void;
};

export function AddTranslationProfileDialog({
  open,
  onOpenChange,
  options,
  onSelect,
}: AddTranslationProfileDialogProps) {
  const { t } = useTranslation();
  const columnCount = Math.min(options.length, ENGINE_OPTION_MAX_COLUMNS);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup
          className={`
            ${dialogPopupClassName}
            w-md
          `}
        >
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">
              {t("translate.profiles.addEngineTitle")}
            </Dialog.Title>
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onSelect(option);
                  onOpenChange(false);
                }}
                className={`
                  flex min-w-0 items-center border border-line bg-surface p-3 text-left text-on-surface
                  transition-colors
                  hover:bg-surface-container-highest
                  disabled:cursor-default disabled:opacity-60
                  disabled:hover:bg-surface
                `}
              >
                <span className="min-w-0 truncate text-body-md font-bold">{option.label}</span>
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Dialog.Close className={outlineButtonClassName}>{t("common.cancel")}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
