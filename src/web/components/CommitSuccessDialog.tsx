import { CommitToastDescription } from "./ui/sonner.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";

/**
 * Commit success modal. Replaces the old commit-message toast (which dumped
 * the full subject + body into a top-center card that covered the prompt on
 * narrow viewports) with the same expandable pattern as the merge-locally
 * flow: a modal with the commit inside a bordered box, collapsed to the
 * subject line with a Show more toggle for the body.
 */
export function CommitSuccessDialog({
  title,
  message,
  open,
  onOpenChange,
}: {
  title: string;
  message: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="commit-success-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>Changes were committed to the branch.</AlertDialogDescription>
        </AlertDialogHeader>
        <div
          className="rounded-md border bg-muted/50 px-3 py-2 text-sm"
          data-testid="commit-success-message"
        >
          <div className="mb-0.5 text-xs font-medium text-muted-foreground">Commit</div>
          {message.trim() ? (
            <CommitToastDescription key={message} message={message} />
          ) : (
            <span className="text-muted-foreground">Commit message unavailable.</span>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
