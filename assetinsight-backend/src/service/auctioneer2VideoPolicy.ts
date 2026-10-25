/** Auctioneer accepts one YouTube link per lot, never original video bytes. */
export function auctioneerYoutubeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  let id = /^[A-Za-z0-9_-]{11}$/.test(raw) ? raw : "";
  if (!id) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      const host = url.hostname.toLowerCase();
      if (host === "youtu.be") id = url.pathname.slice(1);
      else if (["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"].includes(host)) {
        id = url.pathname === "/watch" ? url.searchParams.get("v") || "" : /^\/(?:embed|shorts)\/([^/]+)$/.exec(url.pathname)?.[1] || "";
      }
    } catch { return null; }
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function lotVideoSources(lot: any): string[] {
  return [...new Set([...(Array.isArray(lot?.video_urls) ? lot.video_urls : []),
    ...(Array.isArray(lot?.videoUrls) ? lot.videoUrls : [])]
    .filter((value): value is string => typeof value === "string").map(value => value.trim()).filter(Boolean))];
}

/** Legacy retry reads only its frozen lot; a root/report clip is never another lot's fallback. */
export function frozenAuctioneerVideo(manifest: any, _lot: any, index: number): string | null {
  if (manifest?.videoOrderVersion === 1) {
    const value = manifest.videoUrlsByLot?.[index];
    if (value === null) return null;
    const url = auctioneerYoutubeUrl(value);
    if (!url) throw new Error("Invalid frozen Auctioneer video manifest");
    return url;
  }
  // An older worker may fall back to live report lots for photos. That is not
  // authorization to start sending a later edit's video on a legacy retry.
  const savedLot = Array.isArray(manifest?.previewData?.lots) ? manifest.previewData.lots[index] : null;
  return lotVideoSources(savedLot).map(auctioneerYoutubeUrl).find(Boolean) || null;
}
