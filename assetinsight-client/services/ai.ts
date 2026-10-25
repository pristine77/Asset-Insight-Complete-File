import type { RealEstateDetails } from "@/services/realEstate";

export type RealEstateDetailsPatch = {
  property_details?: Partial<RealEstateDetails["property_details"]>;
  report_dates?: Partial<RealEstateDetails["report_dates"]>;
  house_details?: Partial<RealEstateDetails["house_details"]>;
  inspector_info?: Partial<RealEstateDetails["inspector_info"]>;
};

const jsonHeaders = { "Content-Type": "application/json" } as const;

export const AIService = {
  async fillFromSpecSheet(files: File[]): Promise<RealEstateDetailsPatch> {
    const fd = new FormData();
    // Support up to 5 images
    files.slice(0, 5).forEach((file, i) => {
      fd.append(`file${i}`, file);
    });
    const res = await fetch("/api/ai/real-estate/from-spec", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to analyze spec sheet");
    const data = (await res.json()) as { details?: RealEstateDetailsPatch };
    return data.details || {};
  },

  async fillFromAudio(file: File): Promise<RealEstateDetailsPatch> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/ai/real-estate/from-audio", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to process audio");
    const data = (await res.json()) as { details?: RealEstateDetailsPatch; transcript?: string };
    return data.details || {};
  },

  async fillFromText(text: string): Promise<RealEstateDetailsPatch> {
    const res = await fetch("/api/ai/real-estate/from-text", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to process text");
    const data = (await res.json()) as { details?: RealEstateDetailsPatch };
    return data.details || {};
  },
};
