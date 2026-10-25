import type { Express, Router } from "express";
import adminRoutes from "./admin.routes.js";
import appVersionRoutes from "./appVersion.routes.js";
import assetRoutes from "./asset.routes.js";
import auctioneer2Routes from "./auctioneer2.routes.js";
import auctionManagementRoutes from "./auctionManagement.routes.js";
import authRoutes from "./auth.routes.js";
import browserLocationRoutes from "./browserLocation.routes.js";
import crmRoutes from "./crm.routes.js";
import galleryRoutes from "./gallery.routes.js";
import lotListingRoutes from "./lotListing.routes.js";
import notificationRoutes from "./notification.routes.js";
import pdfReportRoutes from "./pdfReport.routes.js";
import publicApiRoutes from "./publicApi.routes.js";
import realEstateRoutes from "./realEstate.routes.js";
import reportDraftRoutes from "./reportDraft.routes.js";
import salvageRoutes from "./salvage.routes.js";
import savedInputRoutes from "./savedInput.routes.js";
import supportRoutes from "./support.routes.js";
import userRoutes from "./user.routes.js";
import captureInventoryRoutes from "./captureInventory.routes.js";
import reportActivityRoutes from "./reportActivity.routes.js";
import youtubeRoutes from "./youtube.routes.js";
import captureBackupRoutes from "./captureBackup.routes.js";
import reportTransferRoutes from "./reportTransfer.routes.js";

type RouteRegistration = Readonly<{
  mountPath: string;
  router: Router;
}>;

// Order is part of the HTTP contract: keep specific mounts ahead of any future
// catch-all middleware, and append new API domains immediately before export.
const routeRegistrations: readonly RouteRegistration[] = [
  { mountPath: "/api/auth", router: authRoutes },
  { mountPath: "/api/user", router: userRoutes },
  { mountPath: "/api/location", router: browserLocationRoutes },
  { mountPath: "/api/real-estate", router: realEstateRoutes },
  { mountPath: "/api/salvage", router: salvageRoutes },
  { mountPath: "/api/asset", router: assetRoutes },
  { mountPath: "/api/reports", router: pdfReportRoutes },
  { mountPath: "/api/admin/youtube", router: youtubeRoutes },
  { mountPath: "/api/admin", router: adminRoutes },
  { mountPath: "/api/saved-inputs", router: savedInputRoutes },
  { mountPath: "/api/gallery", router: galleryRoutes },
  { mountPath: "/api/lot-listing", router: lotListingRoutes },
  { mountPath: "/api/crm", router: crmRoutes },
  { mountPath: "/api/notifications", router: notificationRoutes },
  { mountPath: "/api/auctioneer", router: auctioneer2Routes },
  { mountPath: "/api/auction-management", router: auctionManagementRoutes },
  { mountPath: "/api/v1", router: publicApiRoutes },
  { mountPath: "/api/report-drafts", router: reportDraftRoutes },
  { mountPath: "/api/app-version", router: appVersionRoutes },
  { mountPath: "/api/support", router: supportRoutes },
  { mountPath: "/api/capture-inventory", router: captureInventoryRoutes },
  { mountPath: "/api/report-activity", router: reportActivityRoutes },
  { mountPath: "/api/capture-backups", router: captureBackupRoutes },
  { mountPath: "/api/report-transfers", router: reportTransferRoutes },
];

export function registerRoutes(app: Express): void {
  for (const { mountPath, router } of routeRegistrations) {
    app.use(mountPath, router);
  }
}
