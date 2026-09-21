/** Curated catalog and registry of trending & viral music tracks for the Music tool (`MusicPanel.tsx`).
 *  Provides categorization (Viral & Trending, Upbeat, Phonk, Lo-Fi, Cinematic, Pop, Travel), tags,
 *  preview audio streams, and metadata. */

export type MusicCategory =
  | "all"
  | "trending"
  | "upbeat"
  | "phonk"
  | "lofi"
  | "cinematic"
  | "pop"
  | "travel";

export interface MusicCategoryDefinition {
  id: MusicCategory;
  label: string;
  icon: MusicCategory;
}

export const MUSIC_CATEGORIES: MusicCategoryDefinition[] = [
  { id: "all", label: "All Music", icon: "all" },
  { id: "trending", label: "Viral & Trending", icon: "trending" },
  { id: "upbeat", label: "Upbeat & Energy", icon: "upbeat" },
  { id: "phonk", label: "Phonk & Bass", icon: "phonk" },
  { id: "lofi", label: "Lo-Fi & Chill", icon: "lofi" },
  { id: "cinematic", label: "Cinematic", icon: "cinematic" },
  { id: "pop", label: "Pop & Dance", icon: "pop" },
  { id: "travel", label: "Travel & Vlog", icon: "travel" },
];

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  category: Exclude<MusicCategory, "all">;
  duration: number; // in seconds
  bpm?: number;
  tags: string[];
  audioUrl: string;
  coverUrl?: string;
  featured?: boolean;
}

/** High-quality, reliable, royalty-free audio tracks representing trending TikTok/Reels sound formats.
 *  URLs point to local bundled assets served via `/api/vcut/music/file/...`, providing instant playback
 *  with zero buffering, zero third-party blocks, and seamless offline/native support. */
