"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useDropMenu } from "./chain-ui";
import {
  deleteProject,
  exportUrl,
  importProject,
  listProjects,
  loadProject,
  renameProject,
  saveAsProject,
  saveProject,
} from "./api-client";
import { queryKeys } from "./queries";
import type { LooperState, ProjectList, ProjectSummary } from "@myass/protocol";
import styles from "./projects.module.css";

type DialogMode = "open" | "saveAs" | "rename" | "import" | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString();
}

function statusLabel(projects: ProjectList | undefined): string {
  if (!projects) {
    return "";
  }

  if (projects.busy === "autosave") {
    return "Saving…";
  }

  if (projects.busy === "load") {
    return "Loading…";
  }

  if (projects.busy === "import") {
    return "Importing…";
  }

  if (projects.busy === "export") {
    return "Exporting…";
  }

  if (projects.dirty) {
    return "Unsaved changes";
  }

  if (projects.linkedProjectId) {
    const linked = projects.projects.find(
      (project) => project.id === projects.linkedProjectId,
    );

    return `Saved to ${linked?.name ?? "project"}`;
  }

  if (projects.status === "agentOffline") {
    return "Agent offline - showing last save";
  }

  return "";
}

function dotClass(projects: ProjectList | undefined): string {
  if (!projects) {
    return styles.dotLive;
  }

  if (projects.busy) {
    return styles.dotBusy;
  }

  if (projects.status === "agentOffline") {
    return styles.dotDown;
  }

  if (projects.dirty) {
    return styles.dotBusy;
  }

  return styles.dotLive;
}

