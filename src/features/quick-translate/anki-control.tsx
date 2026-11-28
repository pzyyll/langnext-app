import { Text } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";

export type CardAnkiState =
  | { status: "idle" }
  | { status: "adding" }
  | { status: "added" }
  | { status: "error"; message: string };

/** Icon button showing idle/adding/added/error feedback for saving a note to Anki. */
export function AnkiAddButton(props: { testID: string; anki: CardAnkiState; onPress: () => void }) {
  const tooltip = () =>
    props.anki.status === "added"
      ? t("quickTranslate.ankiAdded")
      : props.anki.status === "adding"
        ? t("quickTranslate.ankiAdding")
        : t("quickTranslate.ankiAdd");

  return (
    <Button
      testID={props.testID}
      size="icon-xs"
      variant="ghost"
      tooltip={tooltip()}
      accessibilityLabel={tooltip()}
      onPress={props.onPress}
    >
      <Icon
        name={props.anki.status === "added" ? "mdi:check" : "mdi:share-variant-outline"}
        tone={props.anki.status === "added" ? "success" : "muted-foreground"}
        class="size-3.5"
      />
    </Button>
  );
}

/** Inline status line displaying Adding, Added to Anki, or error text for a single Anki write target. */
export function AnkiStatusText(props: { testID: string; anki: CardAnkiState; class?: string }) {
  const message = () => {
    if (props.anki.status === "adding") return t("quickTranslate.ankiAdding");
    if (props.anki.status === "added") return t("quickTranslate.ankiAdded");
    if (props.anki.status === "error") return props.anki.message;
    return "";
  };

  return (
    <If when={props.anki.status !== "idle"}>
      <Text
        testID={props.testID}
        role={props.anki.status === "error" ? "alert" : undefined}
        class={`text-xs ${props.anki.status === "error" ? "text-destructive" : "text-muted-foreground"} ${props.class ?? ""}`}
      >
        {message()}
      </Text>
    </If>
  );
}
