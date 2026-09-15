import { handleRunGet, jsonError } from "../../_shared";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return await handleRunGet(request, (await context.params).id); } catch (error) { return jsonError(error, 500); }
}
