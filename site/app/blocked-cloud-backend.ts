// Cloud AI backends (Firebase, Gemini, OpenAI) are strictly forbidden in this application.
// Only local inference (browser native LanguageModel or Transformers.js local backend) is permitted.
// Any attempt to resolve or instantiate a cloud backend fails closed.

export class BlockedCloudBackend {
  constructor() {
    throw new Error("Cloud AI backend is forbidden in this application. Only local inference is supported.");
  }
  static async availability() {
    return "unavailable";
  }
  static createSession() {
    throw new Error("Cloud AI backend is forbidden in this application. Only local inference is supported.");
  }
}

export const GoogleGenAI = BlockedCloudBackend;
export const OpenAI = BlockedCloudBackend;

// Vite may statically analyze optional prompt-api-polyfill cloud backends even
// though this application never selects them. Export fail-closed stubs for the
// symbols those optional modules import so dependency optimization can finish
// without making any cloud backend usable.
export const initializeApp = (..._args: unknown[]) => {
  void _args;
  throw new Error("Cloud AI backend is forbidden in this application.");
};
export const ReCaptchaEnterpriseProvider = BlockedCloudBackend;
export const initializeAppCheck = (..._args: unknown[]) => {
  void _args;
  throw new Error("Cloud AI backend is forbidden in this application.");
};
export const GoogleAIBackend = BlockedCloudBackend;
export const VertexAIBackend = BlockedCloudBackend;
export const InferenceMode = Object.freeze({ ONLY_IN_CLOUD: "BLOCKED" });
export const getAI = (..._args: unknown[]) => {
  void _args;
  throw new Error("Cloud AI backend is forbidden in this application.");
};
export const getGenerativeModel = (..._args: unknown[]) => {
  void _args;
  throw new Error("Cloud AI backend is forbidden in this application.");
};
export const CreateMLCEngine = (..._args: unknown[]) => {
  void _args;
  throw new Error("Cloud AI backend is forbidden in this application.");
};
export const hasModelInCache = async (..._args: unknown[]) => {
  void _args;
  return false;
};
export const prebuiltAppConfig = Object.freeze({});

export default BlockedCloudBackend;
