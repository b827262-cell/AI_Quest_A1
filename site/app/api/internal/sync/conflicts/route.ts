import { handleConflicts, jsonError } from "../_shared";

export async function GET(request: Request) {
  try { return await handleConflicts(request); } catch (error) { return jsonError(error, 500); }
}
