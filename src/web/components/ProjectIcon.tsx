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
  Route, Waypoints, Milestone, Footprints, Signpost, SignpostBig, Navigation, MapPin, MapPinned, Tent, TentTree,
  TrainFront, TramFront, Bike, Ship, Anchor, Sailboat, Luggage, Hotel, Castle, Landmark, Factory, Warehouse, Store, Church, Mosque,
  User, Users, Smile, Handshake, PersonStanding, ThumbsUp, Accessibility, VenetianMask, Drama, Clapperboard, Joystick, Swords, Shapes, Infinity, Hash, AtSign, Asterisk, Quote, Gauge, Timer, Hourglass, AlarmClock, WandSparkles, Sparkle, CircleDot,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
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
  Route, Waypoints, Milestone, Footprints, Signpost, SignpostBig, Navigation, MapPin, MapPinned, Tent, TentTree,
  TrainFront, TramFront, Bike, Ship, Anchor, Sailboat, Luggage, Hotel, Castle, Landmark, Factory, Warehouse, Store, Church, Mosque,
  User, Users, Smile, Handshake, PersonStanding, ThumbsUp, Accessibility, VenetianMask, Drama, Clapperboard, Joystick, Swords, Shapes, Infinity, Hash, AtSign, Asterisk, Quote, Gauge, Timer, Hourglass, AlarmClock, WandSparkles, Sparkle, CircleDot,
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
  /** Detected project favicon URL. Renders the image; falls back to the
   *  lucide icon when unset or when the image fails to load (e.g. the
   *  project has no recognizable icon file). */
  imageSrc,
}: {
  iconName?: string | null;
  /** Exact user-selected hex. Rendered as-is — no contrast remapping. */
  color?: string | null;
  size?: number;
  className?: string;
  imageSrc?: string | null;
}) {
  const Icon = resolveProjectIcon(iconName);
  // Remember which source failed so a 404 (no icon file in the project)
  // falls back to the lucide icon. A new source renders again automatically;
  // clearing on disable lets re-enabling retry (e.g. after adding a favicon).
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => { setFailedSrc(null); }, [imageSrc]);
  const showImage = !!imageSrc && failedSrc !== imageSrc;
  if (showImage) {
    return (
      <span
        className={cn("inline-flex items-center justify-center shrink-0", className)}
        aria-hidden="true"
      >
        <img
          src={imageSrc}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailedSrc(imageSrc)}
          style={{ width: size, height: size }}
          className="rounded-[3px] object-contain"
        />
      </span>
    );
  }
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
