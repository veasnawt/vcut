import type { TextGradient, TextShadow, TextStyle } from "./types.ts";

export type PresetCategory =
  | "trending"
  | "minimal"
  | "bold"
  | "cinematic"
  | "social"
  | "subtitle"
  | "neon"
  | "glow"
  | "retro"
  | "y2k"
  | "gaming"
  | "comic"
  | "luxury"
  | "cute"
  | "gradient"
  | "meme"
  | "editorial"
  | "tech";

export interface PresetCategoryInfo {
  id: PresetCategory;
  label: string;
}

export const PRESET_CATEGORIES: PresetCategoryInfo[] = [
  { id: "trending", label: "Trending" },
  { id: "minimal", label: "Minimal" },
  { id: "bold", label: "Bold" },
  { id: "cinematic", label: "Cinematic" },
  { id: "social", label: "Social" },
  { id: "subtitle", label: "Subtitles" },
  { id: "neon", label: "Neon" },
  { id: "glow", label: "Glow" },
  { id: "retro", label: "Retro" },
  { id: "y2k", label: "Y2K & Chrome" },
  { id: "gaming", label: "Gaming" },
  { id: "comic", label: "Comic & Pop" },
  { id: "luxury", label: "Luxury" },
  { id: "cute", label: "Cute" },
  { id: "gradient", label: "Gradient" },
  { id: "meme", label: "Meme" },
  { id: "editorial", label: "Editorial" },
  { id: "tech", label: "Tech & Sci-Fi" },
];

/** A complete quick-apply typographic look for a text clip.
 *  Strongly typed, extensible for AI generators, and fully reversible. */
export interface TextStylePreset {
  id: string;
  label: string;
  category: PresetCategory;
  description?: string;
  tags?: string[];

  // Typography
  fontFamily?: string;
  fontSize?: number;
  bold: boolean;
  italic?: boolean;
  letterSpacing?: number;
  lineHeightMultiplier?: number;
  align?: "left" | "center" | "right";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  textDecoration?: "none" | "underline" | "line-through";

  // Fill & Gradient
  color: string;
  gradient?: TextGradient;
  opacity?: number;

  // Stroke / Outline
  strokeColor?: string;
  strokeWidth?: number;
  strokeColor2?: string;
  strokeWidth2?: number;

  // Shadows & Glow
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
  shadows?: TextShadow[];
  glowColor?: string;
  glowBlur?: number;

  // Background Box / Highlight
  backgroundColor?: string;
  backgroundOpacity?: number;
  backgroundPadding?: number;
  backgroundCornerRadius?: number;

  // Blend mode
  blendMode?: GlobalCompositeOperation;
}

