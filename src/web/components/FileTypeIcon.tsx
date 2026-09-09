import { FileIcon } from "react-material-vscode-icons";

type FileTypeIconProps = {
  path: string;
  isFolder?: boolean;
  isExpanded?: boolean;
  size?: number;
  className?: string;
};

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function FileTypeIcon({ path, isFolder = false, isExpanded = false, size = 14, className }: FileTypeIconProps) {
  return (
    <span className="file-type-icon" aria-hidden="true">
      <FileIcon
        fileName={basename(path)}
        isFolder={isFolder}
        isExpanded={isExpanded}
        size={size}
        className={className}
      />
    </span>
  );
}
