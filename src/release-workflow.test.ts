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
    const scannerStep = releaseWorkflow.slice(scannerInstall, dependencyInstall);

    expect(scannerInstall).toBeGreaterThan(-1);
    expect(scannerInstall).toBeLessThan(dependencyInstall);
    expect(scannerInstall).toBeLessThan(changesetsAction);

    expect(releaseWorkflow).toContain(
      'base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"',
    );
    expect(scannerStep).toContain(
      'tool_dir="$(mktemp -d "${RUNNER_TEMP}/ferry-gitleaks.XXXXXX")"',
    );
    expect(scannerStep).toContain('archive="${tool_dir}/gitleaks.tgz"');
    expect(scannerStep).toContain(
      'checksums="${tool_dir}/gitleaks_checksums.txt"',
    );
    expect(scannerStep).toContain(
      'curl -fsSL -o "${archive}" "${base}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
    );
    expect(scannerStep).toContain(
      'curl -fsSL -o "${checksums}" "${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"',
    );
    expect(scannerStep).toContain('"${checksums}" | sha256sum -c -');
    expect(scannerStep).toContain(
      'tar -xzf "${archive}" -C /usr/local/bin gitleaks',
    );
    expect(scannerStep).toContain("gitleaks version");

    // changesets/action stages the whole worktree with `git add .`. Keeping
    // every downloaded tool artifact under RUNNER_TEMP ensures the generated
    // Version Packages commit cannot accidentally include either file.
    expect(scannerStep).not.toMatch(/curl[^\n]+-o\s+gitleaks(?:\.tgz|_checksums\.txt)/);
    expect(scannerStep).not.toMatch(/tar\s+-xzf\s+gitleaks\.tgz/);
    expect(scannerStep).not.toContain("${GITHUB_WORKSPACE}");
    expect(scannerStep).not.toMatch(/--no-verify|HUSKY=0|SKIP_GITLEAKS/);
  });
});