export const TEXT_STYLE_PRESETS: TextStylePreset[] = [
  // ─── 1. Trending & Popular ───────────────────────────────────────────────
  {
    id: "trending-hyper-glow",
    label: "Hyper Cyan Glow",
    category: "trending",
    tags: ["popular", "cyan", "glow", "modern"],
    fontFamily: "montserrat",
    bold: true,
    color: "#e0faff",
    glowColor: "#00e5ff",
    glowBlur: 18,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  {
    id: "trending-bold-impact",
    label: "Bold Viral Impact",
    category: "trending",
    tags: ["reels", "tiktok", "punchy", "viral"],
    fontFamily: "anton",
    bold: false,
    color: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 4,
    shadowColor: "#000000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
    shadowBlur: 0,
    textTransform: "uppercase",
  },
  {
    id: "trending-sunset-vibes",
    label: "Sunset Heat",
    category: "trending",
    tags: ["gradient", "warm", "sunset", "vibe"],
    fontFamily: "outfit",
    bold: true,
    color: "#ff7e5f",
    gradient: {
      type: "linear",
      angleDeg: 90,
      stops: [
        { offset: 0, color: "#ff512f" },
        { offset: 0.5, color: "#dd2476" },
        { offset: 1, color: "#ff8c00" },
      ],
    },
    shadowColor: "rgba(0,0,0,0.4)",
    shadowOffsetX: 2,
    shadowOffsetY: 3,
    shadowBlur: 4,
  },
  {
    id: "trending-clean-aesthetic",
    label: "Clean Aesthetic",
    category: "trending",
    tags: ["aesthetic", "clean", "cream", "minimal"],
    fontFamily: "poppins",
    bold: true,
    color: "#f8f5ee",
    letterSpacing: 3,
    backgroundColor: "rgba(20,24,33,0.75)",
    backgroundPadding: 10,
    backgroundCornerRadius: 8,
  },
  {
    id: "trending-neon-tokyo",
    label: "Tokyo Neon",
    category: "trending",
    tags: ["neon", "magenta", "cyber", "tokyo"],
    fontFamily: "righteous",
    bold: false,
    color: "#ff2a8d",
    glowColor: "#ff0077",
    glowBlur: 20,
    shadowColor: "#7928ca",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 10,
  },

  // ─── 2. Minimal & Clean ──────────────────────────────────────────────────
  {
    id: "clean-white",
    label: "Clean White",
    category: "minimal",
    tags: ["white", "clean", "basic"],
    fontFamily: "inter",
    color: "#ffffff",
    bold: false,
  },
  {
    id: "minimal-black",
    label: "Minimal Black",
    category: "minimal",
    tags: ["black", "clean", "dark"],
    fontFamily: "inter",
    color: "#000000",
    bold: false,
  },
  {
    id: "minimal-slate-mono",
    label: "Slate Translucent",
    category: "minimal",
    tags: ["slate", "modern", "subtle"],
    fontFamily: "dmsans",
    bold: true,
    color: "#f1f5f9",
    backgroundColor: "#0f172a",
    backgroundOpacity: 0.8,
    backgroundPadding: 8,
    backgroundCornerRadius: 6,
  },
  {
    id: "minimal-outline-only",
    label: "Minimal Outline",
    category: "minimal",
    tags: ["wireframe", "outline", "modern"],
    fontFamily: "oswald",
    bold: true,
    color: "transparent",
    strokeColor: "#ffffff",
    strokeWidth: 2,
    letterSpacing: 4,
    textTransform: "uppercase",
  },
  {
    id: "minimal-charcoal-clean",
    label: "Charcoal Clean",
    category: "minimal",
    tags: ["charcoal", "neutral", "elegant"],
    fontFamily: "worksans",
    bold: true,
    color: "#1e293b",
    strokeColor: "#ffffff",
    strokeWidth: 1,
  },

  // ─── 3. Bold & Punchy ────────────────────────────────────────────────────
  {
    id: "bold-caption",
    label: "Bold Caption",
    category: "bold",
    tags: ["white", "black-border", "caption"],
    fontFamily: "inter",
    color: "#ffffff",
    bold: true,
    strokeColor: "#000000",
    strokeWidth: 4,
  },
  {
    id: "bold-heavyweight",
    label: "Heavyweight Gold",
    category: "bold",
    tags: ["yellow", "heavy", "title"],
    fontFamily: "anton",
    bold: false,
    color: "#fef08a",
    strokeColor: "#000000",
    strokeWidth: 5,
    shadowColor: "#000000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
    textTransform: "uppercase",
  },
  {
    id: "bold-alert-red",
    label: "Alert Red Punch",
    category: "bold",
    tags: ["red", "alert", "punch"],
    fontFamily: "bebasneue",
    bold: false,
    color: "#ef4444",
    strokeColor: "#ffffff",
    strokeWidth: 2,
    shadowColor: "#7f1d1d",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
    textTransform: "uppercase",
  },
  {
    id: "bold-electric-lime",
    label: "Electric Lime",
    category: "bold",
    tags: ["lime", "neon", "contrast"],
    fontFamily: "rubik",
    bold: true,
    color: "#a3e635",
    strokeColor: "#000000",
    strokeWidth: 4,
    shadowColor: "#000000",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
  },
  {
    id: "bold-action-hero",
    label: "Action Fire",
    category: "bold",
    tags: ["fire", "action", "hero"],
    fontFamily: "bangers",
    bold: false,
    color: "#ffaa00",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#ffe600" },
        { offset: 1, color: "#ff2200" },
      ],
    },
    strokeColor: "#000000",
    strokeWidth: 5,
    shadowColor: "#3d0000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },

  // ─── 4. Cinematic & Movie Titles ─────────────────────────────────────────
  {
    id: "cinematic-blockbuster",
    label: "Silver Blockbuster",
    category: "cinematic",
    tags: ["movie", "silver", "blockbuster"],
    fontFamily: "montserrat",
    bold: true,
    color: "#f8fafc",
    letterSpacing: 6,
    textTransform: "uppercase",
    shadowColor: "rgba(2,132,199,0.6)",
    shadowOffsetX: 0,
    shadowOffsetY: 4,
    shadowBlur: 12,
  },
  {
    id: "cinematic-golden-epic",
    label: "Golden Epic",
    category: "cinematic",
    tags: ["epic", "gold", "movie", "trailer"],
    fontFamily: "playfairdisplay",
    bold: true,
    color: "#fbbf24",
    gradient: {
      type: "linear",
      angleDeg: 90,
      stops: [
        { offset: 0, color: "#fef08a" },
        { offset: 0.5, color: "#d97706" },
        { offset: 1, color: "#92400e" },
      ],
    },
    letterSpacing: 4,
    shadowColor: "rgba(0,0,0,0.8)",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
    shadowBlur: 6,
  },
  {
    id: "cinematic-noir",
    label: "Film Noir",
    category: "cinematic",
    tags: ["noir", "dramatic", "black-and-white"],
    fontFamily: "merriweather",
    bold: true,
    color: "#ffffff",
    letterSpacing: 2,
    shadowColor: "#000000",
    shadowOffsetX: 5,
    shadowOffsetY: 5,
    shadowBlur: 0,
  },
  {
    id: "cinematic-sci-fi",
    label: "Deep Space Sci-Fi",
    category: "cinematic",
    tags: ["sci-fi", "space", "cyan", "futuristic"],
    fontFamily: "orbitron",
    bold: true,
    color: "#e0f2fe",
    letterSpacing: 6,
    textTransform: "uppercase",
    glowColor: "#38bdf8",
    glowBlur: 14,
  },

  // ─── 5. Social & Shorts / Reels ──────────────────────────────────────────
  {
    id: "social-viral-hook",
    label: "Viral Hook Yellow",
    category: "social",
    tags: ["tiktok", "viral", "hook", "yellow"],
    fontFamily: "anton",
    bold: false,
    color: "#fde047",
    strokeColor: "#000000",
    strokeWidth: 5,
    textTransform: "uppercase",
  },
  {
    id: "social-caption-box",
    label: "TikTok Dark Box",
    category: "social",
    tags: ["tiktok", "caption", "dark-box"],
    fontFamily: "inter",
    bold: true,
    color: "#ffffff",
    backgroundColor: "#000000",
    backgroundOpacity: 0.85,
    backgroundPadding: 12,
    backgroundCornerRadius: 6,
  },
  {
    id: "social-split-contrast",
    label: "Neon Lime Retention",
    category: "social",
    tags: ["reels", "high-retention", "lime"],
    fontFamily: "poppins",
    bold: true,
    color: "#4ade80",
    strokeColor: "#0f172a",
    strokeWidth: 3,
    shadowColor: "#000000",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
  },
  {
    id: "social-hype-beast",
    label: "Red Highlight Pill",
    category: "social",
    tags: ["hype", "red", "banner"],
    fontFamily: "bebasneue",
    bold: false,
    color: "#ffffff",
    backgroundColor: "#dc2626",
    backgroundPadding: 10,
    backgroundCornerRadius: 4,
    textTransform: "uppercase",
  },
  {
    id: "social-karaoke-pop",
    label: "Karaoke Bounce Pop",
    category: "social",
    tags: ["karaoke", "cute", "pop"],
    fontFamily: "fredoka",
    bold: true,
    color: "#fef08a",
    strokeColor: "#6b21a8",
    strokeWidth: 4,
    shadowColor: "#581c87",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
  },

  // ─── 6. Subtitle & Captions ──────────────────────────────────────────────
  {
    id: "subtitle-box",
    label: "Subtitle Box",
    category: "subtitle",
    tags: ["classic", "caption", "box"],
    fontFamily: "roboto",
    color: "#ffffff",
    bold: false,
    backgroundColor: "#141414",
    backgroundOpacity: 0.9,
    backgroundPadding: 10,
    backgroundCornerRadius: 4,
  },
  {
    id: "subtitle-classic-teletext",
    label: "Classic Broadcast Sub",
    category: "subtitle",
    tags: ["broadcast", "clear", "readable"],
    fontFamily: "roboto",
    bold: true,
    color: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 3,
  },
  {
    id: "subtitle-yellow-sub",
    label: "Documentary Yellow",
    category: "subtitle",
    tags: ["documentary", "yellow", "caption"],
    fontFamily: "opensans",
    bold: true,
    color: "#fef08a",
    strokeColor: "#171717",
    strokeWidth: 2,
  },
  {
    id: "subtitle-dark-translucent",
    label: "Translucent Slate",
    category: "subtitle",
    tags: ["slate", "modern", "sub"],
    fontFamily: "lato",
    bold: true,
    color: "#ffffff",
    backgroundColor: "rgba(15,23,42,0.85)",
    backgroundPadding: 8,
    backgroundCornerRadius: 8,
  },
  {
    id: "subtitle-warm-creme",
    label: "Warm Cream Shadow",
    category: "subtitle",
    tags: ["warm", "cream", "vlog"],
    fontFamily: "nunito",
    bold: true,
    color: "#fef3c7",
    shadowColor: "rgba(0,0,0,0.75)",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 3,
  },

  // ─── 7. Neon & Cyberpunk ─────────────────────────────────────────────────
  {
    id: "neon-pink",
    label: "Neon Pink",
    category: "neon",
    tags: ["neon", "pink", "glow"],
    color: "#ff2fb0",
    bold: true,
    shadowColor: "#ff2fb0",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    glowColor: "#ff2fb0",
    glowBlur: 16,
  },
  {
    id: "neon-cyber-cyan",
    label: "Cyber Laser Cyan",
    category: "neon",
    tags: ["cyberpunk", "laser", "cyan"],
    fontFamily: "orbitron",
    bold: true,
    color: "#22d3ee",
    glowColor: "#06b6d4",
    glowBlur: 20,
    textTransform: "uppercase",
  },
  {
    id: "neon-acid-green",
    label: "Acid Matrix Green",
    category: "neon",
    tags: ["acid", "matrix", "green"],
    fontFamily: "rubik",
    bold: true,
    color: "#4ade80",
    glowColor: "#16a34a",
    glowBlur: 18,
  },
  {
    id: "neon-purple-haze",
    label: "Purple Cyber Haze",
    category: "neon",
    tags: ["purple", "synth", "glow"],
    fontFamily: "montserrat",
    bold: true,
    color: "#c084fc",
    glowColor: "#9333ea",
    glowBlur: 16,
    shadowColor: "#3b0764",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },
  {
    id: "neon-bladerunner",
    label: "Blade Runner Orange",
    category: "neon",
    tags: ["bladerunner", "amber", "neon"],
    fontFamily: "bungee",
    bold: false,
    color: "#fb923c",
    glowColor: "#ea580c",
    glowBlur: 18,
  },

  // ─── 8. Glow & Radiant ───────────────────────────────────────────────────
  {
    id: "glow-ethereal-white",
    label: "Ethereal Celestial",
    category: "glow",
    tags: ["ethereal", "white", "glow", "soft"],
    fontFamily: "quicksand",
    bold: true,
    color: "#ffffff",
    glowColor: "#ffffff",
    glowBlur: 20,
    letterSpacing: 3,
  },
  {
    id: "glow-golden-sun",
    label: "Radiant Golden Sun",
    category: "glow",
    tags: ["sun", "gold", "radiant"],
    fontFamily: "merriweather",
    bold: true,
    color: "#fffbeb",
    glowColor: "#f59e0b",
    glowBlur: 18,
  },
  {
    id: "glow-aurora-teal",
    label: "Aurora Borealis",
    category: "glow",
    tags: ["aurora", "teal", "dreamy"],
    fontFamily: "comfortaa",
    bold: true,
    color: "#ccfbf1",
    glowColor: "#14b8a6",
    glowBlur: 16,
  },
  {
    id: "glow-supernova",
    label: "Supernova Coral",
    category: "glow",
    tags: ["supernova", "coral", "intense"],
    fontFamily: "poppins",
    bold: true,
    color: "#ffffff",
    glowColor: "#f43f5e",
    glowBlur: 22,
  },

  // ─── 9. Retro & Vintage ──────────────────────────────────────────────────
  {
    id: "retro-70s-groove",
    label: "70s Sunset Groove",
    category: "retro",
    tags: ["70s", "groove", "vintage", "warm"],
    fontFamily: "righteous",
    bold: false,
    color: "#fef08a",
    strokeColor: "#c2410c",
    strokeWidth: 3,
    strokeColor2: "#78350f",
    strokeWidth2: 3,
    shadowColor: "#451a03",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },
  {
    id: "retro-80s-synthwave",
    label: "80s Synthwave",
    category: "retro",
    tags: ["80s", "synthwave", "retrowave"],
    fontFamily: "bangers",
    bold: false,
    color: "#f472b6",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#f472b6" },
        { offset: 1, color: "#38bdf8" },
      ],
    },
    strokeColor: "#4c1d95",
    strokeWidth: 4,
    shadowColor: "#1e1b4b",
    shadowOffsetX: 5,
    shadowOffsetY: 5,
  },
  {
    id: "retro-90s-grunge",
    label: "90s Tape Grunge",
    category: "retro",
    tags: ["90s", "grunge", "tape", "skater"],
    fontFamily: "permanentmarker",
    bold: false,
    color: "#fafaf9",
    strokeColor: "#000000",
    strokeWidth: 3,
    shadowColor: "#000000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },
  {
    id: "retro-vaporwave",
    label: "Vaporwave Pastel",
    category: "retro",
    tags: ["vaporwave", "pastel", "nostalgia"],
    fontFamily: "comfortaa",
    bold: true,
    color: "#fbcfe8",
    gradient: {
      type: "linear",
      angleDeg: 90,
      stops: [
        { offset: 0, color: "#fbcfe8" },
        { offset: 1, color: "#a5f3fc" },
      ],
    },
    shadowColor: "#818cf8",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
    shadowBlur: 5,
  },
  {
    id: "retro-arcade",
    label: "8-Bit Pixel Arcade",
    category: "retro",
    tags: ["8bit", "pixel", "arcade", "game"],
    fontFamily: "pressstart2p",
    bold: false,
    color: "#facc15",
    strokeColor: "#000000",
    strokeWidth: 2,
    shadowColor: "#000000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },

  // ─── 10. Y2K & Chrome ────────────────────────────────────────────────────
  {
    id: "y2k-liquid-chrome",
    label: "Liquid Silver Chrome",
    category: "y2k",
    tags: ["chrome", "silver", "y2k", "metallic"],
    fontFamily: "orbitron",
    bold: true,
    color: "#ffffff",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 0.45, color: "#cbd5e1" },
        { offset: 0.5, color: "#334155" },
        { offset: 1, color: "#e2e8f0" },
      ],
    },
    strokeColor: "#0f172a",
    strokeWidth: 2,
    shadowColor: "#475569",
    shadowOffsetX: 2,
    shadowOffsetY: 3,
    shadowBlur: 4,
    textTransform: "uppercase",
  },
  {
    id: "y2k-cyber-pop",
    label: "Bubblegum Chrome",
    category: "y2k",
    tags: ["y2k", "pink", "pop", "bubble"],
    fontFamily: "fredoka",
    bold: true,
    color: "#f472b6",
    strokeColor: "#ffffff",
    strokeWidth: 3,
    shadowColor: "#db2777",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
    shadowBlur: 2,
  },
  {
    id: "y2k-futurism",
    label: "Y2K Titanium",
    category: "y2k",
    tags: ["titanium", "futurism", "metallic"],
    fontFamily: "josefinsans",
    bold: true,
    color: "#e2e8f0",
    letterSpacing: 5,
    textTransform: "uppercase",
    strokeColor: "#38bdf8",
    strokeWidth: 1,
    shadowColor: "#0284c7",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 6,
  },
  {
    id: "y2k-glitz",
    label: "Glitz Mirror Gold",
    category: "y2k",
    tags: ["gold", "glitz", "mirror", "y2k"],
    fontFamily: "montserrat",
    bold: true,
    color: "#fef08a",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#fef9c3" },
        { offset: 0.45, color: "#eab308" },
        { offset: 0.52, color: "#713f12" },
        { offset: 1, color: "#fef08a" },
      ],
    },
    strokeColor: "#000000",
    strokeWidth: 2,
    shadowColor: "rgba(0,0,0,0.6)",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
  },

  // ─── 11. Gaming & Esports ────────────────────────────────────────────────
  {
    id: "gaming-victory-royale",
    label: "Victory Royale",
    category: "gaming",
    tags: ["gaming", "victory", "gold", "esports"],
    fontFamily: "anton",
    bold: false,
    color: "#facc15",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#fde047" },
        { offset: 1, color: "#ea580c" },
      ],
    },
    strokeColor: "#000000",
    strokeWidth: 5,
    shadowColor: "#000000",
    shadowOffsetX: 5,
    shadowOffsetY: 5,
    textTransform: "uppercase",
  },
  {
    id: "gaming-stealth-tactical",
    label: "Tactical Spec-Ops",
    category: "gaming",
    tags: ["tactical", "esports", "military", "stealth"],
    fontFamily: "orbitron",
    bold: true,
    color: "#94a3b8",
    strokeColor: "#f97316",
    strokeWidth: 2,
    backgroundColor: "#020617",
    backgroundOpacity: 0.9,
    backgroundPadding: 8,
    backgroundCornerRadius: 2,
    textTransform: "uppercase",
  },
  {
    id: "gaming-respawn-glitch",
    label: "Respawn Cyan-Red",
    category: "gaming",
    tags: ["glitch", "respawn", "cyan", "red"],
    fontFamily: "rubik",
    bold: true,
    color: "#22d3ee",
    strokeColor: "#000000",
    strokeWidth: 3,
    shadowColor: "#ef4444",
    shadowOffsetX: 3,
    shadowOffsetY: -2,
  },
  {
    id: "gaming-boss-fight",
    label: "Boss Fight Crimson",
    category: "gaming",
    tags: ["boss", "crimson", "dark", "heavy"],
    fontFamily: "bangers",
    bold: false,
    color: "#dc2626",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#f87171" },
        { offset: 1, color: "#7f1d1d" },
      ],
    },
    strokeColor: "#000000",
    strokeWidth: 5,
    shadowColor: "#450a0a",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },

  // ─── 12. Comic & Pop Art ─────────────────────────────────────────────────
  {
    id: "comic-bold",
    label: "Comic Bold",
    category: "comic",
    tags: ["comic", "classic", "bold"],
    fontFamily: "bangers",
    color: "#ffffff",
    bold: true,
    strokeColor: "#000000",
    strokeWidth: 6,
  },
  {
    id: "comic-pow",
    label: "Comic POW! Action",
    category: "comic",
    tags: ["comic", "yellow", "superhero"],
    fontFamily: "bangers",
    bold: false,
    color: "#fde047",
    strokeColor: "#000000",
    strokeWidth: 6,
    shadowColor: "#000000",
    shadowOffsetX: 5,
    shadowOffsetY: 5,
  },
  {
    id: "comic-boom",
    label: "Double-Stroke BOOM",
    category: "comic",
    tags: ["popart", "double-stroke", "action"],
    fontFamily: "bungee",
    bold: false,
    color: "#ef4444",
    strokeColor: "#ffffff",
    strokeWidth: 3,
    strokeColor2: "#000000",
    strokeWidth2: 3,
    shadowColor: "#000000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },
  {
    id: "comic-speech-bubble",
    label: "Speech Bubble Ink",
    category: "comic",
    tags: ["bubble", "ink", "cartoon"],
    fontFamily: "fredoka",
    bold: true,
    color: "#000000",
    backgroundColor: "#ffffff",
    backgroundPadding: 12,
    backgroundCornerRadius: 16,
    strokeColor: "#000000",
    strokeWidth: 1,
  },

  // ─── 13. Luxury & Fashion ────────────────────────────────────────────────
  {
    id: "gold-elegant",
    label: "Gold Elegant",
    category: "luxury",
    tags: ["gold", "luxury", "elegant"],
    fontFamily: "playfairdisplay",
    color: "#ffd700",
    bold: false,
    strokeColor: "#3a2a00",
    strokeWidth: 2,
  },
  {
    id: "luxury-vogue-serif",
    label: "Vogue Haute Couture",
    category: "luxury",
    tags: ["vogue", "fashion", "serif", "high-end"],
    fontFamily: "playfairdisplay",
    bold: true,
    color: "#f8fafc",
    letterSpacing: 4,
    textTransform: "uppercase",
    shadowColor: "rgba(0,0,0,0.5)",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 4,
  },
  {
    id: "luxury-champagne-gold",
    label: "Champagne Silk",
    category: "luxury",
    tags: ["champagne", "gold", "silk", "soft"],
    fontFamily: "lora",
    bold: false,
    italic: true,
    color: "#fef3c7",
    letterSpacing: 2,
    shadowColor: "rgba(180,83,9,0.3)",
    shadowOffsetX: 1,
    shadowOffsetY: 2,
    shadowBlur: 4,
  },
  {
    id: "luxury-minimal-couture",
    label: "Minimal Parisian",
    category: "luxury",
    tags: ["parisian", "minimal", "couture", "clean"],
    fontFamily: "josefinsans",
    bold: true,
    color: "#f1f5f9",
    letterSpacing: 7,
    textTransform: "uppercase",
  },
  {
    id: "luxury-royal-bronze",
    label: "Royal Bronze Antiquity",
    category: "luxury",
    tags: ["bronze", "royal", "antique"],
    fontFamily: "librebaskerville",
    bold: true,
    color: "#f59e0b",
    gradient: {
      type: "linear",
      angleDeg: 90,
      stops: [
        { offset: 0, color: "#fbbf24" },
        { offset: 0.5, color: "#d97706" },
        { offset: 1, color: "#78350f" },
      ],
    },
    shadowColor: "rgba(0,0,0,0.7)",
    shadowOffsetX: 2,
    shadowOffsetY: 3,
  },

  // ─── 14. Cute & Playful ──────────────────────────────────────────────────
  {
    id: "cute-candy-pink",
    label: "Cotton Candy Pop",
    category: "cute",
    tags: ["candy", "pink", "cute", "playful"],
    fontFamily: "fredoka",
    bold: true,
    color: "#f472b6",
    strokeColor: "#ffffff",
    strokeWidth: 3,
    shadowColor: "#fbcfe8",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 4,
  },
  {
    id: "cute-marshmallow",
    label: "Fluffy Marshmallow",
    category: "cute",
    tags: ["marshmallow", "pastel", "soft", "cute"],
    fontFamily: "comfortaa",
    bold: true,
    color: "#fef08a",
    strokeColor: "#ffffff",
    strokeWidth: 2,
    shadowColor: "#e9d5ff",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
    shadowBlur: 2,
  },
  {
    id: "cute-mint-sprinkles",
    label: "Mint Sprinkles",
    category: "cute",
    tags: ["mint", "pastel", "fresh", "sweet"],
    fontFamily: "quicksand",
    bold: true,
    color: "#6ee7b7",
    strokeColor: "#065f46",
    strokeWidth: 2,
    shadowColor: "rgba(0,0,0,0.2)",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },
  {
    id: "cute-honey-bear",
    label: "Honey Bear Script",
    category: "cute",
    tags: ["honey", "handwritten", "warm", "cute"],
    fontFamily: "pacifico",
    bold: false,
    color: "#fde68a",
    strokeColor: "#78350f",
    strokeWidth: 2,
    shadowColor: "#451a03",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },

  // ─── 15. Gradient & Duotone ──────────────────────────────────────────────
  {
    id: "gradient-sunset-blaze",
    label: "Sunset Blaze",
    category: "gradient",
    tags: ["sunset", "orange", "magenta", "blaze"],
    fontFamily: "montserrat",
    bold: true,
    color: "#ff007f",
    gradient: {
      type: "linear",
      angleDeg: 90,
      stops: [
        { offset: 0, color: "#ff007f" },
        { offset: 0.5, color: "#7928ca" },
        { offset: 1, color: "#ff4b4b" },
      ],
    },
    shadowColor: "rgba(0,0,0,0.6)",
    shadowOffsetX: 2,
    shadowOffsetY: 3,
    shadowBlur: 4,
  },
  {
    id: "gradient-ocean-deep",
    label: "Deep Ocean Tide",
    category: "gradient",
    tags: ["ocean", "cyan", "blue", "water"],
    fontFamily: "poppins",
    bold: true,
    color: "#00c6ff",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#00c6ff" },
        { offset: 1, color: "#0072ff" },
      ],
    },
    strokeColor: "#ffffff",
    strokeWidth: 1,
    shadowColor: "rgba(0,114,255,0.4)",
    shadowOffsetX: 0,
    shadowOffsetY: 4,
    shadowBlur: 8,
  },
  {
    id: "gradient-cotton-candy",
    label: "Dreamy Pastel Duotone",
    category: "gradient",
    tags: ["duotone", "pastel", "dreamy"],
    fontFamily: "nunito",
    bold: true,
    color: "#f472b6",
    gradient: {
      type: "linear",
      angleDeg: 90,
      stops: [
        { offset: 0, color: "#f472b6" },
        { offset: 1, color: "#38bdf8" },
      ],
    },
    shadowColor: "rgba(0,0,0,0.3)",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },
  {
    id: "gradient-emerald-glow",
    label: "Emerald Aurora",
    category: "gradient",
    tags: ["emerald", "green", "aurora"],
    fontFamily: "rubik",
    bold: true,
    color: "#10b981",
    gradient: {
      type: "linear",
      angleDeg: 180,
      stops: [
        { offset: 0, color: "#a7f3d0" },
        { offset: 1, color: "#059669" },
      ],
    },
    shadowColor: "#064e3b",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },
  {
    id: "gradient-iridescent",
    label: "Holographic Pearl",
    category: "gradient",
    tags: ["holographic", "pearl", "iridescent"],
    fontFamily: "outfit",
    bold: true,
    color: "#fbcfe8",
    gradient: {
      type: "linear",
      angleDeg: 45,
      stops: [
        { offset: 0, color: "#fed7aa" },
        { offset: 0.35, color: "#fbcfe8" },
        { offset: 0.7, color: "#c4b5fd" },
        { offset: 1, color: "#a5f3fc" },
      ],
    },
    shadowColor: "rgba(0,0,0,0.5)",
    shadowOffsetX: 2,
    shadowOffsetY: 3,
    shadowBlur: 6,
  },

  // ─── 16. Meme & Viral ────────────────────────────────────────────────────
  {
    id: "meme-classic-impact",
    label: "Classic Top Meme",
    category: "meme",
    tags: ["meme", "impact", "classic", "viral"],
    fontFamily: "anton",
    bold: false,
    color: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 5,
    textTransform: "uppercase",
  },
  {
    id: "meme-bottom-text",
    label: "Yellow Highlight Bar",
    category: "meme",
    tags: ["meme", "highlight", "yellow"],
    fontFamily: "oswald",
    bold: true,
    color: "#000000",
    backgroundColor: "#facc15",
    backgroundPadding: 8,
    backgroundCornerRadius: 2,
    textTransform: "uppercase",
  },
  {
    id: "meme-breaking-news",
    label: "Breaking News Banner",
    category: "meme",
    tags: ["news", "breaking", "red", "banner"],
    fontFamily: "inter",
    bold: true,
    color: "#ffffff",
    backgroundColor: "#b91c1c",
    backgroundPadding: 10,
    backgroundCornerRadius: 0,
    textTransform: "uppercase",
  },
  {
    id: "meme-dank-comic",
    label: "Dank Meme Punch",
    category: "meme",
    tags: ["dank", "meme", "comic"],
    fontFamily: "bangers",
    bold: false,
    color: "#4ade80",
    strokeColor: "#000000",
    strokeWidth: 5,
    shadowColor: "#000000",
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },

  // ─── 17. Editorial & Serif ───────────────────────────────────────────────
  {
    id: "editorial-headline",
    label: "New York Times Headline",
    category: "editorial",
    tags: ["editorial", "headline", "times", "serif"],
    fontFamily: "merriweather",
    bold: true,
    color: "#ffffff",
    letterSpacing: 1,
    shadowColor: "rgba(0,0,0,0.8)",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },
  {
    id: "editorial-subhead",
    label: "Harper's Italic Sand",
    category: "editorial",
    tags: ["italic", "sand", "literary", "editorial"],
    fontFamily: "playfairdisplay",
    bold: false,
    italic: true,
    color: "#f5f5f4",
    letterSpacing: 2,
  },
  {
    id: "editorial-quote",
    label: "Literary Review Quote",
    category: "editorial",
    tags: ["quote", "literary", "thoughtful"],
    fontFamily: "lora",
    bold: true,
    color: "#fef3c7",
    lineHeightMultiplier: 1.4,
    shadowColor: "rgba(0,0,0,0.6)",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  },
  {
    id: "editorial-monograph",
    label: "Monograph Charcoal Band",
    category: "editorial",
    tags: ["monograph", "academic", "refined"],
    fontFamily: "librebaskerville",
    bold: true,
    color: "#f8fafc",
    backgroundColor: "rgba(30,41,59,0.85)",
    backgroundPadding: 8,
    backgroundCornerRadius: 4,
  },

  // ─── 18. Tech & Sci-Fi ───────────────────────────────────────────────────
  {
    id: "tech-terminal-green",
    label: "Phosphor Terminal",
    category: "tech",
    tags: ["terminal", "green", "matrix", "coder"],
    fontFamily: "orbitron",
    bold: true,
    color: "#4ade80",
    glowColor: "#22c55e",
    glowBlur: 12,
    letterSpacing: 3,
    textTransform: "uppercase",
  },
  {
    id: "tech-hud-interface",
    label: "HUD Sci-Fi Ice",
    category: "tech",
    tags: ["hud", "sci-fi", "ice-blue", "tech"],
    fontFamily: "barlow",
    bold: true,
    color: "#bae6fd",
    letterSpacing: 4,
    strokeColor: "#0284c7",
    strokeWidth: 1,
    textTransform: "uppercase",
  },
  {
    id: "tech-data-stream",
    label: "Data Stream Monochrome",
    category: "tech",
    tags: ["data", "stream", "minimal", "tech"],
    fontFamily: "dmsans",
    bold: true,
    color: "#f8fafc",
    letterSpacing: 3,
    shadowColor: "#06b6d4",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 4,
  },
  {
    id: "tech-glitch-future",
    label: "Glitch Anarchy",
    category: "tech",
    tags: ["glitch", "future", "anarchy"],
    fontFamily: "bungee",
    bold: false,
    color: "#a855f7",
    strokeColor: "#06b6d4",
    strokeWidth: 2,
    shadowColor: "#ec4899",
    shadowOffsetX: 3,
    shadowOffsetY: -2,
  },

  // ─── Preserved Legacy Presets ─────────────────────────────────────────────
  {
    id: "karaoke",
    label: "Karaoke",
    category: "social",
    tags: ["karaoke", "yellow"],
    fontFamily: "fredoka",
    color: "#ffe600",
    bold: false,
    strokeColor: "#000000",
    strokeWidth: 3,
  },
  {
    id: "yellow-highlight",
    label: "Yellow Highlight",
    category: "subtitle",
    tags: ["yellow", "highlight"],
    fontFamily: "inter",
    color: "#000000",
    bold: true,
    backgroundColor: "#ffe600",
  },
  {
    id: "soft-shadow",
    label: "Soft Shadow",
    category: "minimal",
    tags: ["shadow", "soft"],
    fontFamily: "inter",
    color: "#ffffff",
    bold: false,
    shadowColor: "#000000",
    shadowOffsetX: 3,
    shadowOffsetY: 3,
  },
  {
    id: "ocean-blue",
    label: "Ocean Blue",
    category: "gradient",
    tags: ["blue", "ocean"],
    fontFamily: "poppins",
    color: "#00d4ff",
    bold: false,
    strokeColor: "#003347",
    strokeWidth: 2,
  },
  {
    id: "red-alert",
    label: "Red Alert",
    category: "bold",
    tags: ["red", "alert"],
    fontFamily: "anton",
    color: "#ff3b30",
    bold: true,
    strokeColor: "#000000",
    strokeWidth: 3,
  },
];

