import { Router } from "express";
import { apiKeyProtect } from "../middleware/apiKey.middleware.js";
import {
  getAsset,
  getAssetImages,
  getCrmLead,
  getAssetLot,
  getAssetLotImages,
  getLotListing,
  getLotListingImages,
  getLotListingLot,
  getLotListingLotImages,
  listAssetLots,
  listAssets,
  listCrmLeads,
  listLotListingLots,
  listLotListings,
  listLots,
  listUsers,
  replyToCrmLead,
} from "../controller/publicApi.controller.js";

const router = Router();

router.use(apiKeyProtect);

router.get("/users", listUsers);
router.get("/assets", listAssets);
router.get("/assets/:id", getAsset);
router.get("/assets/:id/images", getAssetImages);
router.get("/assets/:id/lots", listAssetLots);
router.get("/assets/:id/lots/:lotId", getAssetLot);
router.get("/assets/:id/lots/:lotId/images", getAssetLotImages);

router.get("/lot-listings", listLotListings);
router.get("/lot-listings/:id", getLotListing);
router.get("/lot-listings/:id/images", getLotListingImages);
router.get("/lot-listings/:id/lots", listLotListingLots);
router.get("/lot-listings/:id/lots/:lotId", getLotListingLot);
router.get("/lot-listings/:id/lots/:lotId/images", getLotListingLotImages);

router.get("/lots", listLots);
router.get("/crm/leads", listCrmLeads);
router.get("/crm/leads/:id", getCrmLead);
router.post("/crm/leads/:id/reply", replyToCrmLead);

export default router;
