// ABOUTME: Contract tests for the concise cargo-audit JSON reporter.
// ABOUTME: Covers patched/unpatched rows, URLs, package specs, and malformed reports.
import { describe, expect, test } from "bun:test";
import { formatAuditReport, listVulnerablePackageSpecs, parseAuditReport } from "./cargo-audit-report";

const QUICK_XML_TITLE = "Quadratic run time when checking a start tag for duplicate attribute names";
const RSA_TITLE = "Marvin Attack: potential key recovery through timing sidechannels";
const QUICK_XML_URL = "https://rustsec.org/advisories/RUSTSEC-2026-0194.html";
const RSA_URL = "https://rustsec.org/advisories/RUSTSEC-2023-0071.html";

const MIXED_AUDIT_FIXTURE = {
  vulnerabilities: {
    list: [
      {
        advisory: {
          id: "RUSTSEC-2026-0194",
          title: QUICK_XML_TITLE,
          url: QUICK_XML_URL,
        },
        package: {
          name: "quick-xml",
          version: "0.30.0",
        },
        versions: {
          patched: [">=0.41.0"],
        },
      },
      {
        advisory: {
          id: "RUSTSEC-2023-0071",
          title: RSA_TITLE,
          url: RSA_URL,
        },
        package: {
          name: "rsa",
          version: "0.9.10",
        },
        versions: {
          patched: [],
        },
      },
    ],
  },
};

describe("cargo-audit-report", () => {
  test("formats patched and unpatched vulnerability rows", () => {
    const output = formatAuditReport(MIXED_AUDIT_FIXTURE);
    expect(output.startsWith("ID\tPackage\tTitle\tPatched\tURL\n")).toBe(true);
    expect(output).toContain(`RUSTSEC-2026-0194\tquick-xml 0.30.0\t${QUICK_XML_TITLE}\t>=0.41.0\t${QUICK_XML_URL}`);
    expect(output).toContain(`RUSTSEC-2023-0071\trsa 0.9.10\t${RSA_TITLE}\tUNPATCHED\t${RSA_URL}`);
    expect(output).not.toContain("SECRET_DESCRIPTION_BODY");
  });

  test("omits advisory descriptions from the concise table", () => {
    const output = formatAuditReport({
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: "RUSTSEC-2026-0194",
              title: QUICK_XML_TITLE,
              url: QUICK_XML_URL,
              description: "SECRET_DESCRIPTION_BODY",
            },
            package: {
              name: "quick-xml",
              version: "0.30.0",
            },
            versions: {
              patched: [">=0.41.0"],
            },
          },
        ],
      },
    });
    expect(output).not.toContain("SECRET_DESCRIPTION_BODY");
    expect(output).toContain(">=0.41.0");
  });

  test("lists unique package@version specs in first-seen order", () => {
    expect(listVulnerablePackageSpecs(MIXED_AUDIT_FIXTURE)).toEqual(["quick-xml@0.30.0", "rsa@0.9.10"]);
  });

  test("rejects malformed reports", () => {
    try {
      parseAuditReport("{");
      expect.unreachable("expected parseAuditReport to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("malformed cargo-audit JSON");
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
    expect(() => formatAuditReport({})).toThrow("missing vulnerabilities.list");
    expect(() =>
      formatAuditReport({
        vulnerabilities: {
          list: [
            {
              advisory: { id: "RUSTSEC-2026-0194" },
              package: { name: "quick-xml", version: "0.30.0" },
            },
          ],
        },
      }),
    ).toThrow("missing vulnerabilities.list[0].advisory.title");
  });
});