/** Validates whether an untrusted or AI-generated object satisfies the TextStylePreset schema. */
export function validateTextStylePreset(raw: unknown): { valid: boolean; preset?: TextStylePreset; errors?: string[] } {
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["Preset must be a non-null object"] };
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.id !== "string" || !r.id.trim()) errors.push("Preset requires a non-empty 'id' string");
  if (typeof r.label !== "string" || !r.label.trim()) errors.push("Preset requires a non-empty 'label' string");
  if (typeof r.color !== "string" || !r.color.trim()) errors.push("Preset requires a valid 'color' string");
  if (typeof r.bold !== "boolean") errors.push("Preset requires a boolean 'bold' property");

  const validCategories: PresetCategory[] = [
    "trending",
    "minimal",
    "bold",
    "cinematic",
    "social",
    "subtitle",
    "neon",
    "glow",
    "retro",
    "y2k",
    "gaming",
    "comic",
    "luxury",
    "cute",
    "gradient",
    "meme",
    "editorial",
    "tech",
  ];

  const category = (typeof r.category === "string" && validCategories.includes(r.category as PresetCategory))
    ? (r.category as PresetCategory)
    : "trending";

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const preset: TextStylePreset = {
    id: String(r.id).trim(),
    label: String(r.label).trim(),
    category,
    bold: Boolean(r.bold),
    color: String(r.color).trim(),
    ...(typeof r.description === "string" ? { description: r.description } : null),
    ...(Array.isArray(r.tags) ? { tags: r.tags.filter((t): t is string => typeof t === "string") } : null),
    ...(typeof r.fontFamily === "string" ? { fontFamily: r.fontFamily } : null),
    ...(typeof r.fontSize === "number" && Number.isFinite(r.fontSize) ? { fontSize: r.fontSize } : null),
    ...(typeof r.italic === "boolean" ? { italic: r.italic } : null),
    ...(typeof r.letterSpacing === "number" && Number.isFinite(r.letterSpacing) ? { letterSpacing: r.letterSpacing } : null),
    ...(typeof r.lineHeightMultiplier === "number" && Number.isFinite(r.lineHeightMultiplier) ? { lineHeightMultiplier: r.lineHeightMultiplier } : null),
    ...(typeof r.textTransform === "string" && ["none", "uppercase", "lowercase", "capitalize"].includes(r.textTransform)
      ? { textTransform: r.textTransform as "none" | "uppercase" | "lowercase" | "capitalize" }
      : null),
    ...(typeof r.textDecoration === "string" && ["none", "underline", "line-through"].includes(r.textDecoration)
      ? { textDecoration: r.textDecoration as "none" | "underline" | "line-through" }
      : null),
    ...(typeof r.opacity === "number" && Number.isFinite(r.opacity) ? { opacity: Math.max(0, Math.min(1, r.opacity)) } : null),
    ...(typeof r.strokeColor === "string" ? { strokeColor: r.strokeColor } : null),
    ...(typeof r.strokeWidth === "number" && Number.isFinite(r.strokeWidth) ? { strokeWidth: Math.max(0, r.strokeWidth) } : null),
    ...(typeof r.strokeColor2 === "string" ? { strokeColor2: r.strokeColor2 } : null),
    ...(typeof r.strokeWidth2 === "number" && Number.isFinite(r.strokeWidth2) ? { strokeWidth2: Math.max(0, r.strokeWidth2) } : null),
    ...(typeof r.shadowColor === "string" ? { shadowColor: r.shadowColor } : null),
    ...(typeof r.shadowOffsetX === "number" && Number.isFinite(r.shadowOffsetX) ? { shadowOffsetX: r.shadowOffsetX } : null),
    ...(typeof r.shadowOffsetY === "number" && Number.isFinite(r.shadowOffsetY) ? { shadowOffsetY: r.shadowOffsetY } : null),
    ...(typeof r.shadowBlur === "number" && Number.isFinite(r.shadowBlur) ? { shadowBlur: Math.max(0, r.shadowBlur) } : null),
    ...(typeof r.glowColor === "string" ? { glowColor: r.glowColor } : null),
    ...(typeof r.glowBlur === "number" && Number.isFinite(r.glowBlur) ? { glowBlur: Math.max(0, r.glowBlur) } : null),
    ...(typeof r.backgroundColor === "string" ? { backgroundColor: r.backgroundColor } : null),
    ...(typeof r.backgroundOpacity === "number" && Number.isFinite(r.backgroundOpacity) ? { backgroundOpacity: Math.max(0, Math.min(1, r.backgroundOpacity)) } : null),
    ...(typeof r.backgroundPadding === "number" && Number.isFinite(r.backgroundPadding) ? { backgroundPadding: Math.max(0, r.backgroundPadding) } : null),
    ...(typeof r.backgroundCornerRadius === "number" && Number.isFinite(r.backgroundCornerRadius) ? { backgroundCornerRadius: Math.max(0, r.backgroundCornerRadius) } : null),
    ...(typeof r.blendMode === "string" ? { blendMode: r.blendMode as GlobalCompositeOperation } : null),
  };

  return { valid: true, preset };
}

