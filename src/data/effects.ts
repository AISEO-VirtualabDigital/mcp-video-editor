/**
 * Embedded video effects catalog — mirrors the talking-head effects exposed by
 * the claude-video-effects project (https://github.com/Vibha-Ramprakash/claude-video-effects).
 *
 * The catalog distinguishes:
 *   - face-tracked effects  : motion/lighting/ambient that follow the face
 *   - kinetic-text effects   : headline/word overlays animated into place
 *   - color-grade effects    : mood/grade looks over a timeline window
 *   - motion effects         : camera/transition-style moves
 *   - sticker/progress       : stamps, checklists, counters, UI flips
 *
 * Face-safe effects prefer behind-the-head layering over face-covering layers.
 */

export type EffectCategory = "face-tracked" | "kinetic-text" | "color-grade" | "motion" | "sticker" | "ambient" | "checklist";

export interface VideoEffect {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  faceSafe: boolean;
  timingHint?: string;
}

export const EFFECTS: VideoEffect[] = [
  { id: "noise", name: "noise", category: "face-tracked", description: "Reels pile up behind your head.", faceSafe: true, timingHint: "ambient" },
  { id: "lineup", name: "lineup", category: "face-tracked", description: "Numbered tiles fan out above your head.", faceSafe: true, timingHint: "ambient" },
  { id: "locked-on", name: "locked-on", category: "face-tracked", description: "Brackets lock onto the face and the camera follows you.", faceSafe: false, timingHint: "tracking" },
  { id: "orbit", name: "orbit", category: "face-tracked", description: "Your reels circle your head, behind you at the top.", faceSafe: true, timingHint: "tracking" },
  { id: "lean-in", name: "lean-in", category: "motion", description: "A quick punch-in on one word.", faceSafe: true, timingHint: "word" },
  { id: "backdrop-word", name: "backdrop-word", category: "kinetic-text", description: "A giant word drops in behind you.", faceSafe: true, timingHint: "word" },
  { id: "spotlight", name: "spotlight", category: "face-tracked", description: "Kill the lights, keep you lit.", faceSafe: true, timingHint: "lighting" },
  { id: "the-bill", name: "the-bill", category: "sticker", description: "Your instructions print out like a receipt.", faceSafe: true, timingHint: "overlay" },
  { id: "moody", name: "moody", category: "color-grade", description: "A moody colour grade.", faceSafe: true, timingHint: "grade" },
  { id: "swipe", name: "swipe", category: "color-grade", description: "A before and after slider.", faceSafe: true, timingHint: "grade" },
  { id: "todo", name: "todo", category: "checklist", description: "A checklist beside your head that ticks off as you talk.", faceSafe: true, timingHint: "checklist" },
  { id: "comment-box", name: "comment-box", category: "kinetic-text", description: "An Instagram comment types itself and posts.", faceSafe: true, timingHint: "typing" },
  { id: "tap", name: "tap", category: "sticker", description: "A Follow button flips to Following.", faceSafe: true, timingHint: "flip" },
  { id: "pause-point", name: "pause-point", category: "motion", description: "Freeze frame with a hand-drawn arrow.", faceSafe: true, timingHint: "freeze" },
  { id: "uninstall", name: "uninstall", category: "sticker", description: "A glitchy uninstall bar breaks the frame.", faceSafe: true, timingHint: "progress" },
  { id: "reel-frame", name: "reel-frame", category: "sticker", description: "Your video shrinks into a reel card.", faceSafe: true, timingHint: "frame" },
  { id: "shortcut-rain", name: "shortcut-rain", category: "ambient", description: "Keyboard keys rain down behind you.", faceSafe: true, timingHint: "ambient" },
  { id: "reject-stamp", name: "reject-stamp", category: "sticker", description: "A big red stamp slams down.", faceSafe: true, timingHint: "stamp" },
  { id: "countdown-flip", name: "countdown-flip", category: "kinetic-text", description: "A 3, 2, 1 flip clock above your head.", faceSafe: true, timingHint: "countdown" },
  { id: "rabbit-hole", name: "rabbit-hole", category: "ambient", description: "The room tunnels away behind you.", faceSafe: true, timingHint: "ambient" },
  { id: "cover-star", name: "cover-star", category: "face-tracked", description: "You become a magazine cover.", faceSafe: true, timingHint: "cover" },
  { id: "scribble", name: "scribble", category: "ambient", description: "Marker doodles draw themselves around you.", faceSafe: true, timingHint: "ambient" },
  { id: "glass-widgets", name: "glass-widgets", category: "face-tracked", description: "Frosted glass widgets and mini artifacts float around your head.", faceSafe: true, timingHint: "ambient" },
  { id: "red-collage", name: "red-collage", category: "kinetic-text", description: "Black and white you, a giant red word behind, three lines slam in.", faceSafe: true, timingHint: "kinetic" },
  { id: "split-headline", name: "split-headline", category: "kinetic-text", description: "A headline card slides down and pushes you to the bottom half.", faceSafe: true, timingHint: "headline" },
  { id: "pastel-word", name: "pastel-word", category: "kinetic-text", description: "Lavender room, a giant word behind, a profile card gets followed.", faceSafe: true, timingHint: "kinetic" },
  { id: "check-pills", name: "check-pills", category: "ambient", description: "Grid-paper room, your reels pinned behind you, blue pills get clicked.", faceSafe: true, timingHint: "ambient" },
  { id: "timeline", name: "timeline", category: "color-grade", description: "A dark red film look with an editing timeline and a glowing playhead.", faceSafe: true, timingHint: "grade" },
  { id: "headline-box", name: "headline-box", category: "kinetic-text", description: "A punch-in with a clean two-line headline.", faceSafe: true, timingHint: "headline" },
  { id: "profile-wall", name: "profile-wall", category: "face-tracked", description: "Your reels grid fills the wall while a counter ticks up.", faceSafe: true, timingHint: "ambient" },
  { id: "tier-list", name: "tier-list", category: "motion", description: "A tier list drops in and a character flies into S tier.", faceSafe: true, timingHint: "motion" },
  { id: "broll-split", name: "broll-split", category: "motion", description: "B-roll on top with a price-tag sticker, you below.", faceSafe: true, timingHint: "split" },
  { id: "phone-fan", name: "phone-fan", category: "face-tracked", description: "Your reels fan out like a hand of phones.", faceSafe: true, timingHint: "ambient" },
  { id: "dot-reveal", name: "dot-reveal", category: "motion", description: "Your shot builds out of glowing dots, then snaps into focus.", faceSafe: true, timingHint: "motion" },
  { id: "headline-wall", name: "headline-wall", category: "kinetic-text", description: "Your headlines pile up behind your head, then a total pops in front.", faceSafe: true, timingHint: "headline" },
  { id: "checklist", name: "checklist", category: "checklist", description: "A Claude task list under your chin, each step ticks green.", faceSafe: true, timingHint: "checklist" },
  { id: "liquid-glass-graph", name: "liquid-glass-graph", category: "motion", description: "A liquid glass card with a graph that climbs and a number that counts up.", faceSafe: true, timingHint: "kinetic" },
  { id: "carousel-spin", name: "carousel-spin", category: "motion", description: "Your reels spin around you in a 3D carousel.", faceSafe: true, timingHint: "motion" },
  { id: "match-cut", name: "match-cut", category: "motion", description: "News pages cut on one word, locked in place behind your head.", faceSafe: true, timingHint: "cut" },
  { id: "apple-toggles", name: "apple-toggles", category: "sticker", description: "iPhone switches flip on under your chin, one line at a time.", faceSafe: true, timingHint: "flip" },
  { id: "led-sign", name: "led-sign", category: "kinetic-text", description: "The lights drop and a glowing LED sign types itself out behind you.", faceSafe: true, timingHint: "typing" },
  { id: "slow-push", name: "slow-push", category: "motion", description: "A slow cinematic push-in while the room melts out of focus.", faceSafe: true, timingHint: "push" },
  { id: "over-the-shoulder-zoom", name: "over-the-shoulder-zoom", category: "motion", description: "Pushes into one corner, a liquid glass graph pops beside your head, then the other corner with a second graph.", faceSafe: true, timingHint: "zoom" },
  { id: "messages", name: "messages", category: "sticker", description: "iMessage notifications pop in one after another with a soft glow.", faceSafe: true, timingHint: "ambient" },
  { id: "place-in-grid", name: "place-in-grid", category: "face-tracked", description: "You shrink into the centre of your 3x3 profile grid, your reels pop in around you with view counts.", faceSafe: true, timingHint: "grid" },
];

export function listEffects(category?: string): VideoEffect[] {
  const effects = category ? EFFECTS.filter((e) => e.category === category) : EFFECTS;
  return [...effects].sort((a, b) => a.id.localeCompare(b.id));
}

export function getEffect(id: string): VideoEffect | undefined {
  return EFFECTS.find((e) => e.id === id);
}
