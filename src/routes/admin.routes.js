import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";

import {
  getAdminDashboard,

  getAdminProfile,
  updateAdminProfile,

  getAllUsers,
  createRoleUser,
  updateUserRole,
  toggleUserActiveStatus,
  deleteUserByAdmin,

  createCity,
  getCities,
  updateCity,
  deleteCity,

  createVendorByAdmin,
  getAdminVendors,
  updateVendorByAdmin,
  updateVendorCommission,
  toggleRestaurantStatus,
  deleteVendorByAdmin,

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
  updateRiderByAdmin,
  deleteRiderByAdmin,

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

  getCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getAdminNotifications,
sendAdminNotification,
} from "../controllers/admin.controller.js";

const router = express.Router();

router.use(protect, allowRoles("ADMIN"));

router.get("/dashboard", getAdminDashboard);

/* PROFILE */
router.get("/profile", getAdminProfile);
router.patch("/profile", upload.single("image"), updateAdminProfile);

/* USERS */
router.get("/users", getAllUsers);
router.post("/users/create-role-user", upload.single("image"), createRoleUser);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/status", toggleUserActiveStatus);
router.delete("/users/:id", deleteUserByAdmin);

/* CITIES */
router.get("/cities", getCities);
router.post("/cities", createCity);
router.patch("/cities/:id", updateCity);
router.delete("/cities/:id", deleteCity);

/* BUSINESS CATEGORIES */
router.get("/categories", getCategories);
router.post("/categories", upload.single("image"), createCategory);
router.patch("/categories/:id", upload.single("image"), updateCategory);
router.delete("/categories/:id", deleteCategory);

/* BUSINESS SUBCATEGORIES */
router.get("/subcategories", getSubCategories);
router.post("/subcategories", upload.single("image"), createSubCategory);
router.patch("/subcategories/:id", upload.single("image"), updateSubCategory);
router.delete("/subcategories/:id", deleteSubCategory);

/* VENDORS */
router.get("/vendors", getAdminVendors);
router.post("/vendors", upload.single("image"), createVendorByAdmin);
router.patch("/vendors/:id", upload.single("image"), updateVendorByAdmin);
router.patch("/vendors/:id/commission", updateVendorCommission);
router.patch("/vendors/:id/status", toggleRestaurantStatus);
router.delete("/vendors/:id", deleteVendorByAdmin);

/* BACKWARD-COMPATIBLE RESTAURANT STATUS ROUTE */
router.patch("/restaurants/:id/status", toggleRestaurantStatus);

/* VENDOR INTERNAL CATEGORIES */
router.get("/vendor-categories", getVendorCategories);
router.post("/vendor-categories", upload.single("image"), createVendorCategory);
router.patch("/vendor-categories/:id", upload.single("image"), updateVendorCategory);
router.delete("/vendor-categories/:id", deleteVendorCategory);

/* VENDOR INTERNAL SUBCATEGORIES */
router.get("/vendor-subcategories", getVendorSubCategories);
router.post("/vendor-subcategories", upload.single("image"), createVendorSubCategory);
router.patch("/vendor-subcategories/:id", upload.single("image"), updateVendorSubCategory);
router.delete("/vendor-subcategories/:id", deleteVendorSubCategory);

/* RIDERS */
router.get("/riders", getAdminRiders);
router.post("/riders", upload.single("image"), createRiderByAdmin);
router.patch("/riders/:id", upload.single("image"), updateRiderByAdmin);
router.patch("/riders/:id/status", updateRiderByAdmin);
router.delete("/riders/:id", deleteRiderByAdmin);

/* MENU ITEMS */
router.get("/menu-items", getAdminMenuItems);
router.post("/menu-items", upload.single("image"), createMenuItem);
router.patch("/menu-items/:id", upload.single("image"), updateMenuItem);
router.delete("/menu-items/:id", deleteMenuItem);

/* MENU ADDONS */
router.post("/menu-items/:menuItemId/addons", upload.single("image"), createMenuItemAddon);
router.patch("/menu-addons/:id", upload.single("image"), updateMenuItemAddon);
router.delete("/menu-addons/:id", deleteMenuItemAddon);

/* MENU CUSTOMIZATIONS */
router.post("/menu-items/:menuItemId/customizations", createMenuItemCustomization);
router.patch("/menu-customizations/:id", updateMenuItemCustomization);
router.delete("/menu-customizations/:id", deleteMenuItemCustomization);

/* ORDERS */
router.get("/orders", getAdminOrders);
router.get("/orders/:id", getAdminOrderById);
router.patch("/orders/:id/status", updateOrderStatusByAdmin);
router.patch("/orders/:id/assign-rider", assignRiderByAdmin);

/* BILLING */
router.get("/riders/:id/billing", getRiderBilling);
router.get("/billing/monthly", getMonthlyBilling);

/* COUPONS */
router.get("/coupons", getCoupons);
router.post("/coupons", createCoupon);
router.patch("/coupons/:id", updateCoupon);
router.delete("/coupons/:id", deleteCoupon);
/* NOTIFICATIONS */
router.get("/notifications", getAdminNotifications);
router.post("/notifications/send", sendAdminNotification);
export default router;