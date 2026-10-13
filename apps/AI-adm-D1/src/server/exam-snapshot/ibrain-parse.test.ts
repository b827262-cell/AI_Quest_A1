import { describe, expect, it } from "vitest";
import { buildCourseRecord, deriveCategory } from "./ibrain-parse";

describe("ibrain course category parsing", () => {
  it.each(["高普考行政法", "高考財稅行政", "普考會計"])("normalizes %s to the 高普考 contract", (courseName) => {
    expect(deriveCategory(courseName)).toBe("高普考");
  });

  it("emits 高普考 for a published 普考 course", () => {
    const record = buildCourseRecord({
      html: "<title>116 普考 會計學, ibrain知識達購課館</title><table><tr><td>【品號】</td><td>IPPP001</td></tr></table>",
      url: "https://ec.ibrain.com.tw/book.asp?bkid=1",
      fetchedAt: "2026-10-04T00:00:00.000Z"
    });

    expect(record).toMatchObject({ category: "高普考", exam_year: 116, course_code: "IPPP001" });
  });
});
