import { z } from "zod";

export const MAX_DOMAIN_ID_LENGTH = 128;
export const MAX_DOMAIN_LABEL_LENGTH = 256;
export const MAX_DOMAIN_PATH_LENGTH = 4096;
export const opaqueDomainIdSchema = z.string().min(1).max(MAX_DOMAIN_ID_LENGTH);
const pathSchema = z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH);
const labelSchema = z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH);
export const workspaceKindSchema = z.enum(["directory", "main-checkout", "worktree"]);
export const workspaceSchema = z.object({
  id: opaqueDomainIdSchema, projectId: opaqueDomainIdSchema, kind: workspaceKindSchema,
  cwd: pathSchema, checkoutRoot: pathSchema.nullable(), mainRepositoryRoot: pathSchema.nullable(),
  branchRef: z.string().max(MAX_DOMAIN_PATH_LENGTH).nullable(), displayLabel: labelSchema, locationId: opaqueDomainIdSchema.nullable(),
  ownershipState: z.string().min(1), markerId: opaqueDomainIdSchema.nullable().default(null), markerPath: pathSchema.nullable().default(null), repairDetail: z.string().nullable().default(null), archivedAt: z.string().nullable(),
}).strict();
export const PROJECT_ICON_NAMES = [
  "Folder", "FolderOpen", "Briefcase", "Rocket", "Star", "Heart", "Zap", "Target",
  "Palette", "Code", "Terminal", "GitBranch", "Database", "Server", "Cloud", "Globe",
  "LayoutGrid", "Layers", "Box", "Package", "Cpu", "Wrench", "Hammer", "Sparkles",
  "Flame", "Droplet", "Leaf", "Sun", "Moon", "Music", "Camera", "Image",
  "Video", "Mic", "Phone", "Mail", "MessageSquare", "Calendar", "Clock", "Map",
  "Compass", "Plane", "Car", "Coffee", "Gamepad2", "Trophy", "Medal", "Crown",
  "Gem", "Wallet", "ShoppingCart", "CreditCard", "Banknote", "Book", "BookOpen",
  "GraduationCap", "Pencil", "PenTool", "Brush", "Calculator", "Presentation", "BarChart3",
  "PieChart", "TrendingUp", "Lightbulb", "Brain", "Puzzle", "Blocks", "Dices",
  "Ghost", "Bot", "Cat", "Dog", "Fish", "Bird", "Rabbit", "Turtle",
  "Bug", "Flower", "TreePine", "Mountain", "Waves", "Umbrella", "Snowflake",
  "Magnet", "Key", "Lock", "Shield", "ShieldCheck", "Eye", "Bell",
  "Settings", "Bookmark", "Tag", "Flag", "Gift", "Laptop", "Smartphone",
  "FlaskConical", "Headphones",
] as const;
export const DEFAULT_PROJECT_ICON = "Folder" as const;
export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];
export const projectIconSchema = z.enum(PROJECT_ICON_NAMES);

export const PROJECT_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981",
  "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7",
  "#d946ef", "#ec4899", "#f43f5e", "#fb7185", "#fdba74", "#fde047", "#86efac",
  "#5eead4", "#7dd3fc", "#c4b5fd", "#64748b", "#78716c", "#94a3b8", "#1f2937",
] as const;
export const projectColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color");
export type ProjectColor = string;

export const projectSchema = z.object({ id: opaqueDomainIdSchema, configuredRootPath: pathSchema, canonicalRootPath: pathSchema, displayLabel: labelSchema, iconName: projectIconSchema.nullable().default(null), iconColor: projectColorSchema.nullable().default(null), archivedAt: z.string().nullable() }).strict();
export const locationSchema = z.object({ id: opaqueDomainIdSchema, projectId: opaqueDomainIdSchema.nullable(), scope: z.enum(["global", "project"]), displayLabel: labelSchema, configuredRootPath: pathSchema, canonicalRootPath: pathSchema, enabled: z.boolean() }).strict();
export const workspaceSnapshotSchema = z.object({
  projects: z.array(projectSchema).max(100),
  workspaces: z.array(workspaceSchema).max(100),
  locations: z.array(locationSchema).max(100),
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type WorktreeLocation = z.infer<typeof locationSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
