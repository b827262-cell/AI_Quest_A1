import { useState } from "react";

/** Page-wide status channel shared by every Provider/Credential section. */
export type AdminStatus = {
  error: string;
  message: string;
  busy: boolean;
  setError: (value: string) => void;
  setMessage: (value: string) => void;
  setBusy: (value: boolean) => void;
};

export function useAdminStatus(): AdminStatus {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return { error, message, busy, setError, setMessage, setBusy };
}
