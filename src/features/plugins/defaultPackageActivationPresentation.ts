// ABOUTME: Pure status and copy mapping for default package authorization and activation.
// ABOUTME: Presentation only; no Effect imports or IPC side effects.
import type { DefaultPackageAuthorizationStatus } from "../../storage/types";

/** Host-owned subject runtime states relevant to default package activation. */
export type DefaultRuntimeActivationUiState =
  | "pending_activation"
  | "confirmation_required"
  | "unavailable"
  | "active"
  | "idle";

/** Backend error code when instance authority exceeds the default policy. */
export const RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE = "runtime_authority_confirmation_required" as const;

/** True when the durable runtime error code requests subject authority confirmation. */
export function isAuthorityConfirmationRequired(runtimeErrorCode?: string | null): boolean {
  return runtimeErrorCode === RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE;
}

export type DefaultPackageActivationTone = "neutral" | "info" | "warning" | "danger" | "success";

/**
 * Closed set of i18next catalog paths returned by default-activation presentation helpers.
 * Callers pass these keys to `t` without casts; invalid paths fail typecheck at the source.
 */
export type DefaultPackageActivationTranslationKey =
  | "plugins.packages.defaultActivation.status.absent"
  | "plugins.packages.defaultActivation.status.absentDescription"
  | "plugins.packages.defaultActivation.status.unauthorized"
  | "plugins.packages.defaultActivation.status.unauthorizedDescription"
  | "plugins.packages.defaultActivation.status.authorized"
  | "plugins.packages.defaultActivation.status.authorizedDescription"
  | "plugins.packages.defaultActivation.status.stale"
  | "plugins.packages.defaultActivation.status.staleDescription"
  | "plugins.packages.defaultActivation.status.confirmationRequired"
  | "plugins.packages.defaultActivation.status.confirmationRequiredDescription"
  | "plugins.packages.defaultActivation.runtime.confirmationRequired"
  | "plugins.packages.defaultActivation.runtime.confirmationRequiredDescription"
  | "plugins.packages.defaultActivation.runtime.pending"
  | "plugins.packages.defaultActivation.runtime.pendingDescription"
  | "plugins.packages.defaultActivation.runtime.unavailable"
  | "plugins.packages.defaultActivation.runtime.unavailableWithCode"
  | "plugins.packages.defaultActivation.runtime.unavailableDescription"
  | "plugins.packages.defaultActivation.runtime.active"
  | "plugins.packages.defaultActivation.runtime.activeDescription"
  | "plugins.packages.defaultActivation.runtime.idle"
  | "plugins.packages.defaultActivation.runtime.idleWithDefault"
  | "plugins.packages.defaultActivation.runtime.idleWithoutDefault";

export interface DefaultPackageDefaultStatusPresentation {
  status: DefaultPackageAuthorizationStatus;
  labelKey: DefaultPackageActivationTranslationKey;
  descriptionKey: DefaultPackageActivationTranslationKey;
  tone: DefaultPackageActivationTone;
  /** True when "Set as default" must open the authorization preview. */
  requiresAuthorization: boolean;
  /** True when the default may create package-first instances automatically. */
  packageFirstReady: boolean;
  /** True when the current default may open authorization again (unauthorized/stale). */
  allowReauthorization: boolean;
}

export interface DefaultRuntimeActivationPresentation {
  state: DefaultRuntimeActivationUiState;
  labelKey: DefaultPackageActivationTranslationKey;
  descriptionKey: DefaultPackageActivationTranslationKey;
  tone: DefaultPackageActivationTone;
  /** Hide manual digest entry in the normal flow. */
  hideManualDigest: boolean;
  /** Disable actions that require an active runtime. */
  disableReadyActions: boolean;
  showRetry: boolean;
  showAuthorityConfirm: boolean;
}

const DEFAULT_STATUS = {
  absent: {
    labelKey: "plugins.packages.defaultActivation.status.absent",
    descriptionKey: "plugins.packages.defaultActivation.status.absentDescription",
    tone: "neutral",
    requiresAuthorization: false,
    packageFirstReady: false,
    allowReauthorization: false,
  },
  unauthorized: {
    labelKey: "plugins.packages.defaultActivation.status.unauthorized",
    descriptionKey: "plugins.packages.defaultActivation.status.unauthorizedDescription",
    tone: "warning",
    requiresAuthorization: true,
    packageFirstReady: false,
    allowReauthorization: true,
  },
  authorized: {
    labelKey: "plugins.packages.defaultActivation.status.authorized",
    descriptionKey: "plugins.packages.defaultActivation.status.authorizedDescription",
    tone: "success",
    requiresAuthorization: false,
    packageFirstReady: true,
    allowReauthorization: false,
  },
  stale: {
    labelKey: "plugins.packages.defaultActivation.status.stale",
    descriptionKey: "plugins.packages.defaultActivation.status.staleDescription",
    tone: "warning",
    requiresAuthorization: true,
    packageFirstReady: false,
    allowReauthorization: true,
  },
  confirmation_required: {
    labelKey: "plugins.packages.defaultActivation.status.confirmationRequired",
    descriptionKey: "plugins.packages.defaultActivation.status.confirmationRequiredDescription",
    tone: "info",
    requiresAuthorization: false,
    packageFirstReady: false,
    allowReauthorization: false,
  },
} as const satisfies Record<DefaultPackageAuthorizationStatus, Omit<DefaultPackageDefaultStatusPresentation, "status">>;

/**
 * Map catalog default authorization status to Installed Plugins UI.
 * Existing defaults without a policy are unauthorized and never treated as package-first ready.
 */
export function presentDefaultPackageAuthorizationStatus(
  status: DefaultPackageAuthorizationStatus,
): DefaultPackageDefaultStatusPresentation {
  return { status, ...DEFAULT_STATUS[status] };
}

/**
 * Decide whether the default action is enabled for an installed version row.
 * Current authorized defaults stay disabled. Unauthorized/stale current defaults may reauthorize.
 */
export function canAuthorizeInstalledDefault(input: {
  isDefault: boolean;
  contentAvailable: boolean;
  defaultAuthorizationStatus: DefaultPackageAuthorizationStatus;
}): boolean {
  if (!input.contentAvailable) {
    return false;
  }
  const presentation = presentDefaultPackageAuthorizationStatus(input.defaultAuthorizationStatus);
  if (input.isDefault) {
    return presentation.allowReauthorization;
  }
  return true;
}

/** Pure Advanced recovery visibility for manual digest entry. */
export function presentAdvancedRecoveryDigestVisibility(input: {
  hasUsableDefault: boolean;
  chooseAnotherPackage: boolean;
  panelOpen: boolean;
}): { showDigestInput: boolean; showChooseAnotherPackage: boolean } {
  if (!input.panelOpen) {
    return { showDigestInput: false, showChooseAnotherPackage: false };
  }
  if (!input.hasUsableDefault) {
    return { showDigestInput: true, showChooseAnotherPackage: false };
  }
  return {
    showDigestInput: input.chooseAnotherPackage,
    showChooseAnotherPackage: true,
  };
}

/**
 * Map subject runtime/activation state to Integration/Provider editor copy.
 * Normal default activation never requires typing a digest.
 */
export function presentDefaultRuntimeActivation(input: {
  runtimeState?: string | null;
  runtimeErrorCode?: string | null;
  hasAuthorizedDefault: boolean;
  authorityConfirmationRequired?: boolean;
}): DefaultRuntimeActivationPresentation {
  // Prefer the durable confirmation error code even when callers omit the boolean flag.
  const authorityConfirmationRequired =
    input.authorityConfirmationRequired === true || isAuthorityConfirmationRequired(input.runtimeErrorCode);
  if (authorityConfirmationRequired) {
    return {
      state: "confirmation_required",
      labelKey: "plugins.packages.defaultActivation.runtime.confirmationRequired",
      descriptionKey: "plugins.packages.defaultActivation.runtime.confirmationRequiredDescription",
      tone: "info",
      hideManualDigest: true,
      disableReadyActions: true,
      showRetry: false,
      showAuthorityConfirm: true,
    };
  }

  const runtimeState = input.runtimeState ?? "idle";
  if (runtimeState === "pending_activation") {
    return {
      state: "pending_activation",
      labelKey: "plugins.packages.defaultActivation.runtime.pending",
      descriptionKey: "plugins.packages.defaultActivation.runtime.pendingDescription",
      tone: "info",
      hideManualDigest: true,
      disableReadyActions: true,
      showRetry: false,
      showAuthorityConfirm: false,
    };
  }

  if (runtimeState === "unavailable") {
    return {
      state: "unavailable",
      labelKey: "plugins.packages.defaultActivation.runtime.unavailable",
      descriptionKey: input.runtimeErrorCode
        ? "plugins.packages.defaultActivation.runtime.unavailableWithCode"
        : "plugins.packages.defaultActivation.runtime.unavailableDescription",
      tone: "danger",
      hideManualDigest: input.hasAuthorizedDefault,
      disableReadyActions: true,
      showRetry: true,
      showAuthorityConfirm: false,
    };
  }

  if (runtimeState === "active") {
    return {
      state: "active",
      labelKey: "plugins.packages.defaultActivation.runtime.active",
      descriptionKey: "plugins.packages.defaultActivation.runtime.activeDescription",
      tone: "success",
      hideManualDigest: true,
      disableReadyActions: false,
      showRetry: false,
      showAuthorityConfirm: false,
    };
  }

  return {
    state: "idle",
    labelKey: "plugins.packages.defaultActivation.runtime.idle",
    descriptionKey: input.hasAuthorizedDefault
      ? "plugins.packages.defaultActivation.runtime.idleWithDefault"
      : "plugins.packages.defaultActivation.runtime.idleWithoutDefault",
    tone: "neutral",
    hideManualDigest: input.hasAuthorizedDefault,
    disableReadyActions: false,
    showRetry: false,
    showAuthorityConfirm: false,
  };
}

/**
 * Production Validate disable policy for IntegrationEditor.
 * Combines ordinary form blockers with default-activation readiness.
 */
export function isIntegrationValidateDisabled(input: {
  pending: boolean;
  dirty: boolean;
  pluginMissing: boolean;
  runtimeState?: string | null;
  runtimeErrorCode?: string | null;
  packageDigest?: string | null;
}): boolean {
  const activationPresentation = presentDefaultRuntimeActivation({
    runtimeState: input.runtimeState,
    runtimeErrorCode: input.runtimeErrorCode,
    hasAuthorizedDefault: Boolean(input.packageDigest),
    authorityConfirmationRequired: isAuthorityConfirmationRequired(input.runtimeErrorCode),
  });
  return input.pending || input.dirty || input.pluginMissing || activationPresentation.disableReadyActions;
}
