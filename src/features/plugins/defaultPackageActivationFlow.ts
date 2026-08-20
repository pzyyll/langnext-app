// ABOUTME: Promise runners for default package authorization preview/confirm.
// ABOUTME: Keeps routes free of deep Effect pipelines; IPC stays in storage clients.
import {
  authorizeDefaultPluginPackage,
  confirmDefaultRuntimeAuthority,
  previewDefaultPackageActivation,
  previewDefaultRuntimeAuthority,
  retryDefaultRuntimeActivation,
} from "../../storage/client";
import type {
  AuthorizeDefaultPluginPackageInput,
  ConfirmDefaultRuntimeAuthorityInput,
  DefaultPackageActivationPreviewDto,
  DefaultRuntimeActivationIntentDto,
  DefaultRuntimeAuthorityPreviewDto,
  PluginDefaultVersionDto,
  PreviewDefaultRuntimeAuthorityInput,
  RetryDefaultRuntimeActivationInput,
} from "../../storage/types";

/** Load an exact default-authorization preview for an installed package digest. */
export async function runPreviewDefaultPackageActivation(
  packageDigest: string,
): Promise<DefaultPackageActivationPreviewDto> {
  return previewDefaultPackageActivation(packageDigest);
}

/** Authorize the default after acknowledgement; requires an opaque preview ID only. */
export async function runAuthorizeDefaultPluginPackage(
  input: AuthorizeDefaultPluginPackageInput,
): Promise<PluginDefaultVersionDto> {
  return authorizeDefaultPluginPackage(input);
}

/** Preview additional subject authority beyond the default policy. */
export async function runPreviewDefaultRuntimeAuthority(
  input: PreviewDefaultRuntimeAuthorityInput,
): Promise<DefaultRuntimeAuthorityPreviewDto> {
  return previewDefaultRuntimeAuthority(input);
}

/** Confirm exact additional authority and activate the retained subject requirement. */
export async function runConfirmDefaultRuntimeAuthority(input: ConfirmDefaultRuntimeAuthorityInput): Promise<void> {
  return confirmDefaultRuntimeAuthority(input);
}

/** Retry retained-digest activation without accepting a package digest. */
export async function runRetryDefaultRuntimeActivation(
  input: RetryDefaultRuntimeActivationInput,
): Promise<DefaultRuntimeActivationIntentDto> {
  return retryDefaultRuntimeActivation(input);
}
