/// <reference types="vite/client" />
declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_STUDENT_API_ORIGIN?: string;
  readonly VITE_ADMIN_API_ORIGIN?: string;
  readonly VITE_FLOW_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
