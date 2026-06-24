// scrollStory.js 的类型声明:用真实数据初始化 scroll story,返回卸载清理函数。
export interface StoryData {
  albums?: Array<{ id: string; title?: string; artist?: string; year: number; ageBin?: string; image: string;[k: string]: unknown }>;
  ageAlbums?: Array<{ id: string; title?: string; artist?: string; year: number; age?: number; ageBin?: string; image: string;[k: string]: unknown }>;
  artists?: Array<{ id: string; name?: string; year: number; age?: number; ageBin?: string; image: string;[k: string]: unknown }>;
  yearCounts?: Record<string, number>;
}
export function initScrollStory(storyData?: StoryData): () => void;
