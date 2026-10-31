import { useEffect, useState } from "react";
import { studentClient, type PublicSiteConfig } from "../../studentClient";
import { DEFAULT_CONFIG } from "./constants";

export function usePublicSiteConfig(): PublicSiteConfig {
  const [config, setConfig] = useState<PublicSiteConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let active = true;
    studentClient
      .getPublicSiteConfig()
      .then((next) => active && setConfig({ ...DEFAULT_CONFIG, ...next }))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return config;
}
