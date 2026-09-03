# Manage project settings

Open **Settings**, select **Projects**, then select a project. Settings that belong to files on disk
apply to the checkout selected on that page. When the checkout belongs to a remote environment, T3
Code reads and writes the files on that environment.

## Project instructions

Under **Project instructions**, create or edit Codex `AGENTS.md` and `AGENTS.override.md` files.
Nested instruction files appear with their project-relative paths so you can see which directory
scope they belong to. New instructions are created as `AGENTS.md` at the project root.

## Project skills

Under **Project skills**, create or edit repository skills. New skills are stored at
`.agents/skills/<skill-name>/SKILL.md` and can be committed with the rest of the repository. Skill
names use lowercase letters, numbers, and hyphens. T3 Code validates the required `name` and
`description` frontmatter before saving.

T3 Code prevents a save when the file changed after you opened it, and it will not overwrite files
that are too large to load completely. Reopen a changed file before applying your edits again.

## Project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files. If it does not find an image, it chooses a built-in
icon from the project name.

To choose a different icon or emoji:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Next to **Project icon**, select **Choose icon**.
4. Search the full Lucide icon set and choose a color, or switch to **Emoji** and choose or paste
   an emoji.

To use an image from the project instead, select **Choose file**, search for an image, and select
it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Keep the default branch current

Turn on **Automatically pull** in a project's settings to keep its default-branch checkout current.
T3 Code checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.
