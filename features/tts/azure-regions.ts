/**
 * Public standard-voice regions whose REST host is
 * `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`.
 * Sovereign hosts (`tts.speech.azure.us` and Azure China) stay out.
 * Source: Azure Speech REST reference, standard voices table.
 */
const PUBLIC_AZURE_SPEECH_REGIONS = new Set([
  "australiaeast",
  "brazilsouth",
  "canadacentral",
  "canadaeast",
  "centralindia",
  "centralus",
  "eastasia",
  "eastus",
  "eastus2",
  "francecentral",
  "germanywestcentral",
  "italynorth",
  "japaneast",
  "japanwest",
  "koreacentral",
  "northcentralus",
  "northeurope",
  "norwayeast",
  "qatarcentral",
  "southafricanorth",
  "southcentralus",
  "southeastasia",
  "swedencentral",
  "switzerlandnorth",
  "switzerlandwest",
  "uaenorth",
  "uksouth",
  "ukwest",
  "westcentralus",
  "westeurope",
  "westus",
  "westus2",
  "westus3",
]);

/** Returns the canonical region id, or null when the value is not a public host region. */
export function parseAzureSpeechRegion(value: string): string | null {
  const region = value.trim().toLowerCase();
  return PUBLIC_AZURE_SPEECH_REGIONS.has(region) ? region : null;
}
