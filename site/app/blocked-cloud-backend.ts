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
export default BlockedCloudBackend;
