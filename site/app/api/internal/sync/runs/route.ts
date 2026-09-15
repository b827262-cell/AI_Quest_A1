import { handleRun, jsonError } from "../_shared";

export async function POST(request: Request) {
  try { return await handleRun(request); } catch (error) { return jsonError(error, 500); }
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
