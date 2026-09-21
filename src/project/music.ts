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
  icon: string;
}

export const MUSIC_CATEGORIES: MusicCategoryDefinition[] = [
  { id: "all", label: "All Music", icon: "🎵" },
  { id: "trending", label: "Viral & Trending", icon: "🔥" },
  { id: "upbeat", label: "Upbeat & Energy", icon: "⚡" },
  { id: "phonk", label: "Phonk & Bass", icon: "🎧" },
  { id: "lofi", label: "Lo-Fi & Chill", icon: "☕" },
  { id: "cinematic", label: "Cinematic", icon: "🎬" },
  { id: "pop", label: "Pop & Dance", icon: "🎉" },
  { id: "travel", label: "Travel & Vlog", icon: "🌴" },
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
 *  URLs point to fast public CDN streams (Free Music Archive / Wikimedia / Pixabay / Archive audio)
 *  and can be previewed seamlessly and imported into any project. */
export const VIRAL_MUSIC_CATALOG: MusicTrack[] = [
  {
    id: "track-neon-drift",
    title: "Neon Drift",
    artist: "Kavinsky Phonk",
    category: "phonk",
    duration: 135,
    bpm: 140,
    tags: ["phonk", "drift", "bass", "gym", "viral", "reels"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c8a73467.mp3?filename=phonk-drift-110052.mp3",
    featured: true,
  },
  {
    id: "track-tokyo-rain",
    title: "Tokyo Rain (Lo-Fi Study)",
    artist: "Sakura Beats",
    category: "lofi",
    duration: 154,
    bpm: 84,
    tags: ["lofi", "chill", "study", "relax", "aesthetic", "vlog"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3?filename=lofi-study-112191.mp3",
    featured: true,
  },
  {
    id: "track-golden-summer",
    title: "Golden Summer Vibes",
    artist: "Sunny Days",
    category: "upbeat",
    duration: 128,
    bpm: 120,
    tags: ["upbeat", "summer", "happy", "travel", "vlog", "lifestyle"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/01/18/audio_d0a13f69d2.mp3?filename=summer-travel-10023.mp3",
    featured: true,
  },
  {
    id: "track-midnight-cyber",
    title: "Midnight City Rush",
    artist: "SynthWave Collective",
    category: "trending",
    duration: 142,
    bpm: 126,
    tags: ["synthwave", "viral", "trending", "retro", "car", "speed"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/10/14/audio_9939f77cd0.mp3?filename=synthwave-80s-110045.mp3",
    featured: true,
  },
  {
    id: "track-rise-glory",
    title: "Rise of the Titans",
    artist: "Nordic Cinematic",
    category: "cinematic",
    duration: 186,
    bpm: 95,
    tags: ["cinematic", "epic", "trailer", "dramatic", "orchestra"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/03/10/audio_502cb2e1e3.mp3?filename=cinematic-epic-109033.mp3",
    featured: true,
  },
  {
    id: "track-sunlit-acoustic",
    title: "Sunlit Memories",
    artist: "Oliver Green",
    category: "travel",
    duration: 118,
    bpm: 108,
    tags: ["acoustic", "guitar", "travel", "nature", "warm", "vlog"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/01/21/audio_31743c5895.mp3?filename=acoustic-vlog-10250.mp3",
    featured: false,
  },
  {
    id: "track-hyper-bounce",
    title: "Hyper Bounce Club",
    artist: "DJ Nova",
    category: "pop",
    duration: 132,
    bpm: 128,
    tags: ["pop", "dance", "club", "party", "energy", "trend"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/11/06/audio_9ec16972ef.mp3?filename=pop-dance-125438.mp3",
    featured: true,
  },
  {
    id: "track-tokyo-night-drift",
    title: "Tokyo Underground Phonk",
    artist: "Ghost Rider",
    category: "phonk",
    duration: 124,
    bpm: 145,
    tags: ["phonk", "drift", "bass", "dark", "speed"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2023/02/28/audio_550742f38e.mp3?filename=tokyo-drift-phonk-141380.mp3",
    featured: false,
  },
  {
    id: "track-cozy-rain-cafe",
    title: "Coffee & Gentle Rain",
    artist: "Mellow Moments",
    category: "lofi",
    duration: 165,
    bpm: 78,
    tags: ["lofi", "cafe", "rain", "cozy", "relax", "chill"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/08/02/audio_884fe92c21.mp3?filename=cozy-lofi-117565.mp3",
    featured: false,
  },
  {
    id: "track-trending-trap-beat",
    title: "Viral Trap Anthem",
    artist: "Metro King",
    category: "trending",
    duration: 140,
    bpm: 138,
    tags: ["trap", "hiphop", "viral", "tiktok", "reels", "beat"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/05/16/audio_db6591201e.mp3?filename=trap-beat-111706.mp3",
    featured: true,
  },
  {
    id: "track-feel-good-groove",
    title: "Feel Good Funk",
    artist: "The Groove Masters",
    category: "upbeat",
    duration: 145,
    bpm: 116,
    tags: ["funk", "groove", "happy", "commercial", "dance"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/02/07/audio_1975e523f6.mp3?filename=feel-good-groove-10440.mp3",
    featured: false,
  },
  {
    id: "track-cinematic-hope",
    title: "Horizon of Hope",
    artist: "Aether Symphony",
    category: "cinematic",
    duration: 195,
    bpm: 88,
    tags: ["cinematic", "piano", "emotional", "inspirational", "documentary"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/03/15/audio_24859a1cf6.mp3?filename=inspirational-cinematic-110022.mp3",
    featured: false,
  },
  {
    id: "track-bali-breeze",
    title: "Bali Sunset Breeze",
    artist: "Island Wanderer",
    category: "travel",
    duration: 138,
    bpm: 110,
    tags: ["tropical", "travel", "vacation", "chill", "island"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/04/27/audio_3062334860.mp3?filename=tropical-travel-111008.mp3",
    featured: false,
  },
  {
    id: "track-future-pop",
    title: "Electric Starlight",
    artist: "Aura Pop",
    category: "pop",
    duration: 148,
    bpm: 124,
    tags: ["future-pop", "catchy", "radio", "party", "synth"],
    audioUrl: "https://cdn.pixabay.com/download/audio/2022/09/27/audio_03d2e3f5b0.mp3?filename=future-pop-121650.mp3",
    featured: false,
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