/** Sanitizes any raw object or AI output into a safe, valid TextStylePreset, filling missing fields with defaults. */
export function sanitizeTextStylePreset(raw: unknown, fallback?: Partial<TextStylePreset>): TextStylePreset {
  const result = validateTextStylePreset(raw);
  if (result.valid && result.preset) return result.preset;

  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : fallback?.id ?? "custom-preset",
    label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : fallback?.label ?? "Custom Style",
    category: fallback?.category ?? "trending",
    color: typeof r.color === "string" && r.color.trim() ? r.color.trim() : fallback?.color ?? "#ffffff",
    bold: typeof r.bold === "boolean" ? r.bold : fallback?.bold ?? false,
    ...(typeof r.fontFamily === "string" ? { fontFamily: r.fontFamily } : null),
    ...(typeof r.strokeColor === "string" ? { strokeColor: r.strokeColor, strokeWidth: typeof r.strokeWidth === "number" ? r.strokeWidth : 3 } : null),
    ...(typeof r.shadowColor === "string" ? { shadowColor: r.shadowColor, shadowOffsetX: 2, shadowOffsetY: 2 } : null),
    ...(typeof r.glowColor === "string" ? { glowColor: r.glowColor, glowBlur: 16 } : null),
    ...(typeof r.backgroundColor === "string" ? { backgroundColor: r.backgroundColor } : null),
  };
}

