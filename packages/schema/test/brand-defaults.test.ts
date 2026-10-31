import { describe, expect, it } from "vitest";
import { appearanceSettingsSchema } from "../src/appearance.schema";
import { siteConfigSchema } from "../src/siteConfig.schema";

describe("brand defaults", () => {
  it("uses iBrain AI for the site and appearance brand defaults", () => {
    expect(siteConfigSchema.parse({}).siteTitle).toBe("iBrain AI");
    const appearance = appearanceSettingsSchema.parse({});
    expect(appearance.systemName).toBe("iBrain AI");
    expect(appearance.studentHeaderBrandText).toBe("iBrain AI");
  });
});
