import type { ProtocolId } from "../../modules/ai/contracts/protocol";
import type { ProviderPresetId } from "./presets";

export { ProviderProtocolError } from "../../modules/ai/contracts/errors";
export type { ProviderErrorKind } from "../../modules/ai/contracts/errors";
export type { DiscoveredRemoteModel } from "../../modules/ai/contracts/model";
export type { RequestOperation, ResolvedRequestTarget } from "../../modules/ai/contracts/protocol";

/** Provider wire protocol identifiers; open until the old path is removed. */
export type AdapterId = ProtocolId;

export interface AdapterRequestParams {
  presetId: ProviderPresetId;
  adapterId: AdapterId;
  baseUrl: string | null;
  credential: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}
