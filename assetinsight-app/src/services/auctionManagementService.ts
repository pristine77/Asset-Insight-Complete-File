import api from './api';

export type AuctionManagementTaskStatus = 'incoming' | 'in_progress' | 'completed';
export type AuctionManagementDestination = 'LottingBoard' | 'OpToDoBoard';

export interface AuctionManagementServiceItem {
  rowGuid: string;
  revenueContractId: string;
  serviceName: string;
  defaultPrice?: string;
  unit?: string;
  gstPercent?: string;
  pstPercent?: string;
}

export interface AuctionManagementTaskLot {
  id: string;
  label: string;
  source: string;
  scheduleALotId?: string | null;
  sourceLotId?: string | null;
  lotNumber?: string | number | null;
  year?: string | null;
  make?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  description?: string | null;
  reserve?: string | number | null;
  selectedServiceIds?: string[];
}

export interface AuctionManagementTaskPayload {
  task: {
    rowGuid: string;
    status: AuctionManagementTaskStatus;
    sentAt?: string;
    openedAt?: string | null;
    completedAt?: string | null;
    pushStatus?: string | null;
    lastError?: string | null;
  };
  contract: {
    rowGuid: string;
    contractNumber?: string | null;
    saleLocation?: string | null;
    expectedArrivalDate?: string | null;
    auctionType?: string | null;
    description?: string | null;
    notes?: string | null;
  };
  customer?: {
    rowGuid: string;
    customerNumber?: string | null;
    name?: string | null;
    company?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  event?: {
    rowGuid: string;
    title?: string | null;
    eventDate?: string | null;
    closeDate?: string | null;
    location?: string | null;
    city?: string | null;
    province?: string | null;
    status?: string | null;
  } | null;
  lots: AuctionManagementTaskLot[];
  serviceCatalog: {
    rowGuid: string;
    contractCode?: string | null;
    name?: string | null;
    description?: string | null;
    services: AuctionManagementServiceItem[];
  }[];
}

function toAuctionManagementError(error: any) {
  const data = error?.response?.data;
  const message =
    data?.message ||
    data?.error?.message ||
    error?.message ||
    'Auction Management request failed.';
  const status = error?.response?.status;
  return new Error(status ? `${message}` : message);
}

class AuctionManagementService {
  async getTasks(status: AuctionManagementTaskStatus): Promise<AuctionManagementTaskPayload[]> {
    try {
      const response = await api.get('/auction-management/tasks', { params: { status } });
      return response.data?.data || [];
    } catch (error: any) {
      throw toAuctionManagementError(error);
    }
  }

  async getTask(taskId: string): Promise<AuctionManagementTaskPayload> {
    try {
      const response = await api.get(`/auction-management/tasks/${taskId}`);
      return response.data?.data;
    } catch (error: any) {
      throw toAuctionManagementError(error);
    }
  }

  async markOpened(taskId: string): Promise<AuctionManagementTaskPayload> {
    try {
      const response = await api.post(`/auction-management/tasks/${taskId}/opened`, {});
      return response.data?.data;
    } catch (error: any) {
      throw toAuctionManagementError(error);
    }
  }
}

export default new AuctionManagementService();
