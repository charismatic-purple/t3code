import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectSkillTemplate,
  canCreateRootProjectInstructions,
  projectSkillPath,
  rootProjectSkillExists,
  validateProjectSkillContents,
  validateProjectSkillName,
} from "./projectAgentConfig";

describe("project agent configuration", () => {
  it("validates names and builds a valid starter skill", () => {
    expect(validateProjectSkillName("release-notes")).toBeNull();
    expect(validateProjectSkillName("Release Notes")).toBeTruthy();
    expect(projectSkillPath("release-notes")).toBe(".agents/skills/release-notes/SKILL.md");
    expect(buildProjectSkillTemplate("release-notes")).toContain("name: release-notes");
    expect(
      validateProjectSkillContents(buildProjectSkillTemplate("release-notes"), "release-notes"),
    ).toBeNull();
    expect(validateProjectSkillContents("# Missing frontmatter", "release-notes")).toBeTruthy();
  });

  it("parses YAML frontmatter instead of approximating it with field regexes", () => {
    expect(
      validateProjectSkillContents(
        '---\nname: "release-notes" # quoted names and comments are valid\ndescription: >\n  Prepare polished release notes.\n---\n',
        "release-notes",
      ),
    ).toBeNull();
    expect(
      validateProjectSkillContents(
        "---\nname: release-notes\ndescription: |\n\n---\n",
        "release-notes",
      ),
    ).toBe("Add a description to the skill frontmatter.");
    expect(
      validateProjectSkillContents(
        "---\nname: [invalid\ndescription: broken\n---\n",
        "release-notes",
      ),
    ).toBe("SKILL.md frontmatter must be valid YAML.");
  });

  it("respects root overrides and allows the same skill name in another scope", () => {
    expect(canCreateRootProjectInstructions(["packages/api/AGENTS.md"])).toBe(true);
    expect(canCreateRootProjectInstructions(["AGENTS.override.md"])).toBe(false);
    expect(
      rootProjectSkillExists(new Set(["packages/api/.agents/skills/review/SKILL.md"]), "review"),
    ).toBe(false);
    expect(rootProjectSkillExists(new Set([".agents/skills/review/SKILL.md"]), "review")).toBe(
      true,
    );
  });
});