/** Applies `preset` onto `current`, producing a new `TextStyle`.
 *  - Replaces visual styling (colors, fonts, outlines, shadows, glows, backgrounds, casing).
 *  - Strictly preserves text content, canvas position (`offsetX`/`offsetY`), rotation (`rotationDeg`), and duration/timing.
 *  - Clears unset optional styling keys to guarantee clean styling transitions without residual artifacts.
 */
export function applyTextStylePreset(
  current: TextStyle,
  preset: TextStylePreset,
  options?: { preserveFont?: boolean }
): TextStyle {
  const next: TextStyle = {
    ...current,
    color: preset.color,
    bold: preset.bold,
  };

  if (preset.fontFamily && !options?.preserveFont) {
    next.fontFamily = preset.fontFamily;
  }
  if (preset.italic !== undefined) {
    next.italic = preset.italic;
  }

  if (preset.letterSpacing !== undefined) next.letterSpacing = preset.letterSpacing;
  else delete next.letterSpacing;

  if (preset.lineHeightMultiplier !== undefined) next.lineHeightMultiplier = preset.lineHeightMultiplier;

  if (preset.textTransform !== undefined) next.textTransform = preset.textTransform;
  else delete next.textTransform;

  if (preset.textDecoration !== undefined) next.textDecoration = preset.textDecoration;
  else delete next.textDecoration;

  if (preset.opacity !== undefined) next.opacity = preset.opacity;
  else delete next.opacity;

  if (preset.blendMode !== undefined) next.blendMode = preset.blendMode;
  else delete next.blendMode;

  if (preset.gradient) next.gradient = preset.gradient;
  else delete next.gradient;

  if (preset.backgroundColor) {
    next.backgroundColor = preset.backgroundColor;
    if (preset.backgroundOpacity !== undefined) next.backgroundOpacity = preset.backgroundOpacity;
    else delete next.backgroundOpacity;
    if (preset.backgroundPadding !== undefined) next.backgroundPadding = preset.backgroundPadding;
    else delete next.backgroundPadding;
    if (preset.backgroundCornerRadius !== undefined) next.backgroundCornerRadius = preset.backgroundCornerRadius;
    else delete next.backgroundCornerRadius;
  } else {
    delete next.backgroundColor;
    delete next.backgroundOpacity;
    delete next.backgroundPadding;
    delete next.backgroundCornerRadius;
  }

  if (preset.strokeColor) {
    next.strokeColor = preset.strokeColor;
    next.strokeWidth = preset.strokeWidth ?? next.strokeWidth;
  } else {
    delete next.strokeColor;
  }

  if (preset.strokeColor2 && preset.strokeWidth2) {
    next.strokeColor2 = preset.strokeColor2;
    next.strokeWidth2 = preset.strokeWidth2;
  } else {
    delete next.strokeColor2;
    delete next.strokeWidth2;
  }

  if (preset.shadowColor) {
    next.shadowColor = preset.shadowColor;
    next.shadowOffsetX = preset.shadowOffsetX ?? next.shadowOffsetX;
    next.shadowOffsetY = preset.shadowOffsetY ?? next.shadowOffsetY;
    if (preset.shadowBlur !== undefined) next.shadowBlur = preset.shadowBlur;
    else delete next.shadowBlur;
  } else {
    delete next.shadowColor;
    delete next.shadowBlur;
  }

  if (preset.shadows && preset.shadows.length > 0) {
    next.shadows = preset.shadows;
  } else {
    delete next.shadows;
  }

  if (preset.glowColor) {
    next.glowColor = preset.glowColor;
    next.glowBlur = preset.glowBlur ?? 16;
  } else {
    delete next.glowColor;
    delete next.glowBlur;
  }

  return next;
}
