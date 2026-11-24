import { TranslationHistoryNative, type HistoryResult } from "my-translator/native";
import { createLogger } from "../../services/log";

const log = createLogger("quick-translate/history");
let writes = Promise.resolve();

/** Groups the successful result cards from one translation action. */
export function beginHistoryAction(sourceText: string): (result: HistoryResult) => void {
  const id = crypto.randomUUID();
  let started = false;
  return (result) => {
    writes = writes
      .then(async () => {
        await TranslationHistoryNative.record(id, started ? null : sourceText, result);
        started = true;
      })
      .catch(() => log.warn("Could not save translation history."));
  };
}

export async function listRecentHistory() {
  await writes;
  return TranslationHistoryNative.listRecent();
}

export function readHistory(id: string) {
  return TranslationHistoryNative.read(id);
}
