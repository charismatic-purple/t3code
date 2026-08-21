// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

import type {
  ProjectAgentConfigListInput,
  ProjectAgentConfigListResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
const PROJECT_READ_CHUNK_BYTES = 64 * 1024;
const AGENT_CONFIG_IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

function contentRevision(contents: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

export class WorkspaceAgentConfigListError extends Schema.TaggedErrorClass<WorkspaceAgentConfigListError>()(
  "WorkspaceAgentConfigListError",
  {
    workspaceRoot: Schema.String,
    operationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to discover project agent configuration in '${this.workspaceRoot}' at '${this.operationPath}'.`;
  }
}

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspaceFileConflictError extends Schema.TaggedErrorClass<WorkspaceFileConflictError>()(
  "WorkspaceFileConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    expectedRevision: Schema.NullOr(Schema.String),
    actualRevision: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.expectedRevision === null
      ? `Workspace file '${this.relativePath}' already exists in '${this.workspaceRoot}'.`
      : `Workspace file '${this.relativePath}' changed after it was opened.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceFileConflictError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Discover project instructions and repository skills without search-index filtering. */
    readonly listAgentConfig: (
      input: ProjectAgentConfigListInput,
    ) => Effect.Effect<ProjectAgentConfigListResult, WorkspaceAgentConfigListError>;
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const listAgentConfig: WorkspaceFileSystem["Service"]["listAgentConfig"] = Effect.fn(
    "WorkspaceFileSystem.listAgentConfig",
  )(function* (input) {
    const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceAgentConfigListError({
            workspaceRoot: input.cwd,
            operationPath: input.cwd,
            cause,
          }),
      ),
    );
    return yield* Effect.tryPromise({
      try: async () => {
        const instructionPaths: string[] = [];
        const skills: Array<{ name: string; path: string }> = [];
        const visit = async (absoluteDirectory: string, relativeDirectory: string) => {
          const entries = await NodeFSP.readdir(absoluteDirectory, { withFileTypes: true });
          for (const entry of entries) {
            const relativePath = relativeDirectory
              ? `${relativeDirectory}/${entry.name}`
              : entry.name;
            if (entry.isDirectory()) {
              if (!AGENT_CONFIG_IGNORED_DIRECTORIES.has(entry.name)) {
                await visit(path.join(absoluteDirectory, entry.name), relativePath);
              }
              continue;
            }
            if (!entry.isFile()) continue;
            if (entry.name === "AGENTS.md" || entry.name === "AGENTS.override.md") {
              instructionPaths.push(relativePath);
            }
            const skillMatch = /(?:^|\/)\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(relativePath);
            if (skillMatch?.[1]) {
              skills.push({ name: skillMatch[1], path: relativePath });
            }
          }
        };
        await visit(workspaceRoot, "");
        return {
          instructionPaths: instructionPaths.toSorted((left, right) => {
            const depth = left.split("/").length - right.split("/").length;
            return depth || left.localeCompare(right);
          }),
          skills: skills.toSorted(
            (left, right) =>
              left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
          ),
        };
      },
      catch: (cause) =>
        new WorkspaceAgentConfigListError({
          workspaceRoot,
          operationPath:
            cause && typeof cause === "object" && "path" in cause && typeof cause.path === "string"
              ? cause.path
              : workspaceRoot,
          cause,
        }),
    });
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const readResult = yield* Effect.tryPromise({
            try: async () => {
              const bytesToPreview = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
              const preview = Buffer.alloc(bytesToPreview);
              const hash = NodeCrypto.createHash("sha256");
              let position = 0;
              let previewBytesRead = 0;
              let containsNull = false;
              while (position < stat.size) {
                const chunk = Buffer.allocUnsafe(
                  Math.min(PROJECT_READ_CHUNK_BYTES, stat.size - position),
                );
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
                if (bytesRead === 0) break;
                const bytes = chunk.subarray(0, bytesRead);
                hash.update(bytes);
                containsNull ||= bytes.includes(0);
                if (previewBytesRead < bytesToPreview) {
                  const copyLength = Math.min(bytesRead, bytesToPreview - previewBytesRead);
                  bytes.copy(preview, previewBytesRead, 0, copyLength);
                  previewBytesRead += copyLength;
                }
                position += bytesRead;
              }
              return {
                preview: preview.subarray(0, previewBytesRead),
                revision: hash.digest("hex"),
                containsNull,
              };
            },
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          if (readResult.containsNull) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(readResult.preview),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
            revision: readResult.revision,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    const revision = contentRevision(input.contents);
    if (input.expectedRevision !== undefined) {
      const actualRevision = yield* Effect.tryPromise({
        try: async () => {
          try {
            return contentRevision(await NodeFSP.readFile(target.absolutePath));
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "read",
            cause,
          }),
      });
      if (actualRevision !== input.expectedRevision) {
        return yield* new WorkspaceFileConflictError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          expectedRevision: input.expectedRevision,
          actualRevision,
        });
      }
    }
    yield* Effect.tryPromise({
      try: () =>
        NodeFSP.writeFile(target.absolutePath, input.contents, {
          flag: input.expectedRevision === null ? "wx" : "w",
        }),
      catch: (cause) =>
        input.expectedRevision === null && (cause as NodeJS.ErrnoException).code === "EEXIST"
          ? new WorkspaceFileConflictError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              expectedRevision: null,
              actualRevision: null,
            })
          : new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              operationPath: target.absolutePath,
              operation: "write-file",
              cause,
            }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath, revision };
  });

  return WorkspaceFileSystem.of({ listAgentConfig, readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
