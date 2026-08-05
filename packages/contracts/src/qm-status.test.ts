import { describe, it, expect } from "vitest";
import {
  qmSystemStatusSchema,
  qmContractClauseSchema,
  qmDoctorResultSchema,
  qmDoctorBlockerSchema,
  deriveOverallStatus
} from "./qm-status";

describe("qm-status schemas", () => {
  it("qmSystemStatusSchema parses valid data", () => {
    const data = {
      state: "ready",
      overallStatus: "pass",
      checkedAt: "2026-08-04T12:00:00Z",
      qmCliVersion: "1.0.0",
      contract: {
        valid: true,
        version: 1,
        clauses: {}
      },
      doctor: {
        status: "pass",
        exitCode: 0,
        blockers: [],
        message: null
      },
      smoke: {
        status: "pass",
        checkedAt: "2026-08-04T12:00:00Z",
        message: null
      }
    };
    const parsed = qmSystemStatusSchema.parse(data);
    expect(parsed).toEqual(data);
  });

  it("qmSystemStatusSchema rejects invalid overallStatus", () => {
    const data = {
      state: "ready",
      overallStatus: "invalid_status",
      checkedAt: "2026-08-04T12:00:00Z",
      qmCliVersion: "1.0.0",
      contract: { valid: true, version: 1, clauses: {} },
      doctor: { status: "pass", exitCode: 0, blockers: [], message: null },
      smoke: { status: "pass", checkedAt: "2026-08-04T12:00:00Z", message: null }
    };
    expect(() => qmSystemStatusSchema.parse(data)).toThrow();
  });

  it("qmContractClauseSchema accepts valid clause", () => {
    const data = {
      status: "pass",
      warnings: ["warn1"],
      count: 5
    };
    expect(qmContractClauseSchema.parse(data)).toEqual(data);
  });

  it("qmDoctorResultSchema validates properly", () => {
    const data = {
      status: "blocked",
      exitCode: 1,
      blockers: [
        {
          category: "tool",
          code: "missing_tool",
          name: "docker",
          message: "docker is missing",
          remediation: "Install docker"
        }
      ],
      message: "missing docker"
    };
    expect(qmDoctorResultSchema.parse(data)).toEqual(data);
  });

  it("qmDoctorBlockerSchema validates credential blocker", () => {
    const data = {
      category: "credential",
      code: "missing_or_placeholder",
      names: ["SECRET_KEY"],
      message: "Missing key",
      remediation: "Set it privately"
    };
    expect(qmDoctorBlockerSchema.parse(data)).toEqual(data);
  });

  it("qmDoctorBlockerSchema validates tool blocker", () => {
    const data = {
      category: "tool",
      code: "missing_tool",
      name: "flyctl",
      message: "Missing tool",
      remediation: "Install tool"
    };
    expect(qmDoctorBlockerSchema.parse(data)).toEqual(data);
  });

  it("qmDoctorBlockerSchema rejects invalid category", () => {
    const data = {
      category: "invalid_category",
      code: "missing_tool",
      name: "flyctl",
      message: "Missing tool"
    };
    expect(() => qmDoctorBlockerSchema.parse(data)).toThrow();
  });
});

describe("deriveOverallStatus", () => {
  it("returns pass when contract valid + doctor pass + smoke pass", () => {
    expect(deriveOverallStatus(
      { valid: true, version: 1, clauses: {} },
      { status: "pass", exitCode: 0, blockers: [], message: null },
      { status: "pass", checkedAt: null, message: null }
    )).toBe("pass");
  });

  it("returns warning when doctor blocked", () => {
    expect(deriveOverallStatus(
      { valid: true, version: 1, clauses: {} },
      { status: "blocked", exitCode: 1, blockers: [], message: null },
      { status: "pass", checkedAt: null, message: null }
    )).toBe("warning");
  });

  it("returns fail when doctor fails", () => {
    expect(deriveOverallStatus(
      { valid: true, version: 1, clauses: {} },
      {
        status: "fail",
        exitCode: -1,
        blockers: [{
          category: "unknown",
          code: "doctor_failed",
          message: "safe failure",
          remediation: "Inspect server logs"
        }],
        message: "safe failure"
      },
      { status: "pass", checkedAt: null, message: null }
    )).toBe("fail");
  });

  it("returns pass when smoke not_run + contract valid + doctor pass", () => {
    expect(deriveOverallStatus(
      { valid: true, version: 1, clauses: {} },
      { status: "pass", exitCode: 0, blockers: [], message: null },
      { status: "not_run", checkedAt: null, message: null }
    )).toBe("pass");
  });

  it("returns fail when contract invalid", () => {
    expect(deriveOverallStatus(
      { valid: false, version: 1, clauses: {} },
      { status: "pass", exitCode: 0, blockers: [], message: null },
      { status: "pass", checkedAt: null, message: null }
    )).toBe("fail");
  });

  it("returns warning when smoke fail", () => {
    expect(deriveOverallStatus(
      { valid: true, version: 1, clauses: {} },
      { status: "pass", exitCode: 0, blockers: [], message: null },
      { status: "fail", checkedAt: null, message: null }
    )).toBe("warning");
  });
});
