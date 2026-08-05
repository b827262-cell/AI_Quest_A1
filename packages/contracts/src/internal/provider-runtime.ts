/**
 * Implementation type intentionally absent from package exports. Provider SDK
 * options and secret-bearing runtime configuration never become contracts.
 */
export type InternalProviderRuntime = {
  providerId: string;
  endpoint: URL;
  credentialReference: string;
};
