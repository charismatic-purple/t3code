import { parseDocument } from "yaml";

export const ROOT_PROJECT_INSTRUCTIONS_PATH = "AGENTS.md";
export const ROOT_PROJECT_INSTRUCTIONS_OVERRIDE_PATH = "AGENTS.override.md";
export const PROJECT_SKILLS_ROOT = ".agents/skills";

const PROJECT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateProjectSkillName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a skill name.";
  if (!PROJECT_SKILL_NAME_PATTERN.test(trimmed)) {
    return "Use lowercase letters, numbers, and single hyphens.";
  }
  return null;
}

export function projectSkillPath(name: string): string {
  return `${PROJECT_SKILLS_ROOT}/${name.trim()}/SKILL.md`;
}

export function canCreateRootProjectInstructions(paths: ReadonlyArray<string>): boolean {
  return (
    !paths.includes(ROOT_PROJECT_INSTRUCTIONS_PATH) &&
    !paths.includes(ROOT_PROJECT_INSTRUCTIONS_OVERRIDE_PATH)
  );
}

export function rootProjectSkillExists(paths: ReadonlySet<string>, name: string): boolean {
  return paths.has(projectSkillPath(name));
}

export function buildProjectSkillTemplate(name: string): string {
  const normalizedName = name.trim() || "skill-name";
  return `---\nname: ${normalizedName}\ndescription: Describe when Codex should use this skill.\n---\n\nAdd the instructions Codex should follow.\n`;
}

export function validateProjectSkillContents(
  contents: string,
  expectedName: string,
): string | null {
  const boundary = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(contents);
  if (!boundary?.[1]) return "SKILL.md must start with YAML frontmatter.";

  const document = parseDocument(boundary[1]);
  if (document.errors.length > 0) return "SKILL.md frontmatter must be valid YAML.";
  const metadata: unknown = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "SKILL.md frontmatter must be a YAML mapping.";
  }
  const values = metadata as Record<string, unknown>;
  const declaredName = typeof values.name === "string" ? values.name.trim() : null;
  if (declaredName !== expectedName) {
    return `The frontmatter name must be ${expectedName}.`;
  }
  const description = typeof values.description === "string" ? values.description.trim() : null;
  if (!description) return "Add a description to the skill frontmatter.";
  return null;
}
