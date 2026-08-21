import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FileTextIcon, PlusIcon, SettingsIcon, SparklesIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import {
  buildProjectSkillTemplate,
  canCreateRootProjectInstructions,
  projectSkillPath,
  ROOT_PROJECT_INSTRUCTIONS_PATH,
  rootProjectSkillExists,
  validateProjectSkillContents,
  validateProjectSkillName,
} from "../../projectAgentConfig";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectAgentConfigQuery,
  useProjectFileQuery,
} from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ProjectAgentCheckout = Pick<
  SidebarProjectGroupMember,
  "environmentId" | "environmentLabel" | "workspaceRoot"
>;

type ProjectAgentEditorRequest =
  | {
      readonly kind: "instructions";
      readonly relativePath: string;
      readonly existing: boolean;
    }
  | {
      readonly kind: "skill";
      readonly relativePath: string | null;
      readonly existing: boolean;
      readonly skillName: string;
    };

function displayPath(path: string): string {
  return path.includes("/") ? path : `Project root · ${path}`;
}

function ProjectAgentFileDialog({
  checkout,
  request,
  existingSkillPaths,
  onClose,
  onSaved,
}: {
  checkout: ProjectAgentCheckout;
  request: ProjectAgentEditorRequest;
  existingSkillPaths: ReadonlySet<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNewSkill = request.kind === "skill" && !request.existing;
  const [skillName, setSkillName] = useState(request.kind === "skill" ? request.skillName : "");
  const [contents, setContents] = useState(() =>
    isNewSkill ? buildProjectSkillTemplate(request.skillName) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const fileQuery = useProjectFileQuery(
    checkout.environmentId,
    checkout.workspaceRoot,
    request.relativePath,
    request.existing,
  );

  useEffect(() => {
    if (!request.existing || !fileQuery.data) return;
    setContents(fileQuery.data.contents);
  }, [fileQuery.data, request.existing]);

  const title =
    request.kind === "instructions"
      ? request.existing
        ? "Edit project instructions"
        : "Add project instructions"
      : request.existing
        ? `Edit ${request.skillName}`
        : "Add project skill";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const trimmedName = skillName.trim();
    if (request.kind === "skill") {
      const nameError = validateProjectSkillName(trimmedName);
      if (nameError) {
        setError(nameError);
        return;
      }
      if (isNewSkill && rootProjectSkillExists(existingSkillPaths, trimmedName)) {
        setError(`A project skill already exists at ${projectSkillPath(trimmedName)}.`);
        return;
      }
      const contentsError = validateProjectSkillContents(contents, trimmedName);
      if (contentsError) {
        setError(contentsError);
        return;
      }
    } else if (contents.trim().length === 0) {
      setError("Project instructions cannot be empty.");
      return;
    }

    const relativePath =
      request.kind === "skill" && request.relativePath === null
        ? projectSkillPath(trimmedName)
        : request.relativePath;
    if (!relativePath) return;
    const expectedRevision = request.existing ? fileQuery.data?.revision : null;
    if (request.existing && !expectedRevision) {
      setError("The file revision is unavailable. Close and reopen this editor before saving.");
      return;
    }

    setIsSaving(true);
    try {
      const result = await writeFile({
        environmentId: checkout.environmentId,
        input: {
          cwd: checkout.workspaceRoot,
          relativePath,
          contents,
          expectedRevision,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : "Failed to save the project file.");
        }
        return;
      }

      setProjectFileQueryData(
        checkout.environmentId,
        checkout.workspaceRoot,
        relativePath,
        contents,
        result.value.revision,
      );
      confirmProjectFileQueryData(
        checkout.environmentId,
        checkout.workspaceRoot,
        relativePath,
        contents,
      );
      onSaved();
      toastManager.add({
        type: "success",
        title: request.kind === "skill" ? "Project skill saved" : "Project instructions saved",
        description: relativePath,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const unavailable =
    request.existing &&
    (fileQuery.isPending || fileQuery.data === null || fileQuery.data.truncated);
  const shownError =
    error ??
    fileQuery.error ??
    (fileQuery.data?.truncated
      ? "This file is larger than 1 MiB. T3 Code only loaded a preview and will not overwrite it."
      : null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Saved on {checkout.environmentLabel ?? "this environment"} in the selected checkout.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {request.kind === "skill" ? (
              <div className="space-y-1.5">
                <Label htmlFor="project-skill-name">Skill name</Label>
                <Input
                  id="project-skill-name"
                  autoFocus={isNewSkill}
                  disabled={request.existing}
                  placeholder="release-notes"
                  value={skillName}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setContents((current) =>
                      current === buildProjectSkillTemplate(skillName)
                        ? buildProjectSkillTemplate(nextName)
                        : current,
                    );
                    setSkillName(nextName);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Project skills live under <code>.agents/skills</code> and can be committed with
                  the repository.
                </p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="project-agent-file">Contents</Label>
              <Textarea
                id="project-agent-file"
                autoFocus={!isNewSkill}
                className="font-mono"
                disabled={unavailable}
                placeholder={fileQuery.isPending ? "Loading…" : undefined}
                size="lg"
                value={contents}
                onChange={(event) => setContents(event.target.value)}
              />
            </div>
            {shownError ? <p className="text-sm text-destructive">{shownError}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || unavailable}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function ProjectAgentSettings({ checkout }: { checkout: ProjectAgentCheckout }) {
  const configQuery = useProjectAgentConfigQuery(checkout.environmentId, checkout.workspaceRoot);
  const [editorRequest, setEditorRequest] = useState<ProjectAgentEditorRequest | null>(null);
  const instructionPaths = configQuery.data?.instructionPaths ?? [];
  const skills = configQuery.data?.skills ?? [];
  const skillPaths = new Set(skills.map((skill) => skill.path));
  const canAddRootInstructions = canCreateRootProjectInstructions(instructionPaths);

  return (
    <>
      <SettingsSection
        title="Project instructions"
        icon={<FileTextIcon className="size-4 text-muted-foreground" />}
        headerAction={
          canAddRootInstructions ? (
            <Button
              size="xs"
              variant="outline"
              disabled={configQuery.isPending || configQuery.error !== null}
              onClick={() =>
                setEditorRequest({
                  kind: "instructions",
                  relativePath: ROOT_PROJECT_INSTRUCTIONS_PATH,
                  existing: false,
                })
              }
            >
              <PlusIcon className="size-3.5" />
              Add instructions
            </Button>
          ) : null
        }
      >
        {configQuery.error ? (
          <p className="px-3 py-2 text-sm text-destructive sm:px-4">{configQuery.error}</p>
        ) : configQuery.isPending ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading instructions…</p>
        ) : instructionPaths.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            No project instructions configured for this checkout.
          </p>
        ) : (
          instructionPaths.map((path) => (
            <SettingsRow
              key={path}
              className="group py-2"
              title={<code className="font-mono font-normal">{displayPath(path)}</code>}
              description="Codex loads this file according to its directory scope and precedence."
              control={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${path}`}
                  onClick={() =>
                    setEditorRequest({ kind: "instructions", relativePath: path, existing: true })
                  }
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Project skills"
        icon={<SparklesIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={configQuery.isPending || configQuery.error !== null}
            onClick={() =>
              setEditorRequest({
                kind: "skill",
                relativePath: null,
                existing: false,
                skillName: "",
              })
            }
          >
            <PlusIcon className="size-3.5" />
            Add skill
          </Button>
        }
      >
        {configQuery.error ? (
          <p className="px-3 py-2 text-sm text-destructive sm:px-4">{configQuery.error}</p>
        ) : configQuery.isPending ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading skills…</p>
        ) : skills.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            No repository skills configured for this checkout.
          </p>
        ) : (
          skills.map((skill) => (
            <SettingsRow
              key={skill.path}
              className="group py-2"
              title={skill.name}
              description={<code className="font-mono text-xs">{skill.path}</code>}
              control={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${skill.name}`}
                  onClick={() =>
                    setEditorRequest({
                      kind: "skill",
                      relativePath: skill.path,
                      existing: true,
                      skillName: skill.name,
                    })
                  }
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      {editorRequest ? (
        <ProjectAgentFileDialog
          key={`${editorRequest.kind}:${editorRequest.relativePath ?? "new"}`}
          checkout={checkout}
          request={editorRequest}
          existingSkillPaths={skillPaths}
          onClose={() => setEditorRequest(null)}
          onSaved={configQuery.refresh}
        />
      ) : null}
    </>
  );
}
