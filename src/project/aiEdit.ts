/** Everything the AI Edit tool shares between the panel and the server: prices, the options a user can set, the way those
 *  options become one instruction for the model, and the structured catalogue of templates and quick styles the panel
 *  shows. Pure data and pure functions, so the server and the tests import it too. */

/** Credits for editing a still (or the current frame of a video) — mirrored by `ai-edit/route.ts`. */
export const AI_EDIT_IMAGE_CREDITS = 16;
/** Credits per second of a video clip — mirrored by `ai-edit/video/route.ts`. */
export const AI_EDIT_VIDEO_CREDITS_PER_SECOND = 30;
/** Shortest / longest video clip (seconds) a video edit accepts. */
export const AI_EDIT_VIDEO_MIN_SECONDS = 2;
export const AI_EDIT_VIDEO_MAX_SECONDS = 10;

export function aiEditVideoCredits(seconds: number): number {
  return Math.ceil(Math.max(AI_EDIT_VIDEO_MIN_SECONDS, seconds)) * AI_EDIT_VIDEO_CREDITS_PER_SECOND;
}

export const AI_EDIT_PRESERVE_KEYS = ["face", "pose", "outfit", "background"] as const;
export type AiEditPreserve = (typeof AI_EDIT_PRESERVE_KEYS)[number];

export const AI_EDIT_DEFAULT_CREATIVITY = 50;

export interface AiEditOptions {
  /** What must stay as it is. */
  preserve: AiEditPreserve[];
  /** 0 (faithful) .. 100 (imaginative). */
  creativity: number;
}

/** Old recipes stored a three-step strength; those map onto the slider. */
export function creativityFromStrength(strength: "subtle" | "balanced" | "creative" | undefined): number {
  return strength === "subtle" ? 20 : strength === "creative" ? 80 : AI_EDIT_DEFAULT_CREATIVITY;
}

export function clampCreativity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : AI_EDIT_DEFAULT_CREATIVITY;
}

const PRESERVE_SENTENCES: Record<AiEditPreserve, string> = {
  face: "Keep the person's face, identity and facial features exactly the same.",
  pose: "Keep the pose, framing and composition unchanged.",
  outfit: "Keep the clothing and accessories unchanged.",
  background: "Keep the background unchanged.",
};

/** The one instruction sent to the model: the user's words plus what to preserve and how far to go. */
export function buildAiEditInstruction(prompt: string, options: AiEditOptions, kind: "image" | "video" = "image"): string {
  const parts = [prompt.trim().replace(/\s+/g, " ")];
  if (parts[0] && !/[.!?]$/.test(parts[0])) parts[0] += ".";
  const keep = AI_EDIT_PRESERVE_KEYS.filter((k) => options.preserve.includes(k));
  for (const key of keep) parts.push(PRESERVE_SENTENCES[key]);
  if (kind === "video") parts.push("Keep the original motion, timing and camera movement.");
  const creativity = clampCreativity(options.creativity);
  if (creativity <= 25) parts.push("Make a subtle, faithful edit that stays very close to the original.");
  else if (creativity >= 76) parts.push("Be bold and imaginative with the transformation.");
  return parts.filter(Boolean).join(" ");
}

export type AiEditCategoryId = "for-you" | "anime" | "poster" | "drawing" | "fashion" | "cinematic" | "fun";

export interface AiEditCategory {
  id: AiEditCategoryId;
  label: string;
}

export const AI_EDIT_CATEGORIES: AiEditCategory[] = [
  { id: "for-you", label: "For You" },
  { id: "anime", label: "Anime" },
  { id: "poster", label: "Poster" },
  { id: "drawing", label: "Drawing" },
  { id: "fashion", label: "Fashion" },
  { id: "cinematic", label: "Cinematic" },
  { id: "fun", label: "Fun" },
];

export interface AiEditTemplate {
  id: string;
  title: string;
  description: string;
  /** The category it lives under; `featured` ones also show under "For You". */
  category: Exclude<AiEditCategoryId, "for-you">;
  featured?: boolean;
  /** The editable starter prompt dropped into the input. */
  prompt: string;
  /** How the card previews the look on the user's own picture: a CSS filter, and a tint drawn over it. */
  look: { filter: string; tint: string };
}

