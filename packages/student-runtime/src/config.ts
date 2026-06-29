export type StudentRuntimeMode = "static" | "sqlite-api" | "remote-api";
export type StudentChatMode = "keyword" | "remote";

export interface StudentRuntimeConfig {
  mode: StudentRuntimeMode;
  dbPath: string;
  apiPort: number;
  publicDir: string;
  readonlyMode: boolean;
  chatMode: StudentChatMode;
  /** Root directory containing per-book PDF uploads. */
  uploadDir: string;
  /** Base URL of the admin API, used only in remote-api mode. */
  remoteApiBaseUrl?: string;
}

export function loadStudentRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): StudentRuntimeConfig {
  return {
    mode: (env.STU_RUNTIME_MODE as StudentRuntimeMode) || "sqlite-api",
    dbPath: env.STU_DB_PATH || "/opt/AI-Stu-R1/data/student.db",
    apiPort: Number(env.STU_API_PORT || 4310),
    publicDir: env.STU_PUBLIC_DIR || "/opt/AI-Stu-R1/dist",
    readonlyMode: env.STU_READONLY_MODE !== "false",
    chatMode: (env.STU_CHAT_MODE as StudentChatMode) || "keyword",
    uploadDir: env.STU_UPLOAD_DIR || env.UPLOAD_DIR || "/opt/AI-Stu-R1/uploads/books",
    remoteApiBaseUrl: env.STU_REMOTE_API_BASE_URL || undefined
  };
}