export function ProjectsBar({
  state,
  projects,
  onOpenDialog,
}: {
  state: LooperState | undefined;
  projects: ProjectList | undefined;
  onOpenDialog: (mode: DialogMode) => void;
}) {
  const queryClient = useQueryClient();
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const { geometry, setGeometry, open, toggle } = useDropMenu(exportTriggerRef);

  const saveMutation = useMutation({
    mutationFn: () => saveProject(projects!.linkedProjectId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });

  const linkedName = projects?.linkedProjectId
    ? (projects.projects.find((project) => project.id === projects.linkedProjectId)
        ?.name ?? null)
    : null;

  const busy = projects?.busy != null;

  return (
    <div className={styles.projectsBar}>
      <span className={`${styles.statusDot} ${dotClass(projects)}`} />
      <span className={styles.mainLabel}>
        Working session - {linkedName ?? "unsaved"}
      </span>
      {statusLabel(projects) && (
        <span className={styles.statusLabel}>{statusLabel(projects)}</span>
      )}

      <div className={styles.projectButtons}>
        <button
          className={styles.button}
          disabled={!projects?.linkedProjectId || busy || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          title={
            !projects?.linkedProjectId
              ? "Nothing linked yet - use SAVE AS"
              : undefined
          }
        >
          SAVE
        </button>
        <button
          className={styles.button}
          disabled={busy}
          onClick={() => onOpenDialog("saveAs")}
        >
          SAVE AS
        </button>
        <button
          className={styles.button}
          disabled={busy}
          onClick={() => onOpenDialog("open")}
        >
          OPEN
        </button>
        <button
          className={styles.button}
          disabled={busy}
          onClick={() => onOpenDialog("import")}
        >
          IMPORT
        </button>

        <div className={styles.exportWrapper}>
          {open && (
            <div
              className={styles.scrim}
              onClick={() => setGeometry(null)}
            />
          )}
          <button
            ref={exportTriggerRef}
            className={styles.button}
            onClick={toggle}
            disabled={busy}
            aria-expanded={open}
            aria-haspopup="true"
          >
            EXPORT ▾
          </button>
          {geometry && (
            <div
              className={styles.menu}
              style={{
                left: geometry.left,
                top: geometry.top,
                bottom: geometry.bottom,
                maxHeight: geometry.maxHeight,
                width: 220,
              }}
            >
              <a
                className={styles.menuItem}
                href={exportUrl("working", "fl")}
                download
                onClick={() => setGeometry(null)}
              >
                FL Studio stems
                <span className={styles.menuDescription}>
                  processed, dry, mix, README
                </span>
              </a>
              <a
                className={styles.menuItem}
                href={exportUrl("working", "bundle")}
                download
                onClick={() => setGeometry(null)}
              >
                Project bundle
                <span className={styles.menuDescription}>
                  re-upload to continue
                </span>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProjectDialogs({
  mode,
  setMode,
  highlightId,
  setHighlightId,
  state,
  projects,
  onCancelPendingApply,
  setStatusMessage,
}: {
  mode: DialogMode;
  setMode: (mode: DialogMode) => void;
  highlightId: string | null;
  setHighlightId: (id: string | null) => void;
  state: LooperState | undefined;
  projects: ProjectList | undefined;
  onCancelPendingApply?: () => void;
  setStatusMessage: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [saveName, setSaveName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mode === "saveAs") {
      setSaveName(`My loop ${(projects?.projects.length ?? 0) + 1}`);
    }

    if (mode === "rename" && renameTarget) {
      setRenameName(renameTarget.name);
    }

    if (mode === "import") {
      setDeleteConfirmId(null);
    }

    setDeleteConfirmId(null);
  }, [mode, projects?.projects.length, renameTarget]);

  useEffect(() => {
    if (!mode || !dialogRef.current) {
      return;
    }

    const dialog = dialogRef.current;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button, input, select, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    );

    focusable[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMode(null);
        return;
      }

      if (event.key !== "Tab" || focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mode]);

  const loadMutation = useMutation({
    mutationFn: loadProject,
    onSuccess: (result, id) => {
      onCancelPendingApply?.();
      queryClient.setQueryData(queryKeys.looper, result.state);
      void queryClient.invalidateQueries({ queryKey: queryKeys.chain });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setMode(null);
      const name =
        projects?.projects.find((project) => project.id === id)?.name ??
        (id === "working" ? "Working session" : id);
      setStatusMessage(`Loaded ${name}. Transport is paused.`);
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const saveAsMutation = useMutation({
    mutationFn: saveAsProject,
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setMode(null);
      setStatusMessage(`Saved as ${project.name}.`);
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameProject(id, name),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setMode(null);
      setStatusMessage(`Renamed to ${project.name}.`);
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setDeleteConfirmId(null);
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const importMutation = useMutation({
    mutationFn: importProject,
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setHighlightId(project.id);
      setMode("open");
      setStatusMessage(`Imported ${project.name}.`);
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    },
  });

  if (!mode || !mounted) {
    return null;
  }

  const busy = projects?.busy != null;
  const recording =
    state?.layers.some((layer) => layer.recording || layer.waiting) ?? false;
  const loadDisabled =
    busy ||
    recording ||
    projects?.status === "saving" ||
    projects?.status === "agentOffline";

  const sortedProjects = projects
    ? projects.projects.slice().sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )
    : [];

  const close = () => setMode(null);

  return createPortal(
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
      >
        {mode === "open" && (
          <>
            <div className={styles.dialogHeader}>
              <h2 id="project-dialog-title" className={styles.dialogTitle}>
                Open project
              </h2>
              <button
                className={styles.iconButton}
                onClick={close}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className={styles.dialogBody}>
              {sortedProjects.length === 0 ? (
                <p className={styles.empty}>No projects yet.</p>
              ) : (
                sortedProjects.map((project) => (
                  <div
                    key={project.id}
                    className={[
                      styles.projectRow,
                      project.id === highlightId ? styles.projectRowHighlighted : "",
                    ].join(" ")}
                  >
                    <div className={styles.projectInfo}>
                      <div className={styles.projectName}>{project.name}</div>
                      <div className={styles.projectMeta}>
                        {project.bpm} BPM - {project.bars} bars -{" "}
                        {project.layerCount} layers
                      </div>
                      <div className={styles.projectMeta}>
                        {formatBytes(project.sizeBytes)} -{" "}
                        {formatDate(project.updatedAt)}
                      </div>
                    </div>
                    <div className={styles.projectActions}>
                      <button
                        className={styles.button}
                        disabled={loadDisabled || loadMutation.isPending}
                        onClick={() => loadMutation.mutate(project.id)}
                        title={
                          loadDisabled
                            ? "Finish or save the current take first"
                            : `Load ${project.name} and replace the working session`
                        }
                      >
                        LOAD
                      </button>
                      <a
                        className={styles.button}
                        href={exportUrl(project.id, "bundle")}
                        download
                      >
                        EXPORT
                      </a>
                      <button
                        className={styles.button}
                        onClick={() => {
                          setRenameTarget(project);
                          setMode("rename");
                        }}
                      >
                        RENAME
                      </button>
                      <button
                        className={[
                          styles.button,
                          deleteConfirmId === project.id
                            ? styles.buttonDanger
                            : "",
                        ].join(" ")}
                        onClick={() => {
                          if (deleteConfirmId === project.id) {
                            deleteMutation.mutate(project.id);
                          } else {
                            setDeleteConfirmId(project.id);
                          }
                        }}
                      >
                        {deleteConfirmId === project.id
                          ? "Confirm?"
                          : "DELETE"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {mode === "saveAs" && (
          <>
            <div className={styles.dialogHeader}>
              <h2 id="project-dialog-title" className={styles.dialogTitle}>
                Save as
              </h2>
              <button
                className={styles.iconButton}
                onClick={close}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className={styles.dialogBody}>
              <label className={styles.fieldLabel} htmlFor="save-name">
                Name
              </label>
              <input
                id="save-name"
                className={styles.input}
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && saveName.trim()) {
                    saveAsMutation.mutate(saveName.trim());
                  }
                }}
                autoFocus
              />
              <div className={styles.dialogActions}>
                <button
                  className={styles.button}
                  disabled={!saveName.trim() || saveAsMutation.isPending}
                  onClick={() => saveAsMutation.mutate(saveName.trim())}
                >
                  SAVE
                </button>
                <button className={styles.button} onClick={close}>
                  CANCEL
                </button>
              </div>
            </div>
          </>
        )}

        {mode === "rename" && renameTarget && (
          <>
            <div className={styles.dialogHeader}>
              <h2 id="project-dialog-title" className={styles.dialogTitle}>
                Rename
              </h2>
              <button
                className={styles.iconButton}
                onClick={close}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className={styles.dialogBody}>
              <label className={styles.fieldLabel} htmlFor="rename-name">
                Name
              </label>
              <input
                id="rename-name"
                className={styles.input}
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && renameName.trim()) {
                    renameMutation.mutate({
                      id: renameTarget.id,
                      name: renameName.trim(),
                    });
                  }
                }}
                autoFocus
              />
              <div className={styles.dialogActions}>
                <button
                  className={styles.button}
                  disabled={!renameName.trim() || renameMutation.isPending}
                  onClick={() =>
                    renameMutation.mutate({
                      id: renameTarget.id,
                      name: renameName.trim(),
                    })
                  }
                >
                  RENAME
                </button>
                <button className={styles.button} onClick={close}>
                  CANCEL
                </button>
              </div>
            </div>
          </>
        )}

        {mode === "import" && (
          <>
            <div className={styles.dialogHeader}>
              <h2 id="project-dialog-title" className={styles.dialogTitle}>
                Import bundle
              </h2>
              <button
                className={styles.iconButton}
                onClick={close}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className={styles.dialogBody}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const file = event.target.files?.[0];

                  if (file) {
                    importMutation.mutate(file);
                  }
                }}
              />
              {importMutation.isPending && (
                <p className={styles.statusText}>Importing…</p>
              )}
              {importMutation.isError && (
                <p className={styles.statusText}>
                  {importMutation.error instanceof Error
                    ? importMutation.error.message
                    : String(importMutation.error)}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ProjectsSection({
  state,
  onCancelPendingApply,
}: {
  state: LooperState | undefined;
  onCancelPendingApply?: () => void;
}) {
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: listProjects,
    enabled: mounted,
    retry: 1,
  });

  return (
    <>
      <ProjectsBar
        state={state}
        projects={projectsQuery.data}
        onOpenDialog={setDialog}
      />
      <ProjectDialogs
        mode={dialog}
        setMode={setDialog}
        highlightId={highlightId}
        setHighlightId={setHighlightId}
        state={state}
        projects={projectsQuery.data}
        onCancelPendingApply={onCancelPendingApply}
        setStatusMessage={setStatusMessage}
      />
      {statusMessage && (
        <div className={styles.liveRegion} aria-live="polite">
          {statusMessage}
        </div>
      )}
    </>
  );
}
