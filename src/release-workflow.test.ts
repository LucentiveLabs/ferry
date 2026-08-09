import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/release.yml"),
  "utf8",
);
const securityWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/security-gate.yml"),
  "utf8",
);

function gitleaksVersion(workflow: string): string | undefined {
  return workflow.match(/^  GITLEAKS_VERSION: "([^"]+)"$/m)?.[1];
}

describe("release workflow security prerequisites", () => {
  it("installs the checksum-verified pinned gitleaks binary before a hook can commit", () => {
    expect(gitleaksVersion(releaseWorkflow)).toBe("8.30.1");
    expect(gitleaksVersion(releaseWorkflow)).toBe(gitleaksVersion(securityWorkflow));

    const scannerInstall = releaseWorkflow.indexOf(
      "- name: Install gitleaks for the commit hook",
    );
    const dependencyInstall = releaseWorkflow.indexOf("- name: Install dependencies");
    const changesetsAction = releaseWorkflow.indexOf(
      "- name: Create Release PR or Publish to npm",
    );

    expect(scannerInstall).toBeGreaterThan(-1);
    expect(scannerInstall).toBeLessThan(dependencyInstall);
    expect(scannerInstall).toBeLessThan(changesetsAction);

    expect(releaseWorkflow).toContain(
      'base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"',
    );
    expect(releaseWorkflow).toContain(
      'curl -fsSL -o gitleaks.tgz "${base}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
    );
    expect(releaseWorkflow).toContain(
      'curl -fsSL -o gitleaks_checksums.txt "${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"',
    );
    expect(releaseWorkflow).toContain(
      "gitleaks_checksums.txt | sha256sum -c -",
    );
    expect(releaseWorkflow).toContain(
      "tar -xzf gitleaks.tgz -C /usr/local/bin gitleaks",
    );
    expect(releaseWorkflow).toContain("gitleaks version");
    expect(releaseWorkflow).not.toMatch(/--no-verify|HUSKY=0|SKIP_GITLEAKS/);
  });
});
