/**
 * Helpers for the chat image drop zone (`AgentPanel`).
 *
 * A file drag from the OS surfaces as a `DataTransfer` whose `types`
 * include `"Files"`. Internal drags (pane tabs use a custom MIME type) and
 * text selections never include it, so gating on this one entry keeps the
 * drop zone from hijacking anything but real file drops.
 */
export function hasFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === "Files") return true;
  }
  return false;
}
