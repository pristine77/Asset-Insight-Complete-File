import API from "@/lib/api";

// Asset form data
export type AssetFormData = {
  clientName?: string;
  effectiveDate?: string;
  appraisalPurpose?: string;
  ownerName?: string;
  appraiser?: string;
  appraisalCompany?: string;
  industry?: string;
  inspectionDate?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  contractNo?: string;
  language?: "en" | "fr" | "es";
  currency?: string;
  includeValuationTable?: boolean;
  selectedValuationMethods?: Array<"FML" | "TKV" | "OLV" | "FLV">;
  groupingMode?: "single_lot" | "per_item" | "per_photo" | "catalogue" | "combined" | "mixed";
  combinedModes?: Array<"single_lot" | "per_item" | "per_photo">;
  preparedFor?: string;
  factorsAgeCondition?: string;
  factorsQuality?: string;
  factorsAnalysis?: string;
  includeDamageAnalysis?: boolean;
  bankPhotosEnabled?: boolean;
  watermarkImages?: boolean;
};

// Real Estate form data
export type RealEstateFormData = {
  language?: "en" | "fr" | "es";
  property_type?: "residential" | "commercial" | "agricultural";
  property_details?: {
    owner_name?: string;
    address?: string;
    land_description?: string;
    latitude?: string;
    longitude?: string;
    municipality?: string;
    title_number?: string;
  };
  report_dates?: {
    report_date?: string;
    effective_date?: string;
    inspection_date?: string;
  };
  house_details?: {
    year_built?: string;
    square_footage?: string;
    lot_size_sqft?: string;
    number_of_rooms?: string;
    number_of_full_bathrooms?: string;
    number_of_half_bathrooms?: string;
    known_issues?: string[];
  };
  farmland_details?: {
    total_title_acres?: number;
    cultivated_acres?: number;
    rm_area?: string;
    soil_class?: string;
    crop_type?: string;
    access_quality?: "excellent" | "good" | "fair" | "poor";
    distance_to_city_km?: number;
    is_rented?: boolean;
    irrigation?: boolean;
    annual_rent_per_acre?: number;
  };
};

export type SavedInputFormData = AssetFormData | RealEstateFormData;
export type FormType = "asset" | "realEstate";

export type SavedInput = {
  _id: string;
  user: string;
  name: string;
  formType: FormType;
  formData: SavedInputFormData;
  createdAt: string;
  updatedAt: string;
};

export type CreateSavedInputPayload = {
  name: string;
  formType?: FormType;
  formData: SavedInputFormData;
};

export type UpdateSavedInputPayload = {
  name?: string;
  formData?: SavedInputFormData;
};

export type DraftFileMetadata = {
  clientFileId: string;
  size: number;
  lastModified: number;
};

// Draft image data type for cross-device sync (URL-based, not base64)
export type DraftImageData = Partial<DraftFileMetadata> & {
  lotId: string;
  type: "main" | "extra" | "video";
  name: string;
  url: string; // Server file URL
  mimeType: string;
};

export type SaveDraftPayload = {
  formType?: FormType;
  formData: SavedInputFormData & { lots?: any[] };
  draftImages?: DraftImageData[];
};

export type DraftResponse = SavedInput & {
  isDraft: boolean;
  draftImages?: DraftImageData[];
};

// Upload response type
export type DraftUploadResponse = {
  message: string;
  data: DraftImageData[];
};

export type DraftUploadBatch = {
  files: File[];
  lotId: string;
  type: "main" | "extra" | "video";
};

const draftFileIds = new WeakMap<File, string>();

function createClientFileId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Associates a browser File with an identity that can be persisted alongside
 * its server URL. Supplying a persisted ID rehydrates the same identity after
 * a local or cross-device draft restore.
 */
export function getDraftFileMetadata(
  file: File,
  persisted?: Partial<DraftFileMetadata>
): DraftFileMetadata {
  const persistedId =
    typeof persisted?.clientFileId === "string" && persisted.clientFileId
      ? persisted.clientFileId
      : null;
  const clientFileId =
    persistedId || draftFileIds.get(file) || createClientFileId();
  draftFileIds.set(file, clientFileId);
  return {
    clientFileId,
    size:
      typeof persisted?.size === "number" ? persisted.size : file.size,
    lastModified:
      typeof persisted?.lastModified === "number"
        ? persisted.lastModified
        : file.lastModified || 0,
  };
}

export function getKnownDraftFileId(file: File) {
  return draftFileIds.get(file);
}

