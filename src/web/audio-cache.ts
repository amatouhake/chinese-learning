import type { PronunciationCard } from "../domain/types";

export const PRONUNCIATION_AUDIO_CACHE = "chinese-learning-pronunciation-audio-v1";

export interface AudioCacheResult {
  cachedUrls: string[];
  failedUrls: string[];
}

export async function cachePronunciationAudio(
  cards: readonly PronunciationCard[],
  cacheStorage: CacheStorage = caches,
  fetcher: typeof fetch = fetch,
): Promise<AudioCacheResult> {
  const urls = [
    ...new Set(
      cards.map((card) => card.media?.url).filter((url): url is string => typeof url === "string"),
    ),
  ];
  const cache = await cacheStorage.open(PRONUNCIATION_AUDIO_CACHE);
  const cachedUrls: string[] = [];
  const failedUrls: string[] = [];
  for (const url of urls) {
    if (await cache.match(url)) {
      cachedUrls.push(url);
      continue;
    }
    try {
      const response = await fetcher(url, { cache: "no-store" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.startsWith("audio/")) {
        failedUrls.push(url);
        continue;
      }
      await cache.put(url, response.clone());
      cachedUrls.push(url);
    } catch {
      failedUrls.push(url);
    }
  }
  return { cachedUrls, failedUrls };
}

export async function isPronunciationAudioCached(
  card: PronunciationCard,
  cacheStorage: CacheStorage = caches,
): Promise<boolean> {
  if (!card.activityType.startsWith("audio_to_") || !card.media) return true;
  const cache = await cacheStorage.open(PRONUNCIATION_AUDIO_CACHE);
  return (await cache.match(card.media.url)) !== undefined;
}