const grad = (from: string, to: string, angle = 145) => `linear-gradient(${angle}deg, ${from}, ${to})`;

/** Add a template here and it appears in the panel — nothing else to wire. */
export const AI_EDIT_TEMPLATES: AiEditTemplate[] = [
  {
    id: "anime-hero",
    title: "Anime Hero",
    description: "Hand-drawn anime with bold ink lines",
    category: "anime",
    featured: true,
    prompt: "Turn this into a hand-drawn Japanese anime illustration with cel shading, bold ink outlines, and vivid flat colours",
    look: { filter: "saturate(1.6) contrast(1.15)", tint: grad("rgba(255,90,160,.35)", "rgba(80,120,255,.3)") },
  },
  {
    id: "anime-watercolor",
    title: "Anime Watercolor",
    description: "Soft painted anime with pastel washes",
    category: "anime",
    prompt: "Turn into a soft Japanese anime watercolour illustration with pastel washes, gentle gradients and delicate line art",
    look: { filter: "saturate(1.2) brightness(1.08) contrast(.92)", tint: grad("rgba(150,210,255,.35)", "rgba(255,190,220,.35)") },
  },
  {
    id: "manga-panel",
    title: "Manga Panel",
    description: "Black and white manga with screen tones",
    category: "anime",
    prompt: "Redraw as a black and white manga panel with dramatic ink shading, screen tones and speed lines",
    look: { filter: "grayscale(1) contrast(1.5)", tint: grad("rgba(255,255,255,.1)", "rgba(0,0,0,.25)") },
  },
  {
    id: "movie-poster",
    title: "Movie Poster",
    description: "A dramatic one-sheet with bold lighting",
    category: "poster",
    featured: true,
    prompt: "Turn into a dramatic blockbuster movie poster look with strong rim lighting, deep shadows and a teal and orange colour grade",
    look: { filter: "contrast(1.25) saturate(1.2)", tint: grad("rgba(0,140,160,.4)", "rgba(255,120,40,.35)", 160) },
  },
  {
    id: "retro-poster",
    title: "Retro Poster",
    description: "Screen-printed 70s poster colours",
    category: "poster",
    prompt: "Turn into a retro 1970s screen-printed poster with limited warm colours, halftone texture and flat shapes",
    look: { filter: "saturate(1.4) contrast(1.2) sepia(.25)", tint: grad("rgba(255,170,40,.35)", "rgba(220,60,60,.3)") },
  },
  {
    id: "pop-art",
    title: "Pop Art",
    description: "Comic dots and loud colour blocks",
    category: "poster",
    prompt: "Turn into a pop art comic illustration with halftone dots, thick outlines and bright colour blocks",
    look: { filter: "saturate(2) contrast(1.3)", tint: grad("rgba(255,60,120,.35)", "rgba(255,220,0,.3)") },
  },
  {
    id: "pencil-sketch",
    title: "Pencil Sketch",
    description: "Graphite lines on textured paper",
    category: "drawing",
    featured: true,
    prompt: "Turn into a detailed hand-drawn graphite pencil sketch on textured paper with fine cross-hatching",
    look: { filter: "grayscale(1) contrast(1.35) brightness(1.1)", tint: grad("rgba(255,250,235,.4)", "rgba(210,200,180,.35)") },
  },
  {
    id: "oil-painting",
    title: "Oil Painting",
    description: "Rich brush strokes and deep colour",
    category: "drawing",
    prompt: "Turn into an expressive classical oil painting with visible brush strokes, rich textures and warm depth",
    look: { filter: "saturate(1.3) contrast(1.1) sepia(.15)", tint: grad("rgba(190,110,40,.3)", "rgba(60,80,120,.3)") },
  },
  {
    id: "watercolor",
    title: "Watercolor",
    description: "Loose, bleeding washes on paper",
    category: "drawing",
    prompt: "Turn into a loose watercolour painting with bleeding washes, soft edges and visible paper grain",
    look: { filter: "saturate(1.1) brightness(1.1) contrast(.9)", tint: grad("rgba(120,200,230,.35)", "rgba(240,190,210,.3)") },
  },
  {
    id: "street-fashion",
    title: "Street Fashion",
    description: "Editorial streetwear shoot",
    category: "fashion",
    featured: true,
    prompt: "Restyle as a high-fashion streetwear editorial: stylish oversized jacket, sleek sunglasses, sharp studio flash lighting",
    look: { filter: "contrast(1.2) saturate(1.1)", tint: grad("rgba(20,20,30,.35)", "rgba(255,255,255,.1)") },
  },
  {
    id: "runway-glam",
    title: "Runway Glam",
    description: "Couture look under runway lights",
    category: "fashion",
    prompt: "Restyle in an elegant couture runway look with a tailored designer outfit, glossy magazine lighting and a clean backdrop",
    look: { filter: "brightness(1.08) contrast(1.15)", tint: grad("rgba(255,215,140,.35)", "rgba(255,255,255,.1)") },
  },
  {
    id: "vintage-film",
    title: "Vintage Film",
    description: "1970s 35mm grain and light leaks",
    category: "fashion",
    prompt: "Add 1970s vintage 35mm film grain, faded warm tones and soft light leaks",
    look: { filter: "sepia(.35) saturate(1.2) contrast(.95)", tint: grad("rgba(255,150,60,.3)", "rgba(255,80,80,.2)") },
  },
  {
    id: "neon-cyberpunk",
    title: "Neon Cyberpunk",
    description: "Rainy neon city glow",
    category: "cinematic",
    featured: true,
    prompt: "Place in a futuristic cyberpunk city at night with vibrant pink and cyan neon lights, rain and wet reflections",
    look: { filter: "saturate(1.5) contrast(1.2)", tint: grad("rgba(255,0,140,.4)", "rgba(0,200,255,.35)") },
  },
  {
    id: "golden-hour",
    title: "Golden Hour",
    description: "Warm sunset light and lens flare",
    category: "cinematic",
    prompt: "Make the lighting warm dramatic golden hour sunset with long soft shadows and a gentle lens flare",
    look: { filter: "brightness(1.05) saturate(1.3) sepia(.2)", tint: grad("rgba(255,170,50,.4)", "rgba(255,90,60,.25)") },
  },
  {
    id: "noir",
    title: "Film Noir",
    description: "High contrast black and white",
    category: "cinematic",
    prompt: "Turn into a classic film noir scene in high-contrast black and white with hard shadows and moody haze",
    look: { filter: "grayscale(1) contrast(1.6) brightness(.9)", tint: grad("rgba(0,0,0,.05)", "rgba(0,0,0,.4)") },
  },
  {
    id: "winter-snow",
    title: "Winter Snow",
    description: "Falling snow and frosted air",
    category: "cinematic",
    prompt: "Add falling snow and a cold frosted winter atmosphere with soft blue light",
    look: { filter: "saturate(.8) brightness(1.1) hue-rotate(-10deg)", tint: grad("rgba(190,225,255,.4)", "rgba(255,255,255,.2)") },
  },
  {
    id: "sci-fi-hologram",
    title: "Hologram",
    description: "Glowing blue holographic projection",
    category: "cinematic",
    prompt: "Transform into a futuristic glowing blue sci-fi holographic projection with scan lines",
    look: { filter: "hue-rotate(160deg) saturate(1.6) brightness(1.05)", tint: grad("rgba(0,180,255,.4)", "rgba(80,0,255,.3)") },
  },
  {
    id: "cherry-blossom",
    title: "Cherry Blossoms",
    description: "Falling petals and spring pastels",
    category: "fun",
    featured: true,
    prompt: "Add falling pink cherry blossom petals and a soft springtime pastel mood",
    look: { filter: "saturate(1.1) brightness(1.1)", tint: grad("rgba(255,170,200,.4)", "rgba(255,230,240,.25)") },
  },
  {
    id: "superhero",
    title: "Superhero",
    description: "Cape, glow and heroic pose lighting",
    category: "fun",
    prompt: "Give them a heroic superhero costume with a flowing cape, glowing eyes and dramatic comic-book lighting",
    look: { filter: "contrast(1.3) saturate(1.5)", tint: grad("rgba(230,30,50,.35)", "rgba(30,60,220,.3)") },
  },
  {
    id: "toy-3d",
    title: "3D Toy",
    description: "Glossy collectible figure look",
    category: "fun",
    prompt: "Turn into a glossy 3D collectible toy figure with smooth plastic shading and a soft studio backdrop",
    look: { filter: "saturate(1.5) brightness(1.08) contrast(1.05)", tint: grad("rgba(120,220,255,.3)", "rgba(255,150,220,.3)") },
  },
  {
    id: "electric-glow",
    title: "Electric Glow",
    description: "Neon arcs tracing the subject",
    category: "fun",
    prompt: "Outline the subject with glowing electric neon arcs and light streaks in a dark scene",
    look: { filter: "contrast(1.3) saturate(1.4) brightness(.95)", tint: grad("rgba(120,60,255,.4)", "rgba(0,220,255,.3)") },
  },
];

