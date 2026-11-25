import { cleanup, effect, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { createAnkiClient, type AnkiReadFailure } from "../wordbook/anki-client";
import { wordbookSettingsStore, type WordbookAnkiTarget } from "../wordbook/settings";

const FAILURE_KEYS: Record<AnkiReadFailure, string> = {
  unreachable: "settings.wordbook.failure.unreachable",
  unauthorized: "settings.wordbook.failure.unauthorized",
  forbidden: "settings.wordbook.failure.forbidden",
  unavailable: "settings.wordbook.failure.unavailable",
  noCollection: "settings.wordbook.failure.noCollection",
  staleSession: "settings.wordbook.failure.staleSession",
  malformed: "settings.wordbook.failure.malformed",
  timeout: "settings.wordbook.failure.timeout",
};

function choiceItems(items: { id: string; name: string }[]) {
  return items.map((item) => ({ value: item.id, title: item.name }));
}

/** Anki destination settings. A connection check stays on this card and does not run by itself. */
export function WordbookSection(props: {
  compact: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const keyDraft = signal("");
  const status = signal<"idle" | "checking" | "ready" | "failed">("idle");
  const message = signal<string | null>(null);
  const profile = signal<string | null>(null);
  const session = signal<string | null>(null);
  const decks = signal<{ id: string; name: string }[]>([]);
  const noteTypes = signal<{ id: string; name: string }[]>([]);
  const deckId = signal<string | null>(null);
  const noteTypeId = signal<string | null>(null);
  const fields = signal<string[]>([]);
  const translationField = signal<string | null>(null);
  const compatible = signal(false);
  const saving = signal(false);
  let generation = 0;

  const saved = () => wordbookSettingsStore.view();

  function clearDiscovery() {
    profile.set(null);
    session.set(null);
    decks.set([]);
    noteTypes.set([]);
    deckId.set(null);
    noteTypeId.set(null);
    fields.set([]);
    translationField.set(null);
    compatible.set(false);
  }

  async function apiKeyForCheck(): Promise<string | undefined> {
    const draft = keyDraft().trim();
    if (draft.length > 0) return draft;
    return (await wordbookSettingsStore.readApiKey()) ?? undefined;
  }

  async function checkConnection() {
    const ticket = ++generation;
    status.set("checking");
    message.set(t("settings.wordbook.checking"));
    clearDiscovery();
    const apiKey = await apiKeyForCheck();
    if (ticket !== generation) return;
    const found = await createAnkiClient(apiKey ? { apiKey } : {}).discover();
    if (ticket !== generation) return;
    if (!found.ok) {
      status.set("failed");
      message.set(t(FAILURE_KEYS[found.failure]));
      return;
    }
    profile.set(found.profile);
    session.set(found.session);
    decks.set(found.decks);
    noteTypes.set(found.noteTypes);
    status.set("ready");
    message.set(null);
  }

  async function selectNoteType(id: string) {
    const ticket = generation;
    const currentSession = session();
    noteTypeId.set(id);
    fields.set([]);
    translationField.set(null);
    compatible.set(false);
    if (!currentSession) return;
    const apiKey = await apiKeyForCheck();
    if (ticket !== generation || noteTypeId() !== id) return;
    const detail = await createAnkiClient(apiKey ? { apiKey } : {}).getNoteType(currentSession, id);
    if (ticket !== generation || noteTypeId() !== id) return;
    const usable =
      detail.ok &&
      detail.kind === "normal" &&
      !detail.hasDeckOverride &&
      detail.templateCount >= 1 &&
      detail.fields.length >= 2;
    if (!detail.ok) {
      message.set(t(FAILURE_KEYS[detail.failure]));
      return;
    }
    if (!usable) {
      message.set(t("settings.wordbook.incompatible"));
      return;
    }
    fields.set(detail.fields);
    const choices = detail.fields.slice(1);
    translationField.set(choices.length === 1 ? (choices[0] ?? null) : null);
    compatible.set(true);
    message.set(null);
  }

  function currentTarget(): WordbookAnkiTarget | null {
    const profileName = profile();
    const selectedDeck = decks().find((item) => item.id === deckId());
    const selectedType = noteTypes().find((item) => item.id === noteTypeId());
    const source = fields()[0];
    const translation = translationField();
    if (
      status() !== "ready" ||
      !compatible() ||
      !profileName ||
      !selectedDeck ||
      !selectedType ||
      !source ||
      !translation ||
      translation === source
    ) {
      return null;
    }
    return {
      profile: profileName,
      deckId: selectedDeck.id,
      deckName: selectedDeck.name,
      noteTypeId: selectedType.id,
      noteTypeName: selectedType.name,
      sourceField: source,
      translationField: translation,
    };
  }

  function unsaved() {
    if (keyDraft().trim().length > 0) return true;
    const stored = wordbookSettingsStore.view().target;
    const live = currentTarget();
    const partial = deckId() !== null || noteTypeId() !== null || translationField() !== null;
    if (live === null) return partial;
    if (stored === null) return true;
    return (
      live.profile !== stored.profile ||
      live.deckId !== stored.deckId ||
      live.noteTypeId !== stored.noteTypeId ||
      live.sourceField !== stored.sourceField ||
      live.translationField !== stored.translationField
    );
  }

  effect(() => {
    props.onDirtyChange(unsaved());
  });
  cleanup(() => props.onDirtyChange(false));

  async function saveTarget() {
    const next = currentTarget();
    if (!next || saving()) return;
    saving.set(true);
    const draft = keyDraft().trim();
    const result = await wordbookSettingsStore.save(
      next,
      draft.length > 0 ? { apiKey: draft } : undefined,
    );
    saving.set(false);
    if (!result.ok) {
      message.set(result.message);
      return;
    }
    keyDraft.set("");
    message.set(t("settings.wordbook.saved"));
  }

  async function removeSavedKey() {
    const stored = wordbookSettingsStore.view().target;
    if (!stored?.credentialRef || saving()) return;
    saving.set(true);
    const result = await wordbookSettingsStore.save(stored, { removeKey: true });
    saving.set(false);
    message.set(result.ok ? t("settings.wordbook.saved") : result.message);
  }

  return (
    <Card testID="settings-wordbook-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
      <SectionHeading title={t("settings.wordbook.provider")} />
      <Text class="text-sm text-muted-foreground">{t("settings.wordbook.prerequisite")}</Text>
      <View class="gap-2">
        <Text class="text-sm font-medium text-card-foreground">{t("settings.wordbook.key")}</Text>
        <Input
          testID="settings-wordbook-key"
          masked
          value={keyDraft()}
          placeholder={t("settings.wordbook.keyPlaceholder")}
          accessibilityLabel={t("settings.wordbook.key")}
          onChange={(value) => {
            keyDraft.set(value);
            generation += 1;
            clearDiscovery();
            status.set("idle");
            message.set(null);
          }}
        />
        <Text class="text-sm text-muted-foreground">{t("settings.wordbook.keyHelp")}</Text>
        <If when={saved().target?.credentialRef !== undefined}>
          <Button
            testID="settings-wordbook-remove-key"
            variant="ghost"
            label={t("settings.wordbook.removeKey")}
            disabled={saving()}
            onPress={() => void removeSavedKey()}
          />
        </If>
      </View>
      <Button
        testID="settings-wordbook-check"
        label={t("settings.wordbook.testConnection")}
        disabled={status() === "checking" || saving()}
        onPress={() => void checkConnection()}
      />
      <If when={message() !== null}>
        <Text
          role={status() === "failed" ? "alert" : undefined}
          testID="settings-wordbook-status"
          class={
            status() === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {message()}
        </Text>
      </If>
      <If when={profile() !== null}>
        <View class="gap-1">
          <Text class="text-sm font-medium text-card-foreground">
            {t("settings.wordbook.profile")}
          </Text>
          <Text testID="settings-wordbook-profile" class="text-sm text-foreground">
            {profile()}
          </Text>
        </View>
      </If>
      <If when={status() === "ready"}>
        <View class="gap-2">
          <Text class="text-sm font-medium text-card-foreground">
            {t("settings.wordbook.deck")}
          </Text>
          <Select
            testID="settings-wordbook-deck"
            items={choiceItems(decks())}
            value={deckId()}
            placeholder={t("settings.wordbook.choose")}
            accessibilityLabel={t("settings.wordbook.deck")}
            onChange={(value) => {
              if (value !== null) deckId.set(value);
            }}
          />
        </View>
        <View class="gap-2">
          <Text class="text-sm font-medium text-card-foreground">
            {t("settings.wordbook.noteType")}
          </Text>
          <Select
            testID="settings-wordbook-note-type"
            items={choiceItems(noteTypes())}
            value={noteTypeId()}
            placeholder={t("settings.wordbook.choose")}
            accessibilityLabel={t("settings.wordbook.noteType")}
            onChange={(value) => {
              if (value !== null) void selectNoteType(value);
            }}
          />
        </View>
      </If>
      <If when={fields().length >= 2}>
        <View class="gap-1">
          <Text class="text-sm font-medium text-card-foreground">
            {t("settings.wordbook.sourceField")}
          </Text>
          <Text testID="settings-wordbook-source" class="text-sm text-foreground">
            {fields()[0]}
          </Text>
        </View>
        <View class="gap-2">
          <Text class="text-sm font-medium text-card-foreground">
            {t("settings.wordbook.translationField")}
          </Text>
          <Select
            testID="settings-wordbook-translation"
            items={fields()
              .slice(1)
              .map((name) => ({ value: name, title: name }))}
            value={translationField()}
            placeholder={t("settings.wordbook.choose")}
            accessibilityLabel={t("settings.wordbook.translationField")}
            onChange={(value) => {
              if (value !== null) translationField.set(value);
            }}
          />
        </View>
      </If>
      <Button
        testID="settings-wordbook-save"
        variant="primary"
        label={t("settings.wordbook.save")}
        disabled={currentTarget() === null || saving()}
        onPress={() => void saveTarget()}
      />
      <If when={saved().target !== null}>
        <View testID="settings-wordbook-saved" class="gap-1">
          <Text class="text-sm text-foreground">{saved().target?.deckName}</Text>
          <Text class="text-sm text-foreground">{saved().target?.noteTypeName}</Text>
          <Text class="text-sm text-foreground">{saved().target?.sourceField}</Text>
          <Text class="text-sm text-foreground">{saved().target?.translationField}</Text>
        </View>
      </If>
      <Switch
        testID="settings-wordbook-enabled"
        label={t("settings.wordbook.enable")}
        checked={saved().enabled}
        onChange={(checked) => {
          void wordbookSettingsStore.setEnabled(checked).then((result) => {
            if (!result.ok) message.set(result.message);
          });
        }}
      />
      <If when={saved().error !== null}>
        <Text role="alert" testID="settings-wordbook-error" class="text-sm text-destructive">
          {saved().error?.message}
        </Text>
      </If>
    </Card>
  );
}
