import { useEffect, useState } from "react";
import type { Project } from "../../shared/domain/workspaces.ts";
import { friendlyApiError, type WorkspaceApi } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { ProjectAppearanceField } from "./ProjectAppearanceField.tsx";

export function ProjectEditModal({
  project,
  api,
  onClose,
  onSaved,
}: {
  project: Project;
  api: WorkspaceApi;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState(project.displayLabel);
  const [icon, setIcon] = useState<string | null>(project.iconName ?? null);
  const [color, setColor] = useState<string | null>(project.iconColor ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLabel(project.displayLabel);
    setIcon(project.iconName ?? null);
    setColor(project.iconColor ?? null);
    setError("");
  }, [project.id, project.displayLabel, project.iconName, project.iconColor]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("Project name cannot be empty.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.updateProject(project.id, {
        displayLabel: label.trim(),
        iconName: icon,
        iconColor: color,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(friendlyApiError(err, "Failed to update project"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[min(480px,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Edit project</DialogTitle>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" className="my-2">
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-project-label" className="text-xs">Project name</Label>
            <Input
              id="edit-project-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Payments platform"
              className="h-8 text-xs"
              autoFocus
              required
            />
          </div>
          <ProjectAppearanceField
            icon={icon}
            color={color}
            onIconChange={setIcon}
            onColorChange={setColor}
            idPrefix="edit-project"
          />
          <p className="text-[11px] text-muted-foreground font-mono break-all">{project.canonicalRootPath}</p>
          <div className="flex justify-end gap-2 pt-2 border-t border-border/40">
            <Button type="button" variant="secondary" size="xs" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={busy || !label.trim()}>
              {busy ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