export function templatesInCategory(category: AiEditCategoryId): AiEditTemplate[] {
  return category === "for-you" ? AI_EDIT_TEMPLATES.filter((t) => t.featured) : AI_EDIT_TEMPLATES.filter((t) => t.category === category);
}

export interface AiEditQuickStyle {
  id: string;
  label: string;
  /** Appended to the prompt while the chip is on. */
  phrase: string;
}

export const AI_EDIT_QUICK_STYLES: AiEditQuickStyle[] = [
  { id: "anime", label: "Anime", phrase: "in anime style" },
  { id: "watercolor", label: "Watercolor", phrase: "in watercolor style" },
  { id: "pencil", label: "Pencil Sketch", phrase: "as a pencil sketch" },
  { id: "cyberpunk", label: "Cyberpunk", phrase: "in a cyberpunk neon style" },
  { id: "oil", label: "Oil Painting", phrase: "as an oil painting" },
  { id: "3d", label: "3D", phrase: "as a 3D render" },
  { id: "cinematic", label: "Cinematic", phrase: "with cinematic lighting" },
];

export function promptHasPhrase(prompt: string, phrase: string): boolean {
  return prompt.toLowerCase().includes(phrase.toLowerCase());
}

/** Adds the phrase to the prompt, or takes it out again when it is already there. */
export function togglePhrase(prompt: string, phrase: string): string {
  if (promptHasPhrase(prompt, phrase)) {
    const pattern = new RegExp(`[,\\s]*${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    return prompt.replace(pattern, "").replace(/\s{2,}/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
  }
  const base = prompt.trim().replace(/[.,\s]+$/, "");
  return base ? `${base}, ${phrase}` : phrase[0].toUpperCase() + phrase.slice(1);
}

/** Fills out a short prompt with the detail image models respond to. Runs on the device: free and instant. */
export function enhancePrompt(prompt: string, options: AiEditOptions): string {
  const base = prompt.trim().replace(/[.\s]+$/, "");
  if (!base) return "";
  const extras = ["high quality", "sharp focus", "natural, coherent lighting", "fine detail"];
  const lower = base.toLowerCase();
  const wanted = extras.filter((e) => !lower.includes(e.split(",")[0]));
  const keep = AI_EDIT_PRESERVE_KEYS.filter((k) => options.preserve.includes(k));
  const keepText = keep.length ? `, keeping the ${keep.join(", ")} the same` : "";
  return `${base}${keepText}, ${wanted.join(", ")}`;
}

/** A random template prompt different from the current one. `random` is injectable for tests. */
export function surprisePrompt(current: string, random: () => number = Math.random): string {
  const pool = AI_EDIT_TEMPLATES.filter((t) => t.prompt !== current);
  return pool[Math.floor(random() * pool.length) % pool.length].prompt;
}
