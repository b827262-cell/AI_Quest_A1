import { handleBatch, jsonError } from "../_shared";

export async function POST(request: Request) {
  try { return await handleBatch(request, "progress"); } catch (error) { return jsonError(error, 500); }
}
