import api from './api';

// Types
export interface SavedInputFormData {
  clientName?: string;
  effectiveDate?: string;
  appraisalPurpose?: string;
  ownerName?: string;
  appraiser?: string;
  appraisalCompany?: string;
  industry?: string;
  inspectionDate?: string;
  contractNo?: string;
  language?: 'en' | 'fr' | 'es';
  currency?: string;
  includeValuationTable?: boolean;
  selectedValuationMethods?: Array<'FML' | 'TKV' | 'OLV' | 'FLV'>;
  preparedFor?: string;
  factorsAgeCondition?: string;
  factorsQuality?: string;
  factorsAnalysis?: string;
  includeDamageAnalysis?: boolean;
}

export interface SavedInput {
  _id: string;
  name: string;
  formType: 'asset' | 'realEstate';
  formData: SavedInputFormData;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSavedInputPayload {
  name: string;
  formType: 'asset' | 'realEstate';
  formData: SavedInputFormData;
}

const savedInputService = {
  /**
   * Create a new saved input
   */
  async create(payload: CreateSavedInputPayload): Promise<SavedInput> {
    const response = await api.post<{ message: string; data: SavedInput }>('/saved-inputs', payload);
    return response.data.data;
  },

  /**
   * Get all saved inputs for current user
   */
  async getAll(formType?: 'asset' | 'realEstate'): Promise<SavedInput[]> {
    const params = formType ? { formType } : {};
    const response = await api.get<{ message: string; data: SavedInput[] }>('/saved-inputs', { params });
    return response.data.data;
  },

  /**
   * Get a single saved input by ID
   */
  async getById(id: string): Promise<SavedInput> {
    const response = await api.get<{ message: string; data: SavedInput }>(`/saved-inputs/${id}`);
    return response.data.data;
  },

  /**
   * Update a saved input
   */
  async update(id: string, payload: Partial<CreateSavedInputPayload>): Promise<SavedInput> {
    const response = await api.put<{ message: string; data: SavedInput }>(`/saved-inputs/${id}`, payload);
    return response.data.data;
  },

  /**
   * Delete a saved input
   */
  async delete(id: string): Promise<void> {
    await api.delete(`/saved-inputs/${id}`);
  },
};

export default savedInputService;
