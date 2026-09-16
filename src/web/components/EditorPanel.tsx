import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching, foldGutter } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { FileRead, FileRevision } from "../../shared/domain/files.ts";
import type { WorkspaceApi } from "../api.ts";
import { FileTypeIcon } from "./FileTypeIcon.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";

type EditorProps = {
  workspaceId: string;
  filePath: string;
  api: WorkspaceApi;
  onClose: () => void;
  onOpenDiff?: (path: string) => void;
};

export function EditorPanel({ workspaceId, filePath, api, onClose, onOpenDiff }: EditorProps) {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState<FileRevision | null>(null);
  const [initialContent, setInitialContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState("");

  const getLanguageExtension = (path: string) => {
    const ext = path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "ts":
      case "tsx":
        return javascript({ typescript: true, jsx: true });
      case "js":
      case "jsx":
        return javascript({ jsx: true });
      case "json":
      case "jsonc":
        return json();
      case "md":
      case "markdown":
        return markdown();
      default:
        return [];
    }
  };

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError("");
    setConflict(false);
    setSaveError("");
    try {
      const fileData: FileRead = await api.readFile(workspaceId, filePath);
      setRevision(fileData.revision);
      setInitialContent(fileData.content);
      setIsDirty(false);

      if (editorViewRef.current) {
        const state = EditorState.create({
          doc: fileData.content,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            EditorState.allowMultipleSelections.of(true),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            bracketMatching(),
            highlightActiveLine(),
            oneDark,
            getLanguageExtension(filePath),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                const currentText = update.state.doc.toString();
                setIsDirty(currentText !== fileData.content);
              }
            }),
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  void handleSave();
                  return true;
                },
              },
              ...defaultKeymap,
              ...historyKeymap,
            ]),
          ],
        });
        editorViewRef.current.setState(state);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read file");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filePath, api]);

  useEffect(() => {
    if (!editorContainerRef.current) return;

    const startState = EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        syntaxHighlighting(defaultHighlightStyle),
        oneDark,
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: editorContainerRef.current,
    });
    editorViewRef.current = view;

    void loadFile();

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, [workspaceId, filePath, loadFile]);

  const handleSave = async () => {
    if (!editorViewRef.current || !revision || saving) return;
    const currentDoc = editorViewRef.current.state.doc.toString();
    setSaving(true);
    setSaveError("");
    setConflict(false);

    try {
      const writeResult = await api.writeFile(workspaceId, filePath, currentDoc, revision);
      setRevision(writeResult.revision);
      setInitialContent(currentDoc);
      setIsDirty(false);
    } catch (err) {
      const isConflict = err instanceof Error && (err.message.includes("conflict") || (err as { code?: string }).code === "conflict");
      if (isConflict) {
        setConflict(true);
        setSaveError("File was modified on disk since it was loaded. Please review changes or reload.");
      } else {
        setSaveError(err instanceof Error ? err.message : "Failed to save file");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor-panel" aria-label={`Editor for ${filePath}`}>
      <div className="editor-top-bar">
        <div className="editor-file-info">
          <FileTypeIcon path={filePath} size={15} />
          <span className="editor-path"><b>{filePath}</b></span>
          {isDirty && <span className="dirty-indicator" title="Unsaved changes">● Unsaved</span>}
          {revision && (
            <span className="editor-meta muted">
              {formatBytes(revision.size)}
            </span>
          )}
        </div>

        <div className="editor-actions">
          {onOpenDiff && (
            <button
              className="secondary small"
              onClick={() => onOpenDiff(filePath)}
              title="Open diff for this file"
            >
              Diff ↗
            </button>
          )}
          <button
            className="primary small"
            onClick={handleSave}
            disabled={!isDirty || saving || loading || conflict}
            title="Save file (Ctrl+S / Cmd+S)"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            title="Close editor"
            aria-label="Close editor"
          >
            ×
          </button>
        </div>
      </div>

      {conflict && (
        <Alert variant="destructive" className="conflict-banner">
          <div className="conflict-copy">
            <AlertTitle>⚠️ Conflict detected:</AlertTitle>
            <AlertDescription>File on disk has newer changes than this editor buffer.</AlertDescription>
          </div>
          <div className="conflict-actions">
            <button className="danger-button small" onClick={loadFile}>
              Reload from disk (discard local changes)
            </button>
            {onOpenDiff && (
              <button className="secondary small" onClick={() => onOpenDiff(filePath)}>
                Review diff
              </button>
            )}
          </div>
        </Alert>
      )}

      {saveError && !conflict && <Alert variant="destructive" className="panel-alert"><AlertDescription>{saveError}</AlertDescription></Alert>}
      {error && <Alert variant="destructive" className="panel-alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="editor-container" ref={editorContainerRef} />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
