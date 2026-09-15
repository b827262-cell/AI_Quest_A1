import { handleCommit, jsonError } from "../_shared";

export async function POST(request: Request) {
  try { return await handleCommit(request); } catch (error) { return jsonError(error, 500); }
}
