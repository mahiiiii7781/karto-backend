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

router.post("/vendors", upload.single("image"), createVendorByAdmin);
router.get("/vendors", getAdminVendors);
router.patch("/vendors/:id/commission", updateVendorCommission);
router.patch("/restaurants/:id/status", toggleRestaurantStatus);

router.post("/riders", upload.single("image"), createRiderByAdmin);
router.get("/riders", getAdminRiders);

router.get("/categories", getCategories);
router.post("/categories", upload.single("image"), createCategory);
router.patch("/categories/:id", upload.single("image"), updateCategory);
router.delete("/categories/:id", deleteCategory);

router.get("/subcategories", getSubCategories);
router.post("/subcategories", upload.single("image"), createSubCategory);
router.patch("/subcategories/:id", upload.single("image"), updateSubCategory);
router.delete("/subcategories/:id", deleteSubCategory);

router.get("/menu-items", getAdminMenuItems);
router.post("/menu-items", upload.single("image"), createMenuItem);
router.patch("/menu-items/:id", upload.single("image"), updateMenuItem);
router.delete("/menu-items/:id", deleteMenuItem);

/* =========================
   MENU ADDONS
========================= */

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

/* =========================
   MENU CUSTOMIZATIONS
========================= */

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

router.get("/orders", getAdminOrders);
router.get("/orders/:id", getAdminOrderById);
router.patch("/orders/:id/status", updateOrderStatusByAdmin);
router.patch("/orders/:id/assign-rider", assignRiderByAdmin);

router.get("/riders/:id/billing", getRiderBilling);
router.get("/billing/monthly", getMonthlyBilling);

export default router;