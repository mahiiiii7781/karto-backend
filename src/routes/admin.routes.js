import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";

import {
  getAdminDashboard,

  getAllUsers,
  createRoleUser,
  updateUserRole,
  toggleUserActiveStatus,

  createCity,
  getCities,

  createVendorByAdmin,
  getAdminVendors,
  updateVendorCommission,
  toggleRestaurantStatus,

  getVendorCategories,
  createVendorCategory,
  updateVendorCategory,
  deleteVendorCategory,

  getVendorSubCategories,
  createVendorSubCategory,
  updateVendorSubCategory,
  deleteVendorSubCategory,

  createRiderByAdmin,
  getAdminRiders,

  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,

  getSubCategories,
  createSubCategory,
  updateSubCategory,
  deleteSubCategory,

  getAdminMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,

  createMenuItemAddon,
  updateMenuItemAddon,
  deleteMenuItemAddon,

  createMenuItemCustomization,
  updateMenuItemCustomization,
  deleteMenuItemCustomization,

  getAdminOrders,
  getAdminOrderById,
  updateOrderStatusByAdmin,
  assignRiderByAdmin,

  getRiderBilling,
  getMonthlyBilling,
} from "../controllers/admin.controller.js";

const router = express.Router();

router.use(protect, allowRoles("ADMIN"));

router.get("/dashboard", getAdminDashboard);

router.get("/users", getAllUsers);
router.post("/users/create-role-user", upload.single("image"), createRoleUser);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/status", toggleUserActiveStatus);

router.post("/cities", createCity);
router.get("/cities", getCities);

/**
 * Business Categories:
 * Restaurant, Sweets, Grocery, Medical, Fruits, Vegetables
 */
router.get("/categories", getCategories);
router.post("/categories", upload.single("image"), createCategory);
router.patch("/categories/:id", upload.single("image"), updateCategory);
router.delete("/categories/:id", deleteCategory);

router.get("/subcategories", getSubCategories);
router.post("/subcategories", upload.single("image"), createSubCategory);
router.patch("/subcategories/:id", upload.single("image"), updateSubCategory);
router.delete("/subcategories/:id", deleteSubCategory);

/**
 * Vendors
 */
router.post("/vendors", upload.single("image"), createVendorByAdmin);
router.get("/vendors", getAdminVendors);
router.patch("/vendors/:id/commission", updateVendorCommission);
router.patch("/restaurants/:id/status", toggleRestaurantStatus);

/**
 * Vendor Internal Categories:
 * Vendor -> Category -> SubCategory -> Item
 */
router.get("/vendor-categories", getVendorCategories);
router.post("/vendor-categories", upload.single("image"), createVendorCategory);
router.patch("/vendor-categories/:id", upload.single("image"), updateVendorCategory);
router.delete("/vendor-categories/:id", deleteVendorCategory);

router.get("/vendor-subcategories", getVendorSubCategories);
router.post("/vendor-subcategories", upload.single("image"), createVendorSubCategory);
router.patch("/vendor-subcategories/:id", upload.single("image"), updateVendorSubCategory);
router.delete("/vendor-subcategories/:id", deleteVendorSubCategory);

/**
 * Riders
 */
router.post("/riders", upload.single("image"), createRiderByAdmin);
router.get("/riders", getAdminRiders);

/**
 * Menu Items
 */
router.get("/menu-items", getAdminMenuItems);
router.post("/menu-items", upload.single("image"), createMenuItem);
router.patch("/menu-items/:id", upload.single("image"), updateMenuItem);
router.delete("/menu-items/:id", deleteMenuItem);

/**
 * Menu Addons
 */
router.post(
  "/menu-items/:menuItemId/addons",
  upload.single("image"),
  createMenuItemAddon
);

router.patch(
  "/menu-addons/:id",
  upload.single("image"),
  updateMenuItemAddon
);

router.delete("/menu-addons/:id", deleteMenuItemAddon);

/**
 * Menu Customizations
 */
router.post(
  "/menu-items/:menuItemId/customizations",
  createMenuItemCustomization
);

router.patch(
  "/menu-customizations/:id",
  updateMenuItemCustomization
);

router.delete(
  "/menu-customizations/:id",
  deleteMenuItemCustomization
);

/**
 * Orders
 */
router.get("/orders", getAdminOrders);
router.get("/orders/:id", getAdminOrderById);
router.patch("/orders/:id/status", updateOrderStatusByAdmin);
router.patch("/orders/:id/assign-rider", assignRiderByAdmin);

/**
 * Billing
 */
router.get("/riders/:id/billing", getRiderBilling);
router.get("/billing/monthly", getMonthlyBilling);

export default router;