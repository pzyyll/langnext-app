import { cleanup, effect, signal, type Accessor, type Signal } from "nsh";
import { t } from "nsh/i18n";
import type { IconName } from "../../components/ui/icon";
import { AUTO_LANGUAGE, type LanguageId, type SourceLanguageId } from "../../framework/languages";
import { detectLanguage } from "../language-detection/detect";
import { languageResolutionErrorMessage } from "../language-detection/messages";
import { languageDetectionPreferences } from "../language-detection/preferences";
import { synthesizeSpeech } from "../tts/channels";
import { playMp3Bytes } from "../tts/playback";
import { prepareQuickSpeech, quickSpeechFailureMessage } from "../tts/quick-speech";
import { ttsChannels } from "../tts/store";
import type { DictionarySpeakControlState } from "./dictionary-band";
import type { QuickTranslateSession } from "./session";

type SpeechOwner =
  | { kind: "source"; text: string; selection: SourceLanguageId }
  | { kind: "dictionary"; slot: "inline" | "drawer"; term: string }
  | { kind: "result"; cardId: string; text: string; language: string }
  | { kind: "back-translation"; cardId: string; text: string; language: string };

export type SpeechControlTarget =
  | "source"
  | "inline-dictionary"
  | "drawer-dictionary"
  | { kind: "result" | "back-translation"; cardId: string };

export interface QuickSpeechCoordinator {
  cancel: () => void;
  control: (target: SpeechControlTarget) => DictionarySpeakControlState;
  speakSource: () => void;
  speakInlineDictionary: () => void;
  speakDrawerDictionary: () => void;
  speakResult: (cardId: string) => void;
  speakBackTranslation: (cardId: string) => void;
  sourceError: Accessor<string | null>;
  inlineDictionaryError: Accessor<string | null>;
  drawerDictionaryError: Accessor<string | null>;
  resultError: (cardId: string) => string | null;
  backTranslationError: (cardId: string) => string | null;
}