async function runUploadBatches(
  batches: DraftUploadBatch[],
  upload: (batch: DraftUploadBatch) => Promise<DraftImageData[]>,
  concurrency: number
) {
  if (batches.length === 0) return [];
  const results: DraftImageData[][] = new Array(batches.length);
  let nextIndex = 0;
  let hasFailure = false;
  let failure: unknown;
  const requestedConcurrency = Number.isFinite(concurrency)
    ? Math.floor(concurrency)
    : 1;
  const workerCount = Math.min(
    batches.length,
    Math.max(1, requestedConcurrency)
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < batches.length && !hasFailure) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await upload(batches[index]);
        } catch (error) {
          if (!hasFailure) failure = error;
          hasFailure = true;
        }
      }
    })
  );

  if (hasFailure) throw failure;
  return results.flat();
}

export const SavedInputService = {
  async create(payload: CreateSavedInputPayload): Promise<SavedInput> {
    const { data } = await API.post<{ message: string; data: SavedInput }>(
      "/saved-inputs",
      payload
    );
    return data.data;
  },

  async getAll(formType?: FormType): Promise<SavedInput[]> {
    const params = formType ? `?formType=${formType}` : "";
    const { data } = await API.get<{ message: string; data: SavedInput[] }>(
      `/saved-inputs${params}`
    );
    return data.data;
  },

  async getById(id: string): Promise<SavedInput> {
    const { data } = await API.get<{ message: string; data: SavedInput }>(
      `/saved-inputs/${id}`
    );
    return data.data;
  },

  async update(id: string, payload: UpdateSavedInputPayload): Promise<SavedInput> {
    const { data } = await API.put<{ message: string; data: SavedInput }>(
      `/saved-inputs/${id}`,
      payload
    );
    return data.data;
  },

  async delete(id: string): Promise<void> {
    await API.delete(`/saved-inputs/${id}`);
  },

  // Draft methods for cross-device sync
  async saveDraft(payload: SaveDraftPayload): Promise<DraftResponse> {
    const { data } = await API.post<{ message: string; data: DraftResponse }>(
      "/saved-inputs/draft",
      payload
    );
    return data.data;
  },

  async getDraft(formType?: FormType): Promise<DraftResponse | null> {
    try {
      const params = formType ? `?formType=${formType}` : "";
      const { data } = await API.get<{ message: string; data: DraftResponse }>(
        `/saved-inputs/draft${params}`
      );
      return data.data;
    } catch (error: any) {
      // 404 means no draft exists, which is fine
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  },

  async deleteDraft(formType?: FormType): Promise<void> {
    const params = formType ? `?formType=${formType}` : "";
    await API.delete(`/saved-inputs/draft${params}`);
  },

  // Upload draft images as files (fast, no base64 conversion)
  async uploadDraftImages(
    files: File[],
    lotId: string,
    type: "main" | "extra" | "video" = "main"
  ): Promise<DraftImageData[]> {
    const formData = new FormData();
    formData.append("lotId", lotId);
    formData.append("type", type);
    formData.append(
      "metadata",
      JSON.stringify(files.map((file) => getDraftFileMetadata(file)))
    );
    
    for (const file of files) {
      formData.append("images", file);
    }

    const { data } = await API.post<DraftUploadResponse>(
      "/saved-inputs/draft/upload",
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
      }
    );
    return data.data.map((image, index) => {
      const file = files[index];
      return file
        ? { ...image, ...getDraftFileMetadata(file, image) }
        : image;
    });
  },

  async uploadDraftImageBatches(
    batches: DraftUploadBatch[],
    concurrency = 3
  ): Promise<DraftImageData[]> {
    const uploaded: DraftImageData[] = [];
    try {
      return await runUploadBatches(
        batches,
        async ({ files, lotId, type }) => {
          const result = await SavedInputService.uploadDraftImages(
            files,
            lotId,
            type
          );
          uploaded.push(...result);
          return result;
        },
        concurrency
      );
    } catch (error) {
      await SavedInputService.deleteDraftImagesByUrls(
        uploaded.map((item) => item.url)
      ).catch(() => undefined);
      throw error;
    }
  },

  // Delete all draft images for current user
  async deleteDraftImages(): Promise<void> {
    await API.delete("/saved-inputs/draft/images");
  },

  async deleteDraftImagesByUrls(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    await API.post("/saved-inputs/draft/delete-images", { urls });
  },
};
