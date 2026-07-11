// ABOUTME: Typed queryOptions factories wrapping storage IPC read functions.
// ABOUTME: Keeps query keys and fetchers co-located for reuse across routes.
import { queryOptions } from "@tanstack/react-query";
import {
	getTranslationProfile,
	listAllProviderModels,
	listProviderInstances,
	listProviderModels,
	listTranslationProfiles,
} from "../storage/client";
import { modelKeys, profileKeys, providerKeys } from "./keys";

export function providerListOptions() {
	return queryOptions({
		queryKey: providerKeys.list(),
		queryFn: listProviderInstances,
	});
}

export function allProviderModelsOptions() {
	return queryOptions({
		queryKey: modelKeys.allEnabled(),
		queryFn: listAllProviderModels,
	});
}

export function providerModelsOptions(providerInstanceId: string) {
	return queryOptions({
		queryKey: modelKeys.byProvider(providerInstanceId),
		queryFn: () => listProviderModels(providerInstanceId),
		enabled: providerInstanceId.length > 0,
	});
}

export function profileListOptions() {
	return queryOptions({
		queryKey: profileKeys.list(),
		queryFn: listTranslationProfiles,
	});
}

export function profileDetailOptions(id: string) {
	return queryOptions({
		queryKey: profileKeys.detail(id),
		queryFn: () => getTranslationProfile(id),
		enabled: id.length > 0,
	});
}