export const VIRAL_MUSIC_CATALOG: MusicTrack[] = [
  {
    id: "track-scheming-weasel",
    title: "Scheming Weasel (Viral Hook)",
    artist: "Kevin MacLeod",
    category: "trending",
    duration: 79,
    bpm: 130,
    tags: ["viral", "trending", "comedy", "funny", "tiktok", "reels", "meme"],
    audioUrl: "/api/vcut/music/file/scheming-weasel.mp3",
    featured: true,
  },
  {
    id: "track-curb-frolic",
    title: "Frolic Theme (Curb Meme)",
    artist: "Luciano Michelini",
    category: "trending",
    duration: 180,
    bpm: 124,
    tags: ["curb", "meme", "viral", "comedy", "outro", "tiktok"],
    audioUrl: "/api/vcut/music/file/curb-your-enthusiasm.mp3",
    featured: true,
  },
  {
    id: "track-brain-trust",
    title: "Brain Trust (Lo-Fi Study Beat)",
    artist: "Wayne Jones",
    category: "lofi",
    duration: 104,
    bpm: 88,
    tags: ["lofi", "chill", "study", "relax", "aesthetic", "vlog", "focus"],
    audioUrl: "/api/vcut/music/file/brain-trust.mp3",
    featured: true,
  },
  {
    id: "track-kimi-toriko",
    title: "Summertime (Kimi No Toriko)",
    artist: "Maggie & Natsu",
    category: "pop",
    duration: 35,
    bpm: 118,
    tags: ["pop", "dance", "summertime", "cute", "anime", "tiktok", "reels"],
    audioUrl: "/api/vcut/music/file/kimi-no-toriko.mp3",
    featured: true,
  },
  {
    id: "track-happy-cat",
    title: "Happy Cat Bounce",
    artist: "TikTok Hits",
    category: "upbeat",
    duration: 25,
    bpm: 135,
    tags: ["upbeat", "happy", "cat", "energy", "viral", "fun", "dance"],
    audioUrl: "/api/vcut/music/file/happy-happy-happy-cat.mp3",
    featured: true,
  },
  {
    id: "track-aesthetic-vlog",
    title: "Aesthetic Daily Vlog",
    artist: "Indie Chill Vibes",
    category: "travel",
    duration: 65,
    bpm: 110,
    tags: ["vlog", "travel", "aesthetic", "lifestyle", "chill", "summer"],
    audioUrl: "/api/vcut/music/file/background-music.mp3",
    featured: false,
  },
  {
    id: "track-elevator-bossa",
    title: "Elevator Bossa Nova",
    artist: "Smooth Lounge Trio",
    category: "lofi",
    duration: 45,
    bpm: 92,
    tags: ["lofi", "bossa-nova", "chill", "elevator", "smooth", "cozy"],
    audioUrl: "/api/vcut/music/file/elevator-music-short.mp3",
    featured: false,
  },
  {
    id: "track-ocean-breeze",
    title: "Ocean Wave Drift",
    artist: "Coastal Beats",
    category: "lofi",
    duration: 40,
    bpm: 80,
    tags: ["lofi", "ocean", "chill", "relax", "water", "nature", "ambient"],
    audioUrl: "/api/vcut/music/file/ocean-meme.mp3",
    featured: false,
  },
  {
    id: "track-phonk-riser",
    title: "Night Drift Tension Riser",
    artist: "Cyber Phonk Lab",
    category: "phonk",
    duration: 55,
    bpm: 140,
    tags: ["phonk", "drift", "bass", "gym", "riser", "energy", "speed"],
    audioUrl: "/api/vcut/music/file/riser-tension.mp3",
    featured: true,
  },
  {
    id: "track-sad-violin",
    title: "Dramatic Melancholy",
    artist: "Classic Symphony",
    category: "cinematic",
    duration: 90,
    bpm: 72,
    tags: ["cinematic", "sad", "violin", "dramatic", "emotional", "trailer"],
    audioUrl: "/api/vcut/music/file/sad-violin-classic.mp3",
    featured: false,
  },
  {
    id: "track-retro-synth-credits",
    title: "Retro Synth End Credits",
    artist: "80s Dreamscape",
    category: "upbeat",
    duration: 42,
    bpm: 125,
    tags: ["synthwave", "retro", "80s", "credits", "upbeat", "dance"],
    audioUrl: "/api/vcut/music/file/end-credits-meme.mp3",
    featured: false,
  },
  {
    id: "track-cinematic-suspense",
    title: "Sudden Impact & Suspense",
    artist: "Cinema Soundworks",
    category: "cinematic",
    duration: 52,
    bpm: 95,
    tags: ["cinematic", "suspense", "tension", "trailer", "epic", "thriller"],
    audioUrl: "/api/vcut/music/file/panic-suspense.mp3",
    featured: false,
  },
  {
    id: "track-snowflakes-drifting",
    title: "Xue Hua Piao Piao (Yi Jian Mei)",
    artist: "Viral Asia Hits",
    category: "trending",
    duration: 72,
    bpm: 105,
    tags: ["viral", "trending", "xue-hua-piao-piao", "meme", "reels", "tiktok"],
    audioUrl: "/api/vcut/music/file/tiktok-china-sound-1.mp3",
    featured: true,
  },
  {
    id: "track-red-sun-horizon",
    title: "Red Sun Horizon",
    artist: "East Beats",
    category: "trending",
    duration: 62,
    bpm: 115,
    tags: ["viral", "meme", "trending", "tiktok", "anthem", "reels"],
    audioUrl: "/api/vcut/music/file/tiktok-china-sound-2.mp3",
    featured: false,
  },
  {
    id: "track-super-idol",
    title: "Super Idol Sunshine Melody",
    artist: "Sweet Pop Beat",
    category: "pop",
    duration: 85,
    bpm: 120,
    tags: ["pop", "super-idol", "cute", "catchy", "dance", "tiktok", "viral"],
    audioUrl: "/api/vcut/music/file/tiktok-china-sound-3.mp3",
    featured: true,
  },
];

/** Filters the music catalog by category and search query. */
export function filterMusicCatalog(
  category: MusicCategory = "all",
  query: string = ""
): MusicTrack[] {
  const normalizedQuery = query.trim().toLowerCase();
  return VIRAL_MUSIC_CATALOG.filter((track) => {
    const matchesCategory =
      category === "all" ||
      track.category === category ||
      (category === "trending" && track.featured);
    if (!matchesCategory) return false;
    if (!normalizedQuery) return true;
    return (
      track.title.toLowerCase().includes(normalizedQuery) ||
      track.artist.toLowerCase().includes(normalizedQuery) ||
      track.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
    );
  });
}
