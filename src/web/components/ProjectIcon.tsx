import {
  Folder, FolderOpen, Briefcase, Rocket, Star, Heart, Zap, Target,
  Palette, Code, Terminal, GitBranch, Database, Server, Cloud, Globe,
  LayoutGrid, Layers, Box, Package, Cpu, Wrench, Hammer, Sparkles,
  Flame, Droplet, Leaf, Sun, Moon, Music, Camera, Image,
  Video, Mic, Phone, Mail, MessageSquare, Calendar, Clock, Map,
  Compass, Plane, Car, Coffee, Gamepad2, Trophy, Medal, Crown,
  Gem, Wallet, ShoppingCart, CreditCard, Banknote, Book, BookOpen,
  GraduationCap, Pencil, PenTool, Brush, Calculator, Presentation, BarChart3,
  PieChart, TrendingUp, Lightbulb, Brain, Puzzle, Blocks, Dices,
  Ghost, Bot, Cat, Dog, Fish, Bird, Rabbit, Turtle,
  Bug, Flower, TreePine, Mountain, Waves, Umbrella, Snowflake,
  Magnet, Key, Lock, Shield, ShieldCheck, Eye, Bell,
  Settings, Bookmark, Tag, Flag, Gift, Laptop, Smartphone,
  FlaskConical, Headphones,
  type LucideIcon,
} from "lucide-react";
import { DEFAULT_PROJECT_ICON, type ProjectIconName } from "../../shared/domain/workspaces.ts";
import { cn } from "../lib/utils.ts";

export const PROJECT_ICON_COMPONENTS: Record<ProjectIconName, LucideIcon> = {
  Folder, FolderOpen, Briefcase, Rocket, Star, Heart, Zap, Target,
  Palette, Code, Terminal, GitBranch, Database, Server, Cloud, Globe,
  LayoutGrid, Layers, Box, Package, Cpu, Wrench, Hammer, Sparkles,
  Flame, Droplet, Leaf, Sun, Moon, Music, Camera, Image,
  Video, Mic, Phone, Mail, MessageSquare, Calendar, Clock, Map,
  Compass, Plane, Car, Coffee, Gamepad2, Trophy, Medal, Crown,
  Gem, Wallet, ShoppingCart, CreditCard, Banknote, Book, BookOpen,
  GraduationCap, Pencil, PenTool, Brush, Calculator, Presentation, BarChart3,
  PieChart, TrendingUp, Lightbulb, Brain, Puzzle, Blocks, Dices,
  Ghost, Bot, Cat, Dog, Fish, Bird, Rabbit, Turtle,
  Bug, Flower, TreePine, Mountain, Waves, Umbrella, Snowflake,
  Magnet, Key, Lock, Shield, ShieldCheck, Eye, Bell,
  Settings, Bookmark, Tag, Flag, Gift, Laptop, Smartphone,
  FlaskConical, Headphones,
};

export function resolveProjectIcon(name?: string | null): LucideIcon {
  if (name && name in PROJECT_ICON_COMPONENTS) {
    return PROJECT_ICON_COMPONENTS[name as ProjectIconName];
  }
  return PROJECT_ICON_COMPONENTS[DEFAULT_PROJECT_ICON];
}

export function ProjectIconBadge({
  iconName,
  color,
  size = 14,
  className,
}: {
  iconName?: string | null;
  /** Exact user-selected hex. Rendered as-is — no contrast remapping. */
  color?: string | null;
  size?: number;
  className?: string;
}) {
  const Icon = resolveProjectIcon(iconName);
  return (
    <span
      className={cn("inline-flex items-center justify-center shrink-0", className)}
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <Icon style={{ width: size, height: size }} />
    </span>
  );
}