/** Coordinates single-voice TTS synthesis and playback across source, cards, and dictionary panels. */
export function createQuickSpeechCoordinator(options: {
  session: QuickTranslateSession;
  playbackAllowed?: Accessor<boolean>;
}): QuickSpeechCoordinator {
  const { session } = options;
  const sourceSpeechError = signal<string | null>(null);
  const inlineDictionarySpeechError = signal<string | null>(null);
  const drawerDictionarySpeechError = signal<string | null>(null);
  const resultSpeechErrors = signal<Readonly<Record<string, string>>>({});
  const backTranslationSpeechErrors = signal<Readonly<Record<string, string>>>({});
  const speechPhase = signal<"idle" | "loading" | "playing">("idle");
  const speechOwner = signal<SpeechOwner | null>(null);
  let speechToken = 0;
  let speechAbort: AbortController | null = null;
  let stopSpeech: (() => void) | null = null;
  let activeCredential = "";

  const activeSpeech = () => ttsChannels.activeChannel();
  const speakEnabled = () => activeSpeech() !== null;
  const credentialSignature = () => {
    const active = activeSpeech();
    if (active === null) return "";
    const signature = ttsChannels.definition(active.id)?.signature?.(active.binding) ?? "";
    return `${active.id}\0${active.binding.credentialRef ?? ""}\0${signature}`;
  };

  const cancel = () => {
    speechToken += 1;
    speechAbort?.abort();
    speechAbort = null;
    stopSpeech?.();
    stopSpeech = null;
    speechPhase.set("idle");
    speechOwner.set(null);
  };

  cleanup(cancel);

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "source" || speechPhase() === "idle") return;
    if (owner.text !== session.sourceText() || owner.selection !== session.sourceLanguage()) {
      cancel();
    }
  });

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "dictionary" || speechPhase() === "idle") return;
    if (owner.slot === "inline") {
      const inline = session.inlineDictionary();
      const currentTerm = inline.status === "entry" ? inline.entry.term : "";
      if (currentTerm !== owner.term) cancel();
    } else {
      const drawer = session.dictionaryDrawer();
      const active = drawer.open ? drawer.active : null;
      const currentTerm = active?.status === "entry" ? active.entry.term : "";
      if (currentTerm !== owner.term) cancel();
    }
  });

  effect(() => {
    if (session.inlineDictionary().status !== "entry") {
      inlineDictionarySpeechError.set(null);
    }
  });

  effect(() => {
    const drawer = session.dictionaryDrawer();
    if (!drawer.open || drawer.active?.status !== "entry") {
      drawerDictionarySpeechError.set(null);
    }
  });

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "result" || speechPhase() === "idle") return;
    const card = session.cards().find((item) => item.id === owner.cardId);
    const result = card?.result;
    const current =
      card !== undefined && !card.collapsed && result?.status === "success"
        ? `${result.text}\0${result.targetLanguage}`
        : "";
    if (current !== `${owner.text}\0${owner.language}`) cancel();
  });

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "back-translation" || speechPhase() === "idle") return;
    const card = session.cards().find((item) => item.id === owner.cardId);
    const current =
      card !== undefined &&
      !card.collapsed &&
      card.result.status === "success" &&
      card.backTranslation.status === "success"
        ? `${card.backTranslation.text}\0${card.result.sourceLanguage}`
        : "";
    if (current !== `${owner.text}\0${owner.language}`) cancel();
  });

  const pruneCardErrors = (
    store: Signal<Readonly<Record<string, string>>>,
    keep: (card: ReturnType<QuickTranslateSession["cards"]>[number]) => boolean,
  ) => {
    const cards = session.cards();
    const current = store();
    const cardIds = new Set(cards.map((item) => item.id));
    let changed = false;
    const next: Record<string, string> = {};
    for (const [id, message] of Object.entries(current)) {
      const card = cardIds.has(id) ? cards.find((item) => item.id === id) : undefined;
      if (card !== undefined && keep(card)) {
        next[id] = message;
      } else {
        changed = true;
      }
    }
    if (changed) store.set(next);
  };

  effect(() => {
    pruneCardErrors(
      resultSpeechErrors,
      (card) => !card.collapsed && card.result.status === "success",
    );
    pruneCardErrors(
      backTranslationSpeechErrors,
      (card) =>
        !card.collapsed &&
        card.result.status === "success" &&
        card.backTranslation.status === "success",
    );
  });

  effect(() => {
    if (speechPhase() !== "idle" && credentialSignature() !== activeCredential) cancel();
  });

  effect(() => {
    if (options.playbackAllowed && !options.playbackAllowed() && speechPhase() !== "idle") {
      cancel();
    }
  });

  const setCardSpeechError = (
    store: Signal<Readonly<Record<string, string>>>,
    cardId: string,
    message: string | null,
  ) => {
    const next = { ...store() };
    if (message === null) delete next[cardId];
    else next[cardId] = message;
    store.set(next);
  };

  const mountedSpeech = (token: number) => token === speechToken;

  const finishSpeech = (token: number) => {
    if (!mountedSpeech(token)) return;
    stopSpeech = null;
    speechPhase.set("idle");
    speechOwner.set(null);
  };

  const runSpeech = async (input: {
    owner: SpeechOwner;
    text: string;
    language: LanguageId | null;
    detectStandalone?: boolean;
    report: (message: string | null) => void;
  }) => {
    const token = ++speechToken;
    speechAbort?.abort();
    stopSpeech?.();
    stopSpeech = null;
    const controller = new AbortController();
    speechAbort = controller;
    activeCredential = credentialSignature();
    speechOwner.set(input.owner);
    speechPhase.set("loading");
    input.report(null);

    if (!speakEnabled()) {
      finishSpeech(token);
      input.report(t("quickTranslate.speakOff"));
      return;
    }

    let resolvedLanguage = input.language;
    if (resolvedLanguage === null) {
      const detected = input.detectStandalone
        ? await detectLanguage(input.text, languageDetectionPreferences.snapshot().detectors, {
            signal: controller.signal,
          })
        : await session.detectSourceLanguage(controller.signal);

      if (!mountedSpeech(token)) return;
      if (controller.signal.aborted || detected === null) {
        finishSpeech(token);
        return;
      }
      if (!detected.ok) {
        finishSpeech(token);
        if (detected.code !== "cancelled") {
          input.report(languageResolutionErrorMessage(detected.code));
        }
        return;
      }
      resolvedLanguage = detected.language;
    }

    const prepared = await prepareQuickSpeech({ text: input.text, language: resolvedLanguage });
    if (!mountedSpeech(token)) return;
    if (!prepared.ok) {
      finishSpeech(token);
      input.report(prepared.message);
      return;
    }

    const speech = prepared.speech;
    if (!mountedSpeech(token) || credentialSignature() !== activeCredential) {
      finishSpeech(token);
      return;
    }

    const synthesized = await synthesizeSpeech(speech, { signal: controller.signal });
    if (!mountedSpeech(token)) return;
    if (controller.signal.aborted || synthesized.status === "cancelled") {
      finishSpeech(token);
      return;
    }
    if (credentialSignature() !== activeCredential) {
      finishSpeech(token);
      return;
    }
    if (synthesized.status === "failed") {
      finishSpeech(token);
      input.report(quickSpeechFailureMessage(synthesized.failure, speech.channel));
      return;
    }

    const playback = playMp3Bytes(synthesized.audio, {
      onPlaying: () => {
        if (!mountedSpeech(token)) {
          playback.stop();
          return;
        }
        speechPhase.set("playing");
      },
    });
    stopSpeech = () => playback.stop();
    const played = await playback.result;
    if (!mountedSpeech(token)) return;
    finishSpeech(token);
    if (played.status === "failed") input.report(t("quickTranslate.speakPlayback"));
  };

  const speakSource = () => {
    const selected = session.sourceLanguage();
    void runSpeech({
      owner: { kind: "source", text: session.sourceText(), selection: selected },
      text: session.sourceText(),
      language: selected === AUTO_LANGUAGE ? null : selected,
      report: (message) => sourceSpeechError.set(message),
    });
  };

  const speakInlineDictionary = () => {
    const inline = session.inlineDictionary();
    if (inline.status !== "entry") return;
    const selected = session.sourceLanguage();
    void runSpeech({
      owner: { kind: "dictionary", slot: "inline", term: inline.entry.term },
      text: inline.entry.term,
      language: selected === AUTO_LANGUAGE ? null : selected,
      report: (message) => inlineDictionarySpeechError.set(message),
    });
  };

  const speakDrawerDictionary = () => {
    const drawer = session.dictionaryDrawer();
    if (!drawer.open || drawer.active?.status !== "entry") return;
    const srcLang = drawer.active.query.sourceLanguage;
    void runSpeech({
      owner: { kind: "dictionary", slot: "drawer", term: drawer.active.entry.term },
      text: drawer.active.entry.term,
      language: srcLang && srcLang !== AUTO_LANGUAGE ? srcLang : null,
      detectStandalone: true,
      report: (message) => drawerDictionarySpeechError.set(message),
    });
  };

  const speakResult = (cardId: string) => {
    const card = session.cards().find((item) => item.id === cardId);
    if (card === undefined || card.result.status !== "success") return;
    void runSpeech({
      owner: {
        kind: "result",
        cardId,
        text: card.result.text,
        language: card.result.targetLanguage,
      },
      text: card.result.text,
      language: card.result.targetLanguage,
      report: (message) => setCardSpeechError(resultSpeechErrors, cardId, message),
    });
  };

  const speakBackTranslation = (cardId: string) => {
    const card = session.cards().find((item) => item.id === cardId);
    if (
      card === undefined ||
      card.collapsed ||
      card.result.status !== "success" ||
      card.backTranslation.status !== "success" ||
      card.backTranslation.text.trim().length === 0
    ) {
      return;
    }
    void runSpeech({
      owner: {
        kind: "back-translation",
        cardId,
        text: card.backTranslation.text,
        language: card.result.sourceLanguage,
      },
      text: card.backTranslation.text,
      language: card.result.sourceLanguage,
      report: (message) => setCardSpeechError(backTranslationSpeechErrors, cardId, message),
    });
  };

  const control = (target: SpeechControlTarget): DictionarySpeakControlState => {
    const owner = speechOwner();
    const mine =
      owner !== null &&
      (target === "source"
        ? owner.kind === "source"
        : target === "inline-dictionary"
          ? owner.kind === "dictionary" && owner.slot === "inline"
          : target === "drawer-dictionary"
            ? owner.kind === "dictionary" && owner.slot === "drawer"
            : owner.kind === target.kind && owner.cardId === target.cardId);

    const phase = mine ? speechPhase() : "idle";
    if (phase === "loading") {
      return {
        disabled: false,
        tooltip: t("common.cancel"),
        label: t("common.cancel"),
        icon: "mdi:close-circle" as IconName,
        busy: true,
      };
    }
    if (phase === "playing") {
      return {
        disabled: false,
        tooltip: t("settings.tts.stop"),
        label: t("settings.tts.stop"),
        icon: "mdi:stop-circle-outline" as IconName,
        busy: true,
      };
    }
    const readyLabel =
      typeof target !== "string" && target.kind === "back-translation"
        ? t("quickTranslate.speakBackTranslation")
        : t("quickTranslate.speak");
    return {
      disabled: !speakEnabled(),
      tooltip: speakEnabled() ? undefined : t("quickTranslate.speakOff"),
      label: speakEnabled() ? readyLabel : t("quickTranslate.speakOff"),
      icon: "mdi:volume-high" as IconName,
      busy: false,
    };
  };

  return {
    cancel,
    control,
    speakSource,
    speakInlineDictionary,
    speakDrawerDictionary,
    speakResult,
    speakBackTranslation,
    sourceError: () => sourceSpeechError(),
    inlineDictionaryError: () => inlineDictionarySpeechError(),
    drawerDictionaryError: () => drawerDictionarySpeechError(),
    resultError: (cardId: string) => resultSpeechErrors()[cardId] ?? null,
    backTranslationError: (cardId: string) => backTranslationSpeechErrors()[cardId] ?? null,
  };
}
