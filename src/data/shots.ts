/**
 * Embedded shot library catalog — mirrors the shot recipe cards exposed by the
 * video-shotcraft project (https://github.com/Vincentwei1021/video-shotcraft).
 *
 * The full library lives in that repository as markdown recipe cards under
 * `references/shots/<category>/<card>.md` plus Remotion demo implementations
 * under `demos/<category>/<card>/`. This module exposes a compact, MCP-friendly
 * subset (categories + representative shot cards) so agent clients can browse
 * and reference shots without cloning the upstream repo.
 */

export interface ShotCategory {
  id: string;
  label: string;
  description: string;
  shotCount: number;
}

export interface ShotCard {
  id: string;
  name: string;
  category: string;
  label: string;
  description: string;
  motionType: string;
  durationSeconds: number;
  tags: string[];
}

export const SHOT_CATEGORIES: ShotCategory[] = [
  { id: "opening-brand", label: "Opening & Brand", description: "Brand reveals, titles, logo choreography.", shotCount: 11 },
  { id: "camera", label: "Camera", description: "Camera moves, 2.5D page flights, exploded views.", shotCount: 13 },
  { id: "transitions", label: "Transitions", description: "Motion-based transitions between shots.", shotCount: 19 },
  { id: "typography", label: "Typography", description: "Kinetic type, word tunnels, type choreography.", shotCount: 25 },
  { id: "ui-entrance", label: "UI Entrance", description: "Product UI elements dealing in / assembling.", shotCount: 22 },
  { id: "interaction", label: "Interaction", description: "State changes, theme ripples, data-driven motion.", shotCount: 13 },
  { id: "data", label: "Data", description: "Charts, beats, data-driven storytelling.", shotCount: 9 },
  { id: "light-emphasis", label: "Light & Emphasis", description: "Spotlight, flash, emphasis timing.", shotCount: 23 },
  { id: "rhythm", label: "Rhythm", description: "Pacing, beat sync, rhythm cuts.", shotCount: 8 },
  { id: "outro", label: "Outro", description: "Closures, assembly, outro motion.", shotCount: 7 },
];

export const SHOTS: ShotCard[] = [
  {
    id: "text-as-mask",
    name: "text-as-mask",
    category: "opening-brand",
    label: "text-as-mask: a dashboard seen through giant letters",
    description: "The product UI is masked by giant display type — the product shows through the title.",
    motionType: "masked reveal",
    durationSeconds: 6,
    tags: ["brand", "title", "mask"],
  },
  {
    id: "logo-shrink-wordmark-lockup",
    name: "logo-shrink-wordmark-lockup",
    category: "opening-brand",
    label: "logo-shrink-wordmark-lockup: wordmark lockup shrink",
    description: "A wordmark lockup shrinks into its final logo form.",
    motionType: "logo choreography",
    durationSeconds: 4,
    tags: ["logo", "brand"],
  },
  {
    id: "panel-grid-moves",
    name: "panel-grid-moves",
    category: "camera",
    label: "panel-grid-moves: panels translate in a grid",
    description: "A grid of panels moves into place — useful for dashboards and feature grids.",
    motionType: "camera move",
    durationSeconds: 5,
    tags: ["camera", "grid"],
  },
  {
    id: "product-card-progressive-assemble",
    name: "product-card-progressive-assemble",
    category: "camera",
    label: "product-card-progressive-assemble: cards assemble progressively",
    description: "Product cards progressively assemble into a composition.",
    motionType: "assembly",
    durationSeconds: 6,
    tags: ["assembly", "product"],
  },
  {
    id: "space-camera-moves",
    name: "space-camera-moves",
    category: "camera",
    label: "space-camera-moves: camera moves through space",
    description: "Camera moves through layered space — parallax depth shots.",
    motionType: "camera move",
    durationSeconds: 5,
    tags: ["camera", "parallax"],
  },
  {
    id: "exploded-view",
    name: "exploded-view",
    category: "camera",
    label: "exploded-view: a page tilts in 3D and its parts fly apart",
    description: "A page tilts in 3D and its parts fly apart.",
    motionType: "3D exploded view",
    durationSeconds: 6,
    tags: ["camera", "3d", "explode"],
  },
  {
    id: "card-flock-tumble",
    name: "card-flock-tumble",
    category: "transitions",
    label: "card-flock-tumble: cards tumble into a giant word",
    description: "A flock of cards becomes the headline — motion-based transition.",
    motionType: "transition",
    durationSeconds: 4,
    tags: ["transition", "cards"],
  },
  {
    id: "flying-words",
    name: "flying-words",
    category: "typography",
    label: "flying-words: feature words fly through a tunnel",
    description: "A word tunnel resolves into the motto — kinetic typography.",
    motionType: "kinetic type",
    durationSeconds: 5,
    tags: ["typography", "kinetic"],
  },
  {
    id: "card-stack",
    name: "card-stack",
    category: "ui-entrance",
    label: "card-stack: a fan of recipe cards deals out",
    description: "A fan of recipe cards deals into place — UI entrance choreography.",
    motionType: "deal / stagger",
    durationSeconds: 5,
    tags: ["ui", "cards", "stagger"],
  },
  {
    id: "palette-theme-ripple",
    name: "palette-theme-ripple",
    category: "interaction",
    label: "palette-theme-ripple: a theme change ripples across the app",
    description: "A theme change ripples across the app UI.",
    motionType: "interaction ripple",
    durationSeconds: 4,
    tags: ["interaction", "theme"],
  },
  {
    id: "axis-rescale-shock",
    name: "axis-rescale-shock",
    category: "data",
    label: "axis-rescale-shock: a chart spikes and its axis rescales",
    description: "A chart spikes and its axis rescales — data-driven motion.",
    motionType: "data shock",
    durationSeconds: 4,
    tags: ["data", "chart"],
  },
  {
    id: "spotlight-sweep",
    name: "spotlight-sweep",
    category: "light-emphasis",
    label: "spotlight-sweep: a spotlight reveals the title",
    description: "A stage light finds the title — cinematic light motion.",
    motionType: "light sweep",
    durationSeconds: 5,
    tags: ["light", "spotlight"],
  },
  {
    id: "paparazzi-flash",
    name: "paparazzi-flash",
    category: "rhythm",
    label: "paparazzi-flash: three flashes cut between crops",
    description: "Three flashes, three crops, one number — rhythm cut.",
    motionType: "flash cut",
    durationSeconds: 4,
    tags: ["rhythm", "flash"],
  },
  {
    id: "input-morph-assemble",
    name: "input-morph-assemble",
    category: "outro",
    label: "input-morph-assemble: an input box becomes the logo",
    description: "An input box becomes the logo — outro assembly.",
    motionType: "morph assembly",
    durationSeconds: 5,
    tags: ["outro", "morph"],
  },
];

export function listShots(category?: string): ShotCard[] {
  const shots = category ? SHOTS.filter((s) => s.category === category) : SHOTS;
  return [...shots].sort((a, b) => a.name.localeCompare(b.name));
}

export function getShot(id: string): ShotCard | undefined {
  return SHOTS.find((s) => s.id === id);
}
