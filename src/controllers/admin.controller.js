import bcrypt from "bcryptjs";
import PDFDocument from "pdfkit";
import prisma from "../prisma.js";
import { emitOrderStatus } from "../config/socket.js";
import { uploadToCloudinary } from "../utils/cloudinaryUpload.js";
import {
  sendPushToUser,
  notificationTemplates,
} from "../services/notification.service.js";
const allowedRoles = ["CUSTOMER", "VENDOR", "RIDER", "ADMIN"];

const moneyNumber = (value) => Number(value || 0);

const cleanString = (value) =>
  value === undefined || value === null ? undefined : String(value).trim();

const cleanEmail = (value) => cleanString(value)?.toLowerCase();

const fileUrl = async (req, folder = "misc") => {
  if (!req.file) return undefined;
  return await uploadToCloudinary(req.file, folder);
};

const boolValue = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  const normalized = String(value).trim().toLowerCase();
  return ["true", "1", "yes", "y", "active", "on"].includes(normalized);
};

const parseJsonArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const roundMoney = (value) => Math.round((moneyNumber(value) + Number.EPSILON) * 100) / 100;

const safeDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getDateRange = ({ from, to, type = "monthly" } = {}) => {
  const now = new Date();
  let start = safeDate(from);
  let end = safeDate(to);

  if (!start) {
    start = new Date(now);
    if (type === "daily") start.setHours(0, 0, 0, 0);
    else if (type === "weekly") {
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
  } else {
    start.setHours(0, 0, 0, 0);
  }

  if (!end) end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  return { start, end };
};

const isPrepaidMethod = (method) =>
  ["ONLINE", "UPI", "CARD", "WALLET"].includes(String(method || "").toUpperCase());

const isRecognizedOrder = (order) =>
  order?.status === "DELIVERED" && order?.paymentStatus === "PAID";

const getCommissionableAmount = (order) => {
  if (order?.commissionableAmount !== null && order?.commissionableAmount !== undefined) {
    return roundMoney(order.commissionableAmount);
  }

  const itemTotal = moneyNumber(order?.itemTotal);
  const discount = moneyNumber(order?.discount);
  if (itemTotal > 0) return roundMoney(Math.max(itemTotal - discount, 0));

  // Legacy fallback for old orders created before itemTotal/snapshot fields were populated.
  const total = moneyNumber(order?.totalAmount);
  const deliveryFee = moneyNumber(order?.deliveryFee);
  const platformFee = moneyNumber(order?.platformFee);
  const taxAmount = moneyNumber(order?.taxAmount);
  return roundMoney(Math.max(total - deliveryFee - platformFee - taxAmount, 0));
};

const getOrderFinancials = (order) => {
  const totalAmount = roundMoney(order?.totalAmount);
  const commissionableAmount = getCommissionableAmount(order);
  const commissionRate = roundMoney(
    order?.commissionRate ?? order?.restaurant?.commission ?? 0
  );

  const platformCommission = roundMoney(
    order?.platformCommissionAmount !== null &&
      order?.platformCommissionAmount !== undefined
      ? order.platformCommissionAmount
      : (commissionableAmount * commissionRate) / 100
  );

  const vendorPayable = roundMoney(
    order?.vendorSettlementAmount !== null &&
      order?.vendorSettlementAmount !== undefined
      ? order.vendorSettlementAmount
      : Math.max(commissionableAmount - platformCommission, 0)
  );

  const hasSnapshot =
    order?.commissionableAmount !== null &&
    order?.commissionableAmount !== undefined &&
    order?.commissionRate !== null &&
    order?.commissionRate !== undefined &&
    order?.platformCommissionAmount !== null &&
    order?.platformCommissionAmount !== undefined &&
    order?.vendorSettlementAmount !== null &&
    order?.vendorSettlementAmount !== undefined;

  return {
    totalAmount,
    commissionableAmount,
    commissionRate,
    platformCommission,
    vendorPayable,
    hasSnapshot,
    legacyCommissionFallback: !hasSnapshot,
  };
};

const calcIncome = (orders = []) => {
  let totalRevenue = 0;
  let kartoIncome = 0;
  let vendorIncome = 0;

  for (const order of orders) {
    if (!isRecognizedOrder(order)) continue;
    const finance = getOrderFinancials(order);
    totalRevenue += finance.totalAmount;
    kartoIncome += finance.platformCommission;
    vendorIncome += finance.vendorPayable;
  }

  return {
    totalRevenue: roundMoney(totalRevenue),
    kartoIncome: roundMoney(kartoIncome),
    vendorIncome: roundMoney(vendorIncome),
  };
};

const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

const sendCsv = (res, filename, rows) => {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(`\uFEFF${csv}`);
};

const formatPdfMoney = (value) => `INR ${roundMoney(value).toFixed(2)}`;

const setupPdfResponse = (res, filename, title) => {
  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);
  doc.fontSize(20).text("KARTO", { align: "center" });
  doc.fontSize(13).text(title, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor("#666666").text(`Generated: ${new Date().toLocaleString("en-IN")}`, { align: "center" });
  doc.fillColor("#000000").moveDown();
  return doc;
};

const pdfKeyValue = (doc, key, value) => {
  doc.fontSize(9).font("Helvetica-Bold").text(`${key}: `, { continued: true });
  doc.font("Helvetica").text(String(value ?? "-"));
};

const auditAdminAction = async (req, { action, entityType, entityId = null, oldData = null, newData = null, metadata = null }) => {
  try {
    if (!prisma.adminAuditLog) return;
    await prisma.adminAuditLog.create({
      data: {
        adminId: req.user?.id || null,
        action,
        entityType,
        entityId,
        oldData: oldData ?? undefined,
        newData: newData ?? undefined,
        metadata: metadata ?? undefined,
        ipAddress: req.ip || req.headers?.["x-forwarded-for"]?.toString()?.split(",")?.[0]?.trim() || null,
        userAgent: req.headers?.["user-agent"] || null,
      },
    });
  } catch (error) {
    console.error("Admin Audit Log Error:", error?.message || error);
  }
};

const createOrderSnapshotIfMissing = async (tx, order) => {
  const finance = getOrderFinancials(order);
  if (finance.hasSnapshot) return { order, finance };

  const updated = await tx.order.update({
    where: { id: order.id },
    data: {
      commissionableAmount: finance.commissionableAmount,
      commissionRate: finance.commissionRate,
      platformCommissionAmount: finance.platformCommission,
      vendorSettlementAmount: finance.vendorPayable,
    },
    include: { restaurant: true, rider: true, vendor: true, refunds: true },
  });

  return { order: updated, finance: getOrderFinancials(updated) };
};

const ensureSettlementsForRecognizedOrder = async (tx, order) => {
  if (!isRecognizedOrder(order)) return;

  const { order: snapOrder, finance } = await createOrderSnapshotIfMissing(tx, order);
  const vendorId = snapOrder.vendorId || snapOrder.restaurant?.vendorId || null;

  if (vendorId && prisma.vendorSettlement) {
    await tx.vendorSettlement.upsert({
      where: { orderId: snapOrder.id },
      update: {
        vendorId,
        restaurantId: snapOrder.restaurantId,
        grossAmount: finance.commissionableAmount,
        commissionRate: finance.commissionRate,
        commissionAmount: finance.platformCommission,
        netAmount: finance.vendorPayable,
      },
      create: {
        vendorId,
        restaurantId: snapOrder.restaurantId,
        orderId: snapOrder.id,
        grossAmount: finance.commissionableAmount,
        commissionRate: finance.commissionRate,
        commissionAmount: finance.platformCommission,
        netAmount: finance.vendorPayable,
        status: "PENDING",
      },
    });
  }

  if (snapOrder.riderId && prisma.riderSettlement) {
    const deliveryAmount = roundMoney(snapOrder.deliveryFee);
    await tx.riderSettlement.upsert({
      where: { orderId: snapOrder.id },
      update: { riderId: snapOrder.riderId, amount: deliveryAmount },
      create: {
        riderId: snapOrder.riderId,
        orderId: snapOrder.id,
        amount: deliveryAmount,
        status: "PENDING",
      },
    });

    if (prisma.riderEarning) {
      const existing = await tx.riderEarning.findFirst({ where: { orderId: snapOrder.id, riderId: snapOrder.riderId } });
      if (!existing) {
        await tx.riderEarning.create({
          data: {
            riderId: snapOrder.riderId,
            orderId: snapOrder.id,
            amount: deliveryAmount,
            note: "Delivery earning",
          },
        });
      }
    }
  }
};

/* =========================
   DASHBOARD
========================= */

export const getAdminDashboard = async (req, res) => {
  try {
    const activeStatuses = [
      "PLACED",
      "ACCEPTED_BY_VENDOR",
      "PREPARING",
      "READY_FOR_PICKUP",
      "ASSIGNED_TO_RIDER",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
    ];

    const [
      totalUsers,
      totalVendors,
      totalRiders,
      totalOrders,
      activeOrders,
      deliveredOrders,
      orders,
      recentOrders,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: "VENDOR" } }),
      prisma.user.count({ where: { role: "RIDER" } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: { in: activeStatuses } } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
      prisma.order.findMany({ include: { restaurant: true } }),
      prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
            },
          },
          restaurant: {
            include: {
              city: true,
            },
          },
          rider: {
            select: {
              id: true,
              fullName: true,
              phone: true,
            },
          },
          items: true,
        },
      }),
    ]);

    const income = calcIncome(orders);

    return res.json({
      success: true,
      data: {
        totalUsers,
        totalVendors,
        totalRiders,
        totalOrders,
        activeOrders,
        deliveredOrders,
        ...income,
        recentOrders,
      },
    });
  } catch (error) {
    console.error("Admin Dashboard Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   USERS
========================= */

export const getAllUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.json({ success: true, users, data: users });
  } catch (error) {
    console.error("Get Users Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createRoleUser = async (req, res) => {
  try {
    const { fullName, email, phone, password, role = "CUSTOMER", avatarUrl } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "fullName, email and password are required",
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.trim().toLowerCase() },
          phone ? { phone: phone.trim() } : undefined,
        ].filter(Boolean),
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Email or phone already exists",
      });
    }

    const imageUrl = await fileUrl(req, "users");
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone?.trim() || null,
        password: hashedPassword,
        avatarUrl: imageUrl || avatarUrl || null,
        role,
        isActive: true,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: `${role} created successfully`,
      user,
      data: user,
    });
  } catch (error) {
    console.error("Create Role User Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
      },
    });

    return res.json({
      success: true,
      message: "User role updated",
      user,
      data: user,
    });
  } catch (error) {
    console.error("Update Role Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const toggleUserActiveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const user = await prisma.user.update({
      where: { id },
      data: { isActive: boolValue(isActive) },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
      },
    });

    return res.json({
      success: true,
      message: user.isActive ? "User activated" : "User blocked",
      user,
      data: user,
    });
  } catch (error) {
    console.error("Toggle User Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


export const deleteUserByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user?.id === id) {
      return res.status(400).json({
        success: false,
        message: "Admin cannot delete own account",
      });
    }

    const user = await prisma.user.findUnique({ where: { id } });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Safe delete: if this user has orders/relations, keep history and deactivate instead.
    try {
      await prisma.user.delete({ where: { id } });
      return res.json({ success: true, message: "User deleted successfully" });
    } catch (deleteError) {
      if (deleteError?.code !== "P2003") throw deleteError;

      const updated = await prisma.user.update({
        where: { id },
        data: { isActive: false },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
        },
      });

      return res.json({
        success: true,
        message: "User has linked records, so it was deactivated safely",
        user: updated,
        data: updated,
      });
    }
  } catch (error) {
    console.error("Delete User Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


/* =========================
   ADMIN PROFILE
========================= */

export const getAdminProfile = async (req, res) => {
  try {
    const admin = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    return res.json({ success: true, user: admin, admin, data: admin });
  } catch (error) {
    console.error("Get Admin Profile Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateAdminProfile = async (req, res) => {
  try {
    const { fullName, phone, password, avatarUrl, imageUrl } = req.body;
    const finalAvatarUrl = await fileUrl(req, "admin-profile");

    const updateData = {
      ...(fullName !== undefined && { fullName: cleanString(fullName) }),
      ...(phone !== undefined && { phone: cleanString(phone) || null }),
      ...(password ? { password: await bcrypt.hash(password, 10) } : {}),
      ...(finalAvatarUrl && { avatarUrl: finalAvatarUrl }),
      ...(!finalAvatarUrl && avatarUrl !== undefined && { avatarUrl: avatarUrl || null }),
      ...(!finalAvatarUrl && imageUrl !== undefined && { avatarUrl: imageUrl || null }),
    };

    if (!Object.keys(updateData).length) {
      return res.status(400).json({ success: false, message: "No valid profile fields provided" });
    }

    const admin = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.json({
      success: true,
      message: "Admin profile updated successfully",
      user: admin,
      admin,
      data: admin,
    });
  } catch (error) {
    console.error("Update Admin Profile Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   CITIES
========================= */

export const createCity = async (req, res) => {
  try {
    const { name, code } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        success: false,
        message: "City name and code are required",
      });
    }

    const city = await prisma.city.upsert({
      where: { code: code.trim().toUpperCase() },
      update: {
        name: name.trim(),
        isActive: true,
      },
      create: {
        name: name.trim(),
        code: code.trim().toUpperCase(),
      },
    });

    return res.status(201).json({
      success: true,
      message: "City saved successfully",
      city,
      data: city,
    });
  } catch (error) {
    console.error("Create City Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getCities = async (req, res) => {
  try {
    const { includeInactive } = req.query;
    const shouldIncludeInactive = boolValue(includeInactive, false);

    const cities = await prisma.city.findMany({
      where: shouldIncludeInactive ? {} : { isActive: true },
      orderBy: { name: "asc" },
    });

    return res.json({ success: true, cities, data: cities });
  } catch (error) {
    console.error("Get Cities Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   VENDORS
========================= */

export const createVendorByAdmin = async (req, res) => {
  try {
    const {
      cityId,
      categoryId,
      subCategoryId,
      name,
      ownerName,
      ownerMobileNo,
      phone,
      email,
      password,
      address,
      latitude,
      longitude,
      type = "RESTAURANT",
      commission = 0,
      role = "VENDOR",
      imageUrl,
      isOpen = true,
      isActive = true,
    } = req.body;

    const normalizedEmail = cleanEmail(email);
    const normalizedOwnerPhone = cleanString(ownerMobileNo);
    const normalizedPhone = cleanString(phone);
    const normalizedName = cleanString(name);
    const normalizedOwnerName = cleanString(ownerName);
    const normalizedAddress = cleanString(address);
    const normalizedType = cleanString(type) || "RESTAURANT";
    const commissionNumber = Number(commission ?? 0);

    if (
      !cityId ||
      !categoryId ||
      !subCategoryId ||
      !normalizedName ||
      !normalizedOwnerName ||
      !normalizedOwnerPhone ||
      !normalizedPhone ||
      !normalizedEmail ||
      !password ||
      !normalizedAddress
    ) {
      return res.status(400).json({
        success: false,
        message:
          "cityId, categoryId, subCategoryId, name, ownerName, ownerMobileNo, phone, email, password and address are required",
      });
    }

    if (role !== "VENDOR") {
      return res.status(400).json({
        success: false,
        message: "Vendor create role must be VENDOR",
      });
    }

    if (!/^[6-9]\d{9}$/.test(normalizedOwnerPhone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid owner mobile number",
      });
    }

    if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor phone number",
      });
    }

    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor email address",
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    if (
      !Number.isFinite(commissionNumber) ||
      commissionNumber < 0 ||
      commissionNumber > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Commission must be between 0 and 100",
      });
    }

    const hasLatitude =
      latitude !== undefined &&
      latitude !== null &&
      String(latitude).trim() !== "";

    const hasLongitude =
      longitude !== undefined &&
      longitude !== null &&
      String(longitude).trim() !== "";

    if (hasLatitude !== hasLongitude) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude must be provided together",
      });
    }

    const latitudeNumber = hasLatitude ? Number(latitude) : null;
    const longitudeNumber = hasLongitude ? Number(longitude) : null;

    if (
      hasLatitude &&
      (!Number.isFinite(latitudeNumber) ||
        latitudeNumber < -90 ||
        latitudeNumber > 90)
    ) {
      return res.status(400).json({
        success: false,
        message: "Latitude must be between -90 and 90",
      });
    }

    if (
      hasLongitude &&
      (!Number.isFinite(longitudeNumber) ||
        longitudeNumber < -180 ||
        longitudeNumber > 180)
    ) {
      return res.status(400).json({
        success: false,
        message: "Longitude must be between -180 and 180",
      });
    }

    const city = await prisma.city.findUnique({
      where: { id: cityId },
    });

    if (!city) {
      return res.status(404).json({
        success: false,
        message: "City not found",
      });
    }

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Parent category not found",
      });
    }

    const subCategory =
      await prisma.productSubCategory.findFirst({
        where: {
          id: subCategoryId,
          categoryId,
        },
      });

    if (!subCategory) {
      return res.status(404).json({
        success: false,
        message:
          "Parent subcategory not found or does not belong to selected parent category",
      });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { phone: normalizedOwnerPhone },
        ],
      },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
      },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message:
          existingUser.email === normalizedEmail
            ? "A user with this email already exists"
            : "A user with this owner mobile number already exists",
      });
    }

    const existingRestaurant = await prisma.restaurant.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { phone: normalizedPhone },
        ],
      },
      select: {
        id: true,
        email: true,
        phone: true,
      },
    });

    if (existingRestaurant) {
      return res.status(409).json({
        success: false,
        message:
          existingRestaurant.email === normalizedEmail
            ? "A vendor with this email already exists"
            : "A vendor with this phone number already exists",
      });
    }

    let finalImageUrl = cleanString(imageUrl) || null;

    if (req.file) {
      try {
        const uploadedImageUrl =
          await fileUrl(req, "vendors");

        if (uploadedImageUrl) {
          finalImageUrl = uploadedImageUrl;
        }
      } catch (uploadError) {
        console.error(
          "Vendor image upload failed:",
          uploadError
        );

        if (!finalImageUrl) {
          return res.status(500).json({
            success: false,
            message: "Vendor image upload failed",
          });
        }
      }
    }

    const hashedPassword =
      await bcrypt.hash(String(password), 10);

    const result = await prisma.$transaction(
      async (tx) => {
        const vendorUser = await tx.user.create({
          data: {
            fullName: normalizedOwnerName,
            email: normalizedEmail,
            phone: normalizedOwnerPhone,
            password: hashedPassword,
            role: "VENDOR",
            avatarUrl: finalImageUrl,
            isActive: boolValue(isActive, true),
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
            isActive: true,
            createdAt: true,
          },
        });

        const vendor = await tx.restaurant.create({
          data: {
            vendorId: vendorUser.id,
            cityId,
            categoryId,
            subCategoryId,
            name: normalizedName,
            ownerName: normalizedOwnerName,
            ownerMobileNo: normalizedOwnerPhone,
            phone: normalizedPhone,
            email: normalizedEmail,
            address: normalizedAddress,
            imageUrl: finalImageUrl,
            type: normalizedType,
            commission: commissionNumber,
            isOpen: boolValue(isOpen, true),
            ...(hasLatitude
              ? {
                  latitude: latitudeNumber,
                  longitude: longitudeNumber,
                }
              : {}),
          },
          include: {
            city: true,
            category: true,
            subCategory: true,
            vendor: {
              select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
                avatarUrl: true,
                role: true,
                isActive: true,
              },
            },
            orders: true,
            menuItems: true,
          },
        });

        return {
          user: vendorUser,
          vendor,
        };
      }
    );

    await auditAdminAction(req, {
      action: "CREATE_VENDOR",
      entityType: "Restaurant",
      entityId: result.vendor.id,
      newData: {
        vendorId: result.vendor.id,
        vendorUserId: result.user.id,
        cityId,
        categoryId,
        subCategoryId,
        name: normalizedName,
        email: normalizedEmail,
        phone: normalizedPhone,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      vendor: result.vendor,
      user: result.user,
      data: result.vendor,
    });
  } catch (error) {
    console.error("Create Vendor Error:", error);

    if (error?.code === "P2002") {
      const fields = Array.isArray(error?.meta?.target)
        ? error.meta.target.join(", ")
        : "unique field";

      return res.status(409).json({
        success: false,
        message: `Vendor already exists for ${fields}`,
      });
    }

    if (error?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor relation data",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Vendor could not be created",
    });
  }
};

export const getAdminVendors = async (req, res) => {
  try {
    const {
      cityId,
      categoryId,
      subCategoryId,
    } = req.query;

    const vendors = await prisma.restaurant.findMany({
      where: {
        ...(cityId && cityId !== "ALL"
          ? { cityId }
          : {}),
        ...(categoryId && categoryId !== "ALL"
          ? { categoryId }
          : {}),
        ...(subCategoryId && subCategoryId !== "ALL"
          ? { subCategoryId }
          : {}),
      },
      include: {
        city: true,
        category: true,
        subCategory: true,
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            isActive: true,
          },
        },
        orders: true,
        menuItems: {
          include: {
            category: true,
            subCategory: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = vendors.map((vendor) => {
      const income = calcIncome(
        (vendor.orders || []).map((order) => ({
          ...order,
          restaurant: vendor,
        }))
      );

      return {
        ...vendor,
        totalRevenue: income.totalRevenue,
        kartoIncome: income.kartoIncome,
        vendorIncome: income.vendorIncome,
        totalOrders: vendor.orders.length,
      };
    });

    return res.json({
      success: true,
      vendors: data,
      data,
    });
  } catch (error) {
    console.error(
      "Get Admin Vendors Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const updateVendorCommission = async (req, res) => {
  try {
    const { id } = req.params;
    const { commission } = req.body;

    const vendor = await prisma.restaurant.update({
      where: { id },
      data: { commission: Number(commission || 0) },
      include: {
        city: true,
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      message: "Commission updated successfully",
      vendor,
      data: vendor,
    });
  } catch (error) {
    console.error("Update Commission Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const toggleRestaurantStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const restaurant = await prisma.restaurant.update({
      where: { id },
      data: { isOpen: boolValue(isActive) },
    });

    return res.json({
      success: true,
      message: restaurant.isOpen ? "Vendor activated" : "Vendor blocked",
      restaurant,
      data: restaurant,
    });
  } catch (error) {
    console.error("Restaurant Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateVendorByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      cityId,
      categoryId,
      subCategoryId,
      name,
      ownerName,
      ownerMobileNo,
      phone,
      email,
      address,
      latitude,
      longitude,
      type,
      commission,
      imageUrl,
      isOpen,
      isActive,
      password,
    } = req.body;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id },
      include: { vendor: true },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    if (cityId) {
      const city = await prisma.city.findUnique({
        where: { id: cityId },
      });

      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
        });
      }
    }

    if (categoryId) {
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
      });

      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Parent category not found",
        });
      }
    }

    if (subCategoryId) {
      const finalCategoryId =
        categoryId || restaurant.categoryId;

      if (!finalCategoryId) {
        return res.status(400).json({
          success: false,
          message:
            "Parent category is required when parent subcategory is selected",
        });
      }

      const subCategory =
        await prisma.productSubCategory.findFirst({
          where: {
            id: subCategoryId,
            categoryId: finalCategoryId,
          },
        });

      if (!subCategory) {
        return res.status(404).json({
          success: false,
          message:
            "Parent subcategory not found or does not belong to selected parent category",
        });
      }
    }

    const cleanOwnerPhone =
      ownerMobileNo !== undefined
        ? cleanString(ownerMobileNo)
        : undefined;

    const cleanVendorPhone =
      phone !== undefined
        ? cleanString(phone)
        : undefined;

    const normalizedEmail =
      email !== undefined
        ? cleanEmail(email)
        : undefined;

    if (
      cleanOwnerPhone !== undefined &&
      !/^[6-9]\d{9}$/.test(cleanOwnerPhone)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid owner mobile number",
      });
    }

    if (
      cleanVendorPhone !== undefined &&
      !/^[6-9]\d{9}$/.test(cleanVendorPhone)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor phone number",
      });
    }

    if (
      normalizedEmail !== undefined &&
      !/^\S+@\S+\.\S+$/.test(normalizedEmail)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor email address",
      });
    }

    if (password && String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    if (commission !== undefined) {
      const commissionNumber = Number(commission);

      if (
        !Number.isFinite(commissionNumber) ||
        commissionNumber < 0 ||
        commissionNumber > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Commission must be between 0 and 100",
        });
      }
    }

    const hasLatitude =
      latitude !== undefined &&
      latitude !== null &&
      String(latitude).trim() !== "";

    const hasLongitude =
      longitude !== undefined &&
      longitude !== null &&
      String(longitude).trim() !== "";

    if (hasLatitude !== hasLongitude) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude must be provided together",
      });
    }

    const latitudeNumber = hasLatitude ? Number(latitude) : undefined;
    const longitudeNumber = hasLongitude ? Number(longitude) : undefined;

    if (
      hasLatitude &&
      (!Number.isFinite(latitudeNumber) ||
        latitudeNumber < -90 ||
        latitudeNumber > 90)
    ) {
      return res.status(400).json({
        success: false,
        message: "Latitude must be between -90 and 90",
      });
    }

    if (
      hasLongitude &&
      (!Number.isFinite(longitudeNumber) ||
        longitudeNumber < -180 ||
        longitudeNumber > 180)
    ) {
      return res.status(400).json({
        success: false,
        message: "Longitude must be between -180 and 180",
      });
    }

    if (
      normalizedEmail !== undefined ||
      cleanOwnerPhone !== undefined
    ) {
      const duplicateUser = await prisma.user.findFirst({
        where: {
          id: restaurant.vendorId
            ? { not: restaurant.vendorId }
            : undefined,
          OR: [
            normalizedEmail
              ? { email: normalizedEmail }
              : undefined,
            cleanOwnerPhone
              ? { phone: cleanOwnerPhone }
              : undefined,
          ].filter(Boolean),
        },
        select: { id: true },
      });

      if (duplicateUser) {
        return res.status(409).json({
          success: false,
          message:
            "Another user already uses this email or owner mobile number",
        });
      }
    }

    if (
      normalizedEmail !== undefined ||
      cleanVendorPhone !== undefined
    ) {
      const duplicateRestaurant =
        await prisma.restaurant.findFirst({
          where: {
            id: { not: id },
            OR: [
              normalizedEmail
                ? { email: normalizedEmail }
                : undefined,
              cleanVendorPhone
                ? { phone: cleanVendorPhone }
                : undefined,
            ].filter(Boolean),
          },
          select: { id: true },
        });

      if (duplicateRestaurant) {
        return res.status(409).json({
          success: false,
          message:
            "Another vendor already uses this email or phone number",
        });
      }
    }

    let finalImageUrl = undefined;

    if (req.file) {
      finalImageUrl =
        await fileUrl(req, "vendors");
    } else if (imageUrl !== undefined) {
      finalImageUrl =
        cleanString(imageUrl) || null;
    }

    const userUpdateData = {
      ...(ownerName !== undefined && {
        fullName: cleanString(ownerName),
      }),
      ...(normalizedEmail !== undefined && {
        email: normalizedEmail,
      }),
      ...(cleanOwnerPhone !== undefined && {
        phone: cleanOwnerPhone,
      }),
      ...(finalImageUrl !== undefined && {
        avatarUrl: finalImageUrl,
      }),
      ...(password && {
        password: await bcrypt.hash(
          String(password),
          10
        ),
      }),
      ...(isActive !== undefined && {
        isActive: boolValue(isActive),
      }),
    };

    const restaurantUpdateData = {
      ...(cityId !== undefined && { cityId }),
      ...(categoryId !== undefined && {
        categoryId: categoryId || null,
      }),
      ...(subCategoryId !== undefined && {
        subCategoryId: subCategoryId || null,
      }),
      ...(name !== undefined && {
        name: cleanString(name),
      }),
      ...(ownerName !== undefined && {
        ownerName: cleanString(ownerName),
      }),
      ...(cleanOwnerPhone !== undefined && {
        ownerMobileNo: cleanOwnerPhone,
      }),
      ...(cleanVendorPhone !== undefined && {
        phone: cleanVendorPhone,
      }),
      ...(normalizedEmail !== undefined && {
        email: normalizedEmail,
      }),
      ...(address !== undefined && {
        address: cleanString(address),
      }),
      ...(type !== undefined && {
        type: cleanString(type),
      }),
      ...(commission !== undefined && {
        commission: Number(commission),
      }),
      ...(isOpen !== undefined && {
        isOpen: boolValue(isOpen),
      }),
      ...(finalImageUrl !== undefined && {
        imageUrl: finalImageUrl,
      }),
      ...(hasLatitude && {
        latitude: latitudeNumber,
        longitude: longitudeNumber,
      }),
    };

    const data = await prisma.$transaction(
      async (tx) => {
        if (
          Object.keys(userUpdateData).length &&
          restaurant.vendorId
        ) {
          await tx.user.update({
            where: {
              id: restaurant.vendorId,
            },
            data: userUpdateData,
          });
        }

        return tx.restaurant.update({
          where: { id },
          data: restaurantUpdateData,
          include: {
            city: true,
            category: true,
            subCategory: true,
            vendor: {
              select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
                avatarUrl: true,
                role: true,
                isActive: true,
              },
            },
            orders: true,
            menuItems: true,
          },
        });
      }
    );

    await auditAdminAction(req, {
      action: "UPDATE_VENDOR",
      entityType: "Restaurant",
      entityId: id,
      oldData: {
        name: restaurant.name,
        email: restaurant.email,
        phone: restaurant.phone,
        cityId: restaurant.cityId,
        categoryId: restaurant.categoryId,
        subCategoryId: restaurant.subCategoryId,
        isOpen: restaurant.isOpen,
      },
      newData: restaurantUpdateData,
    });

    return res.json({
      success: true,
      message: "Vendor updated successfully",
      vendor: data,
      data,
    });
  } catch (error) {
    console.error("Update Vendor Error:", error);

    if (error?.code === "P2002") {
      return res.status(409).json({
        success: false,
        message:
          "Email or phone is already used by another account",
      });
    }

    if (error?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor relation data",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Vendor could not be updated",
    });
  }
};

export const deleteVendorByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const restaurant = await prisma.restaurant.findUnique({ where: { id } });
    if (!restaurant) return res.status(404).json({ success: false, message: "Vendor not found" });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.restaurant.delete({ where: { id } });
        if (restaurant.vendorId) await tx.user.delete({ where: { id: restaurant.vendorId } });
      });

      return res.json({ success: true, message: "Vendor deleted successfully" });
    } catch (deleteError) {
      if (deleteError?.code !== "P2003") throw deleteError;

      const data = await prisma.$transaction(async (tx) => {
        const updatedRestaurant = await tx.restaurant.update({
          where: { id },
          data: { isOpen: false },
        });

        if (restaurant.vendorId) {
          await tx.user.update({
            where: { id: restaurant.vendorId },
            data: { isActive: false },
          });
        }

        return updatedRestaurant;
      });

      return res.json({
        success: true,
        message: "Vendor has linked records, so it was deactivated safely",
        vendor: data,
        data,
      });
    }
  } catch (error) {
    console.error("Delete Vendor Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getVendorCategories = async (req, res) => {
  try {
    const {
      restaurantId,
      categoryId,
      subCategoryId,
    } = req.query;

    const data = await prisma.vendorCategory.findMany({
      where: {
        ...(restaurantId && restaurantId !== "ALL"
          ? { restaurantId }
          : {}),
        ...(categoryId && categoryId !== "ALL"
          ? { categoryId }
          : {}),
        ...(subCategoryId && subCategoryId !== "ALL"
          ? { subCategoryId }
          : {}),
      },
      include: {
        restaurant: {
          include: {
            city: true,
            category: true,
            subCategory: true,
          },
        },
        category: true,
        subCategory: true,
        subCategories: true,
        menuItems: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json({
      success: true,
      categories: data,
      data,
    });
  } catch (error) {
    console.error(
      "Get Vendor Categories Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const createVendorCategory = async (req, res) => {
  try {
    const {
      restaurantId,
      categoryId,
      subCategoryId,
      name,
      description,
      imageUrl,
      isActive,
    } = req.body;

    const normalizedName =
      cleanString(name);

    if (
      !restaurantId ||
      !categoryId ||
      !subCategoryId ||
      !normalizedName
    ) {
      return res.status(400).json({
        success: false,
        message:
          "restaurantId, categoryId, subCategoryId and name are required",
      });
    }

    const restaurant =
      await prisma.restaurant.findUnique({
        where: {
          id: restaurantId,
        },
        include: {
          category: true,
          subCategory: true,
        },
      });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const parentCategory =
      await prisma.category.findUnique({
        where: {
          id: categoryId,
        },
      });

    if (!parentCategory) {
      return res.status(404).json({
        success: false,
        message:
          "Parent category not found",
      });
    }

    const parentSubCategory =
      await prisma.productSubCategory.findFirst({
        where: {
          id: subCategoryId,
          categoryId,
        },
      });

    if (!parentSubCategory) {
      return res.status(404).json({
        success: false,
        message:
          "Parent subcategory not found or does not belong to selected parent category",
      });
    }

    if (
      restaurant.categoryId &&
      restaurant.categoryId !== categoryId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Selected vendor does not belong to selected parent category",
      });
    }

    if (
      restaurant.subCategoryId &&
      restaurant.subCategoryId !== subCategoryId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Selected vendor does not belong to selected parent subcategory",
      });
    }

    const duplicate =
      await prisma.vendorCategory.findFirst({
        where: {
          restaurantId,
          categoryId,
          subCategoryId,
          name: {
            equals: normalizedName,
            mode: "insensitive",
          },
        },
        select: {
          id: true,
        },
      });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message:
          "This vendor category already exists for the selected parent category and subcategory",
      });
    }

    const finalImageUrl =
      (await fileUrl(
        req,
        "vendor-categories"
      )) ||
      cleanString(imageUrl) ||
      null;

    const data =
      await prisma.vendorCategory.create({
        data: {
          restaurantId,
          categoryId,
          subCategoryId,
          name: normalizedName,
          description:
            cleanString(description) ||
            null,
          imageUrl:
            finalImageUrl,
          isActive:
            isActive === undefined
              ? true
              : boolValue(
                  isActive,
                  true
                ),
        },
        include: {
          restaurant: {
            include: {
              city: true,
              category: true,
              subCategory: true,
            },
          },
          category: true,
          subCategory: true,
          subCategories: true,
          menuItems: true,
        },
      });

    await auditAdminAction(req, {
      action:
        "CREATE_VENDOR_CATEGORY",
      entityType:
        "VendorCategory",
      entityId: data.id,
      newData: {
        restaurantId,
        categoryId,
        subCategoryId,
        name: normalizedName,
        isActive: data.isActive,
      },
    });

    return res.status(201).json({
      success: true,
      message:
        "Vendor category created successfully",
      category: data,
      data,
    });
  } catch (error) {
    console.error(
      "Create Vendor Category Error:",
      error
    );

    if (error?.code === "P2002") {
      return res.status(409).json({
        success: false,
        message:
          "Vendor category already exists",
      });
    }

    if (error?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid parent category, parent subcategory or vendor relation",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Vendor category could not be created",
    });
  }
};

export const updateVendorCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      restaurantId,
      categoryId,
      subCategoryId,
      name,
      description,
      imageUrl,
      isActive,
    } = req.body;

    const existing =
      await prisma.vendorCategory.findUnique({
        where: {
          id,
        },
        include: {
          restaurant: true,
          category: true,
          subCategory: true,
        },
      });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message:
          "Vendor category not found",
      });
    }

    const finalRestaurantId =
      restaurantId !== undefined
        ? restaurantId
        : existing.restaurantId;

    const finalCategoryId =
      categoryId !== undefined
        ? categoryId
        : existing.categoryId;

    const finalSubCategoryId =
      subCategoryId !== undefined
        ? subCategoryId
        : existing.subCategoryId;

    if (
      !finalRestaurantId ||
      !finalCategoryId ||
      !finalSubCategoryId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "restaurantId, categoryId and subCategoryId are required",
      });
    }

    const restaurant =
      await prisma.restaurant.findUnique({
        where: {
          id: finalRestaurantId,
        },
      });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message:
          "Vendor not found",
      });
    }

    const parentCategory =
      await prisma.category.findUnique({
        where: {
          id: finalCategoryId,
        },
      });

    if (!parentCategory) {
      return res.status(404).json({
        success: false,
        message:
          "Parent category not found",
      });
    }

    const parentSubCategory =
      await prisma.productSubCategory.findFirst({
        where: {
          id: finalSubCategoryId,
          categoryId:
            finalCategoryId,
        },
      });

    if (!parentSubCategory) {
      return res.status(404).json({
        success: false,
        message:
          "Parent subcategory not found or does not belong to selected parent category",
      });
    }

    if (
      restaurant.categoryId &&
      restaurant.categoryId !==
        finalCategoryId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Selected vendor does not belong to selected parent category",
      });
    }

    if (
      restaurant.subCategoryId &&
      restaurant.subCategoryId !==
        finalSubCategoryId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Selected vendor does not belong to selected parent subcategory",
      });
    }

    const normalizedName =
      name !== undefined
        ? cleanString(name)
        : undefined;

    if (
      name !== undefined &&
      !normalizedName
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Category name cannot be empty",
      });
    }

    if (normalizedName) {
      const duplicate =
        await prisma.vendorCategory.findFirst({
          where: {
            id: {
              not: id,
            },
            restaurantId:
              finalRestaurantId,
            categoryId:
              finalCategoryId,
            subCategoryId:
              finalSubCategoryId,
            name: {
              equals:
                normalizedName,
              mode:
                "insensitive",
            },
          },
          select: {
            id: true,
          },
        });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message:
            "Another vendor category with this name already exists for the selected hierarchy",
        });
      }
    }

    const uploadedImageUrl =
      await fileUrl(
        req,
        "vendor-categories"
      );

    const finalImageUrl =
      uploadedImageUrl !== undefined
        ? uploadedImageUrl
        : imageUrl !== undefined
          ? cleanString(imageUrl) ||
            null
          : undefined;

    const updateData = {
      restaurantId:
        finalRestaurantId,
      categoryId:
        finalCategoryId,
      subCategoryId:
        finalSubCategoryId,

      ...(normalizedName !==
        undefined && {
        name:
          normalizedName,
      }),

      ...(description !==
        undefined && {
        description:
          cleanString(
            description
          ) || null,
      }),

      ...(isActive !==
        undefined && {
        isActive:
          boolValue(
            isActive,
            existing.isActive
          ),
      }),

      ...(finalImageUrl !==
        undefined && {
        imageUrl:
          finalImageUrl,
      }),
    };

    const data =
      await prisma.vendorCategory.update({
        where: {
          id,
        },
        data:
          updateData,
        include: {
          restaurant: {
            include: {
              city: true,
              category: true,
              subCategory: true,
            },
          },
          category: true,
          subCategory: true,
          subCategories: true,
          menuItems: true,
        },
      });

    await auditAdminAction(req, {
      action:
        "UPDATE_VENDOR_CATEGORY",
      entityType:
        "VendorCategory",
      entityId:
        id,
      oldData: {
        restaurantId:
          existing.restaurantId,
        categoryId:
          existing.categoryId,
        subCategoryId:
          existing.subCategoryId,
        name:
          existing.name,
        isActive:
          existing.isActive,
      },
      newData:
        updateData,
    });

    return res.json({
      success: true,
      message:
        "Vendor category updated successfully",
      category: data,
      data,
    });
  } catch (error) {
    console.error(
      "Update Vendor Category Error:",
      error
    );

    if (error?.code === "P2002") {
      return res.status(409).json({
        success: false,
        message:
          "Vendor category already exists",
      });
    }

    if (error?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid parent category, parent subcategory or vendor relation",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Vendor category could not be updated",
    });
  }
};

export const deleteVendorCategory = async (req, res) => {
  try {
    await prisma.vendorCategory.delete({
      where: { id: req.params.id },
    });

    return res.json({
      success: true,
      message: "Vendor category deleted successfully",
    });
  } catch (error) {
    console.error("Delete Vendor Category Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getVendorSubCategories = async (req, res) => {
  try {
    const { vendorCategoryId, categoryId, restaurantId } = req.query;
    const finalVendorCategoryId = vendorCategoryId || categoryId;

    const raw = await prisma.vendorSubCategory.findMany({
      where: {
        ...(finalVendorCategoryId && finalVendorCategoryId !== "ALL"
          ? { vendorCategoryId: finalVendorCategoryId }
          : {}),
        ...(restaurantId && restaurantId !== "ALL"
          ? { vendorCategory: { restaurantId } }
          : {}),
      },
      include: {
        vendorCategory: {
          include: {
            restaurant: true,
          },
        },
        menuItems: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const data = raw.map((item) => ({
      ...item,
      categoryId: item.vendorCategoryId,
      category: item.vendorCategory,
      restaurantId: item.vendorCategory?.restaurantId,
      restaurant: item.vendorCategory?.restaurant,
    }));

    return res.json({ success: true, subCategories: data, data });
  } catch (error) {
    console.error("Get Vendor Subcategories Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createVendorSubCategory = async (req, res) => {
  try {
    const { vendorCategoryId, categoryId, name, description, imageUrl } = req.body;
    const finalVendorCategoryId = vendorCategoryId || categoryId;

    if (!finalVendorCategoryId || !name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "vendorCategoryId/categoryId and name are required",
      });
    }

    const vendorCategory = await prisma.vendorCategory.findUnique({
      where: { id: finalVendorCategoryId },
    });

    if (!vendorCategory) {
      return res.status(404).json({
        success: false,
        message: "Vendor category not found",
      });
    }

    const finalImageUrl =
      (await fileUrl(req, "vendor-subcategories")) || imageUrl || null;

    const raw = await prisma.vendorSubCategory.create({
      data: {
        vendorCategoryId: finalVendorCategoryId,
        name: name.trim(),
        description: description?.trim() || null,
        imageUrl: finalImageUrl,
        isActive: true,
      },
      include: {
        vendorCategory: {
          include: { restaurant: true },
        },
        menuItems: true,
      },
    });

    const data = {
      ...raw,
      categoryId: raw.vendorCategoryId,
      category: raw.vendorCategory,
      restaurantId: raw.vendorCategory?.restaurantId,
      restaurant: raw.vendorCategory?.restaurant,
    };

    return res.status(201).json({
      success: true,
      message: "Vendor subcategory created successfully",
      subCategory: data,
      data,
    });
  } catch (error) {
    console.error("Create Vendor Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateVendorSubCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { vendorCategoryId, categoryId, name, description, imageUrl, isActive } = req.body;
    const finalVendorCategoryId = vendorCategoryId || categoryId;

    if (finalVendorCategoryId) {
      const vendorCategory = await prisma.vendorCategory.findUnique({
        where: { id: finalVendorCategoryId },
      });

      if (!vendorCategory) {
        return res.status(404).json({ success: false, message: "Vendor category not found" });
      }
    }

    const finalImageUrl = await fileUrl(req, "vendor-subcategories");

    const raw = await prisma.vendorSubCategory.update({
      where: { id },
      data: {
        ...(finalVendorCategoryId !== undefined && { vendorCategoryId: finalVendorCategoryId }),
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && {
          description: description?.trim() || null,
        }),
        ...(isActive !== undefined && { isActive: boolValue(isActive) }),
        ...(finalImageUrl && { imageUrl: finalImageUrl }),
        ...(!finalImageUrl &&
          imageUrl !== undefined && { imageUrl: imageUrl || null }),
      },
      include: {
        vendorCategory: {
          include: { restaurant: true },
        },
        menuItems: true,
      },
    });

    const data = {
      ...raw,
      categoryId: raw.vendorCategoryId,
      category: raw.vendorCategory,
      restaurantId: raw.vendorCategory?.restaurantId,
      restaurant: raw.vendorCategory?.restaurant,
    };

    return res.json({
      success: true,
      message: "Vendor subcategory updated successfully",
      subCategory: data,
      data,
    });
  } catch (error) {
    console.error("Update Vendor Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteVendorSubCategory = async (req, res) => {
  try {
    await prisma.vendorSubCategory.delete({
      where: { id: req.params.id },
    });

    return res.json({
      success: true,
      message: "Vendor subcategory deleted successfully",
    });
  } catch (error) {
    console.error("Delete Vendor Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
/* =========================
   RIDERS
========================= */

export const createRiderByAdmin = async (req, res) => {
  try {
    const {
      cityId,
      fullName,
      email,
      password,
      phone,
      vehicleNo,
      vehicleType = "BIKE",
      address,
      role = "RIDER",
      avatarUrl,
    } = req.body;

    if (!cityId || !fullName || !email || !password || !phone || !vehicleNo || !address) {
      return res.status(400).json({
        success: false,
        message:
          "cityId, fullName, email, password, phone, vehicleNo and address are required",
      });
    }

    if (role !== "RIDER") {
      return res.status(400).json({
        success: false,
        message: "Rider create role must be RIDER",
      });
    }

    const city = await prisma.city.findUnique({ where: { id: cityId } });

    if (!city) {
      return res.status(404).json({ success: false, message: "City not found" });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.trim().toLowerCase() },
          { phone: phone.trim() },
        ],
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Rider already exists",
      });
    }

    const finalAvatarUrl = (await fileUrl(req, "riders")) || avatarUrl || null;
    const hashedPassword = await bcrypt.hash(password, 10);

    const rider = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        password: hashedPassword,
        avatarUrl: finalAvatarUrl,
        role: "RIDER",
        isActive: true,
        cityId,
        address: address.trim(),
        vehicleNo: vehicleNo.trim(),
        vehicleType,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        cityId: true,
        address: true,
        vehicleNo: true,
        vehicleType: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Rider created successfully",
      rider,
      data: rider,
    });
  } catch (error) {
    console.error("Create Rider Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getAdminRiders = async (req, res) => {
  try {
    const { cityId } = req.query;

    const riders = await prisma.user.findMany({
      where: {
        role: "RIDER",
        ...(cityId && cityId !== "ALL" ? { cityId } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        cityId: true,
        address: true,
        vehicleNo: true,
        vehicleType: true,
        createdAt: true,
        riderOrders: true,
      },
    });

    const data = riders.map((rider) => {
      const delivered = rider.riderOrders.filter((o) => o.status === "DELIVERED");
      const totalDeliveryFee = delivered.reduce(
        (sum, o) => sum + moneyNumber(o.deliveryFee),
        0
      );

      return {
        ...rider,
        deliveredOrders: delivered.length,
        totalDeliveryFee,
      };
    });

    return res.json({ success: true, riders: data, data });
  } catch (error) {
    console.error("Get Riders Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


export const updateRiderByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      cityId,
      fullName,
      email,
      password,
      phone,
      vehicleNo,
      vehicleType,
      address,
      avatarUrl,
      isActive,
    } = req.body;

    if (cityId) {
      const city = await prisma.city.findUnique({ where: { id: cityId } });
      if (!city) return res.status(404).json({ success: false, message: "City not found" });
    }

    const rider = await prisma.user.findFirst({ where: { id, role: "RIDER" } });

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider not found" });
    }

    const finalAvatarUrl = await fileUrl(req, "riders");

    const data = await prisma.user.update({
      where: { id },
      data: {
        ...(cityId !== undefined && { cityId }),
        ...(fullName !== undefined && { fullName: cleanString(fullName) }),
        ...(email !== undefined && { email: cleanEmail(email) }),
        ...(phone !== undefined && { phone: cleanString(phone) }),
        ...(password ? { password: await bcrypt.hash(password, 10) } : {}),
        ...(vehicleNo !== undefined && { vehicleNo: cleanString(vehicleNo) }),
        ...(vehicleType !== undefined && { vehicleType }),
        ...(address !== undefined && { address: cleanString(address) }),
        ...(isActive !== undefined && { isActive: boolValue(isActive) }),
        ...(finalAvatarUrl && { avatarUrl: finalAvatarUrl }),
        ...(!finalAvatarUrl && avatarUrl !== undefined && { avatarUrl: avatarUrl || null }),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        cityId: true,
        address: true,
        vehicleNo: true,
        vehicleType: true,
        createdAt: true,
      },
    });

    return res.json({
      success: true,
      message: "Rider updated successfully",
      rider: data,
      data,
    });
  } catch (error) {
    console.error("Update Rider Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


export const toggleRiderActiveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const rider = await prisma.user.findFirst({ where: { id, role: "RIDER" } });

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider not found" });
    }

    const data = await prisma.user.update({
      where: { id },
      data: { isActive: boolValue(isActive) },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        cityId: true,
        address: true,
        vehicleNo: true,
        vehicleType: true,
        createdAt: true,
      },
    });

    return res.json({
      success: true,
      message: data.isActive ? "Rider activated" : "Rider blocked",
      rider: data,
      data,
    });
  } catch (error) {
    console.error("Toggle Rider Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteRiderByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const rider = await prisma.user.findFirst({ where: { id, role: "RIDER" } });
    if (!rider) return res.status(404).json({ success: false, message: "Rider not found" });

    try {
      await prisma.user.delete({ where: { id } });
      return res.json({ success: true, message: "Rider deleted successfully" });
    } catch (deleteError) {
      if (deleteError?.code !== "P2003") throw deleteError;

      const data = await prisma.user.update({
        where: { id },
        data: { isActive: false },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
        },
      });

      return res.json({
        success: true,
        message: "Rider has linked orders, so it was deactivated safely",
        rider: data,
        data,
      });
    }
  } catch (error) {
    console.error("Delete Rider Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   BUSINESS CATEGORIES
========================= */

export const getCategories = async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      include: {
        subCategories: true,
        restaurants: true,
        menuItems: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({ success: true, categories, data: categories });
  } catch (error) {
    console.error("Get Categories Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createCategory = async (req, res) => {
  try {
    const { name, description, imageUrl } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const finalImageUrl = (await fileUrl(req, "categories")) || imageUrl || null;

    const category = await prisma.category.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        imageUrl: finalImageUrl,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Category created successfully",
      category,
      data: category,
    });
  } catch (error) {
    console.error("Create Category Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, imageUrl } = req.body;

    const finalImageUrl = await fileUrl(req, "categories");

    const updateData = {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && {
        description: description?.trim() || null,
      }),
      ...(finalImageUrl && { imageUrl: finalImageUrl }),
      ...(!finalImageUrl && imageUrl !== undefined && { imageUrl: imageUrl || null }),
    };

    const category = await prisma.category.update({
      where: { id },
      data: updateData,
    });

    return res.json({
      success: true,
      message: "Category updated successfully",
      category,
      data: category,
    });
  } catch (error) {
    console.error("Update Category Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });

    return res.json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (error) {
    console.error("Delete Category Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   SUBCATEGORIES
========================= */

export const getSubCategories = async (req, res) => {
  try {
    const { categoryId } = req.query;

    const subCategories = await prisma.productSubCategory.findMany({
      where: categoryId && categoryId !== "ALL" ? { categoryId } : {},
      include: {
        category: true,
        menuItems: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      subCategories,
      data: subCategories,
    });
  } catch (error) {
    console.error("Get Subcategories Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createSubCategory = async (req, res) => {
  try {
    const { categoryId, name, description, imageUrl } = req.body;

    if (!categoryId || !name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category and subcategory name are required",
      });
    }

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const finalImageUrl =
      (await fileUrl(req, "subcategories")) || imageUrl || null;

    const subCategory = await prisma.productSubCategory.create({
      data: {
        categoryId,
        name: name.trim(),
        description: description?.trim() || null,
        imageUrl: finalImageUrl,
      },
      include: {
        category: true,
        menuItems: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Subcategory created successfully",
      subCategory,
      data: subCategory,
    });
  } catch (error) {
    console.error("Create Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateSubCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { categoryId, name, description, imageUrl } = req.body;

    const finalImageUrl = await fileUrl(req, "subcategories");

    const updateData = {
      ...(categoryId !== undefined && { categoryId }),
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && {
        description: description?.trim() || null,
      }),
      ...(finalImageUrl && { imageUrl: finalImageUrl }),
      ...(!finalImageUrl && imageUrl !== undefined && { imageUrl: imageUrl || null }),
    };

    const subCategory = await prisma.productSubCategory.update({
      where: { id },
      data: updateData,
      include: {
        category: true,
        menuItems: true,
      },
    });

    return res.json({
      success: true,
      message: "Subcategory updated successfully",
      subCategory,
      data: subCategory,
    });
  } catch (error) {
    console.error("Update Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteSubCategory = async (req, res) => {
  try {
    await prisma.productSubCategory.delete({
      where: { id: req.params.id },
    });

    return res.json({
      success: true,
      message: "Subcategory deleted successfully",
    });
  } catch (error) {
    console.error("Delete Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   MENU ITEMS
========================= */

export const getAdminMenuItems = async (req, res) => {
  try {
    const {
      restaurantId,
      vendorCategoryId,
      vendorSubCategoryId,
    } = req.query;

    const menuItems = await prisma.menuItem.findMany({
      where: {
        ...(restaurantId && restaurantId !== "ALL"
          ? { restaurantId }
          : {}),

        ...(vendorCategoryId && vendorCategoryId !== "ALL"
          ? { vendorCategoryId }
          : {}),

        ...(vendorSubCategoryId && vendorSubCategoryId !== "ALL"
          ? { vendorSubCategoryId }
          : {}),
      },

      include: {
        restaurant: true,
        category: true,
        subCategory: true,
        vendorCategory: true,
        vendorSubCategory: true,
        addons: true,
        customizations: true,
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
              },
            },
          },
        },
      },

      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json({
      success: true,
      menuItems,
      data: menuItems,
    });
  } catch (error) {
    console.error("Get Admin Menu Items Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const createMenuItem = async (req, res) => {
  try {
    const body = req.body || {};

    const {
      restaurantId,
      name,
      description,
      price,
      imageUrl,
      isVegetarian,
      isVeg,
      isPopular,
      isAvailable = "true",
      isBestSeller,
      calories,
      servingInfo,
      prepTimeMin,
      spiceLevel,
      addons,
      customizations,
    } = body;

    /*
      IMPORTANT:
      Admin Menu UI historically used categoryId/subCategoryId for the
      restaurant-owned menu category fields. Prefer explicit vendor keys,
      but keep the legacy keys as a fallback so older app builds continue
      to work without writing vendor ids into the global Category tables.
    */
    const finalVendorCategoryId =
      body.vendorCategoryId || body.categoryId || null;

    const finalVendorSubCategoryId =
      body.vendorSubCategoryId || body.subCategoryId || null;

    if (!restaurantId || !name?.trim() || price === undefined || price === null || price === "") {
      return res.status(400).json({
        success: false,
        message: "Vendor, product name and price are required",
      });
    }

    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      return res.status(400).json({
        success: false,
        message: "Price must be a valid number",
      });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    let vendorCategory = null;

    if (finalVendorCategoryId) {
      vendorCategory = await prisma.vendorCategory.findFirst({
        where: {
          id: finalVendorCategoryId,
          restaurantId,
        },
        select: {
          id: true,
          restaurantId: true,
        },
      });

      if (!vendorCategory) {
        return res.status(404).json({
          success: false,
          message: "Vendor category not found for selected restaurant",
        });
      }
    }

    if (finalVendorSubCategoryId) {
      const vendorSubCategory = await prisma.vendorSubCategory.findFirst({
        where: {
          id: finalVendorSubCategoryId,
          ...(finalVendorCategoryId
            ? { vendorCategoryId: finalVendorCategoryId }
            : {
                vendorCategory: {
                  restaurantId,
                },
              }),
        },
        select: {
          id: true,
          vendorCategoryId: true,
        },
      });

      if (!vendorSubCategory) {
        return res.status(404).json({
          success: false,
          message: "Vendor subcategory not found for selected category",
        });
      }

      // If only subcategory was supplied, derive its parent category.
      if (!vendorCategory) {
        vendorCategory = await prisma.vendorCategory.findFirst({
          where: {
            id: vendorSubCategory.vendorCategoryId,
            restaurantId,
          },
          select: {
            id: true,
            restaurantId: true,
          },
        });
      }
    }

    const finalImageUrl =
      (await fileUrl(req, "products")) || imageUrl || null;

    const finalAddons = parseJsonArray(addons);
    const finalCustomizations = parseJsonArray(customizations);

    const menuItem = await prisma.menuItem.create({
      data: {
        restaurantId,

        // Global category FKs intentionally remain null for Admin Menu items.
        categoryId: null,
        subCategoryId: null,

        vendorCategoryId: vendorCategory?.id || finalVendorCategoryId || null,
        vendorSubCategoryId: finalVendorSubCategoryId || null,

        name: name.trim(),
        description: description?.trim() || null,
        price: numericPrice,
        imageUrl: finalImageUrl,

        isVegetarian: boolValue(
          isVegetarian !== undefined ? isVegetarian : isVeg
        ),
        isVeg: boolValue(
          isVeg !== undefined ? isVeg : isVegetarian
        ),
        isPopular: boolValue(isPopular),
        isBestSeller: boolValue(isBestSeller),
        isAvailable: boolValue(isAvailable, true),

        calories:
          calories !== undefined && calories !== null && calories !== ""
            ? Number(calories)
            : null,

        servingInfo: servingInfo?.trim() || null,

        prepTimeMin:
          prepTimeMin !== undefined && prepTimeMin !== null && prepTimeMin !== ""
            ? Number(prepTimeMin)
            : 20,

        spiceLevel:
          spiceLevel !== undefined && spiceLevel !== null && spiceLevel !== ""
            ? Number(spiceLevel)
            : 0,

        addons: {
          create: finalAddons
            .filter((a) => a?.title)
            .map((a) => ({
              title: String(a.title).trim(),
              price: Number(a.price || 0),
              imageUrl: a.imageUrl || null,
              isActive:
                a.isActive === undefined
                  ? true
                  : boolValue(a.isActive, true),
            })),
        },

        customizations: {
          create: finalCustomizations
            .filter((c) => c?.title)
            .map((c) => ({
              title: String(c.title).trim(),
              price: Number(c.price || 0),
              isRequired: boolValue(c.isRequired),
              isActive:
                c.isActive === undefined
                  ? true
                  : boolValue(c.isActive, true),
            })),
        },
      },

      include: {
        restaurant: true,
        category: true,
        subCategory: true,
        vendorCategory: true,
        vendorSubCategory: true,
        addons: true,
        customizations: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Menu item created successfully",
      menuItem,
      data: menuItem,
    });
  } catch (error) {
    console.error("Create Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Unable to create menu item",
    });
  }
};

export const updateMenuItem = async (req, res) => {
  try {
    const body = req.body || {};
    const { id } = req.params;

    const existing = await prisma.menuItem.findUnique({
      where: { id },
      select: {
        id: true,
        restaurantId: true,
        vendorCategoryId: true,
        vendorSubCategoryId: true,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const {
      name,
      description,
      price,
      imageUrl,
      isVegetarian,
      isVeg,
      isPopular,
      isAvailable,
      isBestSeller,
      calories,
      servingInfo,
      prepTimeMin,
      spiceLevel,
      addons,
      customizations,
    } = body;

    const hasVendorCategoryField =
      body.vendorCategoryId !== undefined || body.categoryId !== undefined;

    const hasVendorSubCategoryField =
      body.vendorSubCategoryId !== undefined || body.subCategoryId !== undefined;

    const finalVendorCategoryId = hasVendorCategoryField
      ? (body.vendorCategoryId || body.categoryId || null)
      : existing.vendorCategoryId;

    const finalVendorSubCategoryId = hasVendorSubCategoryField
      ? (body.vendorSubCategoryId || body.subCategoryId || null)
      : existing.vendorSubCategoryId;

    if (finalVendorCategoryId) {
      const vendorCategory = await prisma.vendorCategory.findFirst({
        where: {
          id: finalVendorCategoryId,
          restaurantId: existing.restaurantId,
        },
        select: { id: true },
      });

      if (!vendorCategory) {
        return res.status(404).json({
          success: false,
          message: "Vendor category not found for this restaurant",
        });
      }
    }

    if (finalVendorSubCategoryId) {
      const vendorSubCategory = await prisma.vendorSubCategory.findFirst({
        where: {
          id: finalVendorSubCategoryId,
          ...(finalVendorCategoryId
            ? { vendorCategoryId: finalVendorCategoryId }
            : {
                vendorCategory: {
                  restaurantId: existing.restaurantId,
                },
              }),
        },
        select: { id: true },
      });

      if (!vendorSubCategory) {
        return res.status(404).json({
          success: false,
          message: "Vendor subcategory not found for selected category",
        });
      }
    }

    if (price !== undefined) {
      const numericPrice = Number(price);
      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "Price must be a valid number",
        });
      }
    }

    const finalImageUrl = await fileUrl(req, "products");

    const updateData = {
      // Clear legacy/global category links if an older record had them.
      ...(hasVendorCategoryField && { categoryId: null }),
      ...(hasVendorSubCategoryField && { subCategoryId: null }),

      ...(hasVendorCategoryField && {
        vendorCategoryId: finalVendorCategoryId,
      }),

      ...(hasVendorSubCategoryField && {
        vendorSubCategoryId: finalVendorSubCategoryId,
      }),

      ...(name !== undefined && { name: String(name).trim() }),

      ...(description !== undefined && {
        description: description ? String(description).trim() : null,
      }),

      ...(price !== undefined && { price: Number(price) }),

      ...(isVegetarian !== undefined && {
        isVegetarian: boolValue(isVegetarian),
      }),

      ...(isVeg !== undefined && {
        isVeg: boolValue(isVeg),
      }),

      ...(isPopular !== undefined && {
        isPopular: boolValue(isPopular),
      }),

      ...(isBestSeller !== undefined && {
        isBestSeller: boolValue(isBestSeller),
      }),

      ...(isAvailable !== undefined && {
        isAvailable: boolValue(isAvailable, true),
      }),

      ...(calories !== undefined && {
        calories:
          calories !== null && calories !== ""
            ? Number(calories)
            : null,
      }),

      ...(servingInfo !== undefined && {
        servingInfo: servingInfo ? String(servingInfo).trim() : null,
      }),

      ...(prepTimeMin !== undefined && {
        prepTimeMin:
          prepTimeMin !== null && prepTimeMin !== ""
            ? Number(prepTimeMin)
            : 20,
      }),

      ...(spiceLevel !== undefined && {
        spiceLevel:
          spiceLevel !== null && spiceLevel !== ""
            ? Number(spiceLevel)
            : 0,
      }),

      ...(finalImageUrl && { imageUrl: finalImageUrl }),

      ...(!finalImageUrl &&
        imageUrl !== undefined && {
          imageUrl: imageUrl || null,
        }),
    };

    const finalAddons = parseJsonArray(addons);
    const finalCustomizations = parseJsonArray(customizations);

    const menuItem = await prisma.$transaction(async (tx) => {
      await tx.menuItem.update({
        where: { id },
        data: updateData,
      });

      if (addons !== undefined) {
        await tx.menuItemAddon.deleteMany({
          where: { menuItemId: id },
        });

        if (finalAddons.length) {
          await tx.menuItemAddon.createMany({
            data: finalAddons
              .filter((a) => a?.title)
              .map((a) => ({
                menuItemId: id,
                title: String(a.title).trim(),
                price: Number(a.price || 0),
                imageUrl: a.imageUrl || null,
                isActive:
                  a.isActive === undefined
                    ? true
                    : boolValue(a.isActive, true),
              })),
          });
        }
      }

      if (customizations !== undefined) {
        await tx.menuItemCustomization.deleteMany({
          where: { menuItemId: id },
        });

        if (finalCustomizations.length) {
          await tx.menuItemCustomization.createMany({
            data: finalCustomizations
              .filter((c) => c?.title)
              .map((c) => ({
                menuItemId: id,
                title: String(c.title).trim(),
                price: Number(c.price || 0),
                isRequired: boolValue(c.isRequired),
                isActive:
                  c.isActive === undefined
                    ? true
                    : boolValue(c.isActive, true),
              })),
          });
        }
      }

      return tx.menuItem.findUnique({
        where: { id },
        include: {
          restaurant: true,
          category: true,
          subCategory: true,
          vendorCategory: true,
          vendorSubCategory: true,
          addons: true,
          customizations: true,
        },
      });
    });

    return res.json({
      success: true,
      message: "Menu item updated successfully",
      menuItem,
      data: menuItem,
    });
  } catch (error) {
    console.error("Update Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Unable to update menu item",
    });
  }
};

export const deleteMenuItem = async (req, res) => {
  try {
    await prisma.menuItem.delete({
      where: { id: req.params.id },
    });

    return res.json({
      success: true,
      message: "Menu item deleted successfully",
    });
  } catch (error) {
    console.error("Delete Menu Item Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   MENU ADDONS
========================= */

export const createMenuItemAddon = async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { title, name, price, imageUrl, isActive = true } = req.body;
    const finalTitle = title || name;

    if (!finalTitle?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Addon title/name is required",
      });
    }

    const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
    if (!menuItem) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    const finalImageUrl = (await fileUrl(req, "addons")) || imageUrl || null;

    const addon = await prisma.menuItemAddon.create({
      data: {
        menuItemId,
        title: finalTitle.trim(),
        price: Number(price || 0),
        imageUrl: finalImageUrl,
        isActive: boolValue(isActive, true),
      },
    });

    return res.status(201).json({
      success: true,
      message: "Addon created successfully",
      addon,
      data: addon,
    });
  } catch (error) {
    console.error("Create Addon Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMenuItemAddon = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, name, price, imageUrl, isActive } = req.body;
    const finalTitle = title || name;

    const finalImageUrl = await fileUrl(req, "addons");

    const updateData = {
      ...(finalTitle !== undefined && { title: finalTitle.trim() }),
      ...(price !== undefined && { price: Number(price || 0) }),
      ...(isActive !== undefined && { isActive: boolValue(isActive) }),
      ...(finalImageUrl && { imageUrl: finalImageUrl }),
      ...(!finalImageUrl && imageUrl !== undefined && { imageUrl: imageUrl || null }),
    };

    const addon = await prisma.menuItemAddon.update({
      where: { id },
      data: updateData,
    });

    return res.json({
      success: true,
      message: "Addon updated successfully",
      addon,
      data: addon,
    });
  } catch (error) {
    console.error("Update Addon Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteMenuItemAddon = async (req, res) => {
  try {
    await prisma.menuItemAddon.delete({
      where: { id: req.params.id },
    });

    return res.json({
      success: true,
      message: "Addon deleted successfully",
    });
  } catch (error) {
    console.error("Delete Addon Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   MENU CUSTOMIZATIONS
========================= */

export const createMenuItemCustomization = async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { title, name, price, isRequired = false, required, isActive = true } = req.body;
    const finalTitle = title || name;

    if (!finalTitle?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Customization title/name is required",
      });
    }

    const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
    if (!menuItem) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    const customization = await prisma.menuItemCustomization.create({
      data: {
        menuItemId,
        title: finalTitle.trim(),
        price: Number(price || 0),
        isRequired: boolValue(isRequired ?? required),
        isActive: boolValue(isActive, true),
      },
    });

    return res.status(201).json({
      success: true,
      message: "Customization created successfully",
      customization,
      data: customization,
    });
  } catch (error) {
    console.error("Create Customization Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMenuItemCustomization = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, name, price, isRequired, required, isActive } = req.body;
    const finalTitle = title || name;

    const customization = await prisma.menuItemCustomization.update({
      where: { id },
      data: {
        ...(finalTitle !== undefined && { title: finalTitle.trim() }),
        ...(price !== undefined && { price: Number(price || 0) }),
        ...((isRequired !== undefined || required !== undefined) && {
          isRequired: boolValue(isRequired ?? required),
        }),
        ...(isActive !== undefined && { isActive: boolValue(isActive) }),
      },
    });

    return res.json({
      success: true,
      message: "Customization updated successfully",
      customization,
      data: customization,
    });
  } catch (error) {
    console.error("Update Customization Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteMenuItemCustomization = async (req, res) => {
  try {
    await prisma.menuItemCustomization.delete({
      where: { id: req.params.id },
    });

    return res.json({
      success: true,
      message: "Customization deleted successfully",
    });
  } catch (error) {
    console.error("Delete Customization Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   ORDERS
========================= */

export const getAdminOrders = async (req, res) => {
  try {
    const { status, cityId, vendorId } = req.query;

    const where = {};

    if (status && status !== "ALL") where.status = status;
    if (vendorId && vendorId !== "ALL") where.restaurantId = vendorId;
    if (cityId && cityId !== "ALL") where.restaurant = { cityId };

    const orders = await prisma.order.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
          },
        },
        restaurant: {
          include: {
            city: true,
            vendor: true,
          },
        },
        rider: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
          },
        },
        address: true,
        items: {
          include: {
            menuItem: true,
          },
        },
        history: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, orders, data: orders });
  } catch (error) {
    console.error("Admin Orders Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getAdminOrderById = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        user: true,
        restaurant: {
          include: {
            city: true,
            vendor: true,
          },
        },
        rider: true,
        address: true,
        items: {
          include: {
            menuItem: true,
          },
        },
        history: {
          include: {
            changedByUser: {
              select: {
                id: true,
                fullName: true,
                role: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.json({ success: true, order, data: order });
  } catch (error) {
    console.error("Admin Order Detail Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateOrderStatusByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    const allowedStatuses = [
      "PLACED",
      "ACCEPTED_BY_VENDOR",
      "PREPARING",
      "READY_FOR_PICKUP",
      "ASSIGNED_TO_RIDER",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "CANCELLED",
    ];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const before = await prisma.order.findUnique({
      where: { id },
      include: { restaurant: true, rider: true, vendor: true },
    });
    if (!before) return res.status(404).json({ success: false, message: "Order not found" });

    // Final states should not be silently moved back into fulfilment.
    if (["DELIVERED", "CANCELLED"].includes(before.status) && before.status !== status) {
      return res.status(409).json({ success: false, message: `Order is already ${before.status}. Final status cannot be changed directly.` });
    }

    const timeFieldMap = {
      ACCEPTED_BY_VENDOR: "acceptedAt",
      PREPARING: "preparingAt",
      READY_FOR_PICKUP: "readyAt",
      PICKED_UP: "pickedAt",
      DELIVERED: "deliveredAt",
      CANCELLED: "cancelledAt",
    };

    const updateData = { status };
    if (timeFieldMap[status] && !before[timeFieldMap[status]]) updateData[timeFieldMap[status]] = new Date();

    // A successfully delivered COD order means cash was collected at delivery.
    if (status === "DELIVERED" && before.paymentMethod === "COD" && before.paymentStatus !== "PAID") {
      updateData.paymentStatus = "PAID";
    }

    const order = await prisma.$transaction(async (tx) => {
      let updated = await tx.order.update({
        where: { id },
        data: updateData,
        include: { user: true, restaurant: true, rider: true, vendor: true, items: true },
      });

      await tx.orderStatusHistory.create({
        data: { orderId: id, status, changedBy: req.user.id, note: note || `Admin updated status to ${status}` },
      });

      if (isRecognizedOrder(updated)) {
        await ensureSettlementsForRecognizedOrder(tx, updated);
        updated = await tx.order.findUnique({
          where: { id },
          include: { user: true, restaurant: true, rider: true, vendor: true, items: true },
        });
      }
      return updated;
    });

    await auditAdminAction(req, {
      action: "ORDER_STATUS_UPDATED",
      entityType: "Order",
      entityId: id,
      oldData: { status: before.status, paymentStatus: before.paymentStatus },
      newData: { status: order.status, paymentStatus: order.paymentStatus },
      metadata: { note: note || null },
    });

    emitOrderStatus(id, status, { order });
    return res.json({ success: true, message: "Order status updated", order, data: order });
  } catch (error) {
    console.error("Admin Update Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const assignRiderByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({
        success: false,
        message: "riderId is required",
      });
    }

    const rider = await prisma.user.findFirst({
      where: {
        id: riderId,
        role: "RIDER",
        isActive: true,
      },
    });

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Active rider not found",
      });
    }

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: {
          riderId,
          status: "ASSIGNED_TO_RIDER",
        },
        include: {
          user: true,
          restaurant: true,
          rider: true,
          items: true,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: "ASSIGNED_TO_RIDER",
          changedBy: req.user.id,
          note: `Admin assigned rider ${rider.fullName || rider.phone}`,
        },
      });

      return updated;
    });

    emitOrderStatus(id, "ASSIGNED_TO_RIDER", { order });

    return res.json({
      success: true,
      message: "Rider assigned successfully",
      order,
      data: order,
    });
  } catch (error) {
    console.error("Assign Rider Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


/* =========================
   COUPONS
========================= */

export const getCoupons = async (req, res) => {
  try {
    if (!prisma.coupon) {
      return res.status(501).json({
        success: false,
        message: "Coupon model is missing in Prisma schema/backend",
      });
    }

    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, coupons, data: coupons });
  } catch (error) {
    console.error("Get Coupons Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createCoupon = async (req, res) => {
  try {
    if (!prisma.coupon) {
      return res.status(501).json({
        success: false,
        message: "Coupon model is missing in Prisma schema/backend",
      });
    }

    const {
      code,
      title,
      description,
      discountType = "PERCENTAGE",
      discountValue,
      minOrderAmount = 0,
      maxDiscountAmount,
      maxDiscount,
      startDate,
      startsAt,
      endDate,
      expiresAt,
      usageLimit,
      perUserLimit,
      userUsageLimit,
      audience,
      isActive = true,
    } = req.body;

    if (!code?.trim() || discountValue === undefined) {
      return res.status(400).json({
        success: false,
        message: "Coupon code and discountValue are required",
      });
    }

    const finalMaxDiscount = maxDiscountAmount ?? maxDiscount;
    const finalStartDate = startDate ?? startsAt;
    const finalEndDate = endDate ?? expiresAt;
    const finalPerUserLimit = perUserLimit ?? userUsageLimit ?? 1;

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        ...(title !== undefined && { title: title?.trim() || code.trim().toUpperCase() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(audience !== undefined && { audience }),
        discountType,
        discountValue: Number(discountValue),
        minOrderAmount: Number(minOrderAmount || 0),
        ...(finalMaxDiscount !== undefined && {
          maxDiscountAmount: finalMaxDiscount ? Number(finalMaxDiscount) : null,
        }),
        ...(finalStartDate && { startDate: new Date(finalStartDate) }),
        ...(finalEndDate && { endDate: new Date(finalEndDate) }),
        ...(usageLimit !== undefined && { usageLimit: usageLimit ? Number(usageLimit) : null }),
        ...(finalPerUserLimit !== undefined && { perUserLimit: Number(finalPerUserLimit || 1) }),
        isActive: boolValue(isActive, true),
      },
    });

    return res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      coupon,
      data: coupon,
    });
  } catch (error) {
    console.error("Create Coupon Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateCoupon = async (req, res) => {
  try {
    if (!prisma.coupon) {
      return res.status(501).json({
        success: false,
        message: "Coupon model is missing in Prisma schema/backend",
      });
    }

    const { id } = req.params;
    const {
      code,
      title,
      description,
      discountType,
      discountValue,
      minOrderAmount,
      maxDiscountAmount,
      maxDiscount,
      startDate,
      startsAt,
      endDate,
      expiresAt,
      usageLimit,
      perUserLimit,
      userUsageLimit,
      audience,
      isActive,
    } = req.body;

    const finalMaxDiscount = maxDiscountAmount ?? maxDiscount;
    const finalStartDate = startDate ?? startsAt;
    const finalEndDate = endDate ?? expiresAt;
    const finalPerUserLimit = perUserLimit ?? userUsageLimit;

    const coupon = await prisma.coupon.update({
      where: { id },
      data: {
        ...(code !== undefined && { code: code.trim().toUpperCase() }),
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(audience !== undefined && { audience }),
        ...(discountType !== undefined && { discountType }),
        ...(discountValue !== undefined && { discountValue: Number(discountValue) }),
        ...(minOrderAmount !== undefined && { minOrderAmount: Number(minOrderAmount || 0) }),
        ...(finalMaxDiscount !== undefined && {
          maxDiscountAmount: finalMaxDiscount ? Number(finalMaxDiscount) : null,
        }),
        ...(finalStartDate !== undefined && { startDate: finalStartDate ? new Date(finalStartDate) : null }),
        ...(finalEndDate !== undefined && { endDate: finalEndDate ? new Date(finalEndDate) : null }),
        ...(usageLimit !== undefined && { usageLimit: usageLimit ? Number(usageLimit) : null }),
        ...(finalPerUserLimit !== undefined && { perUserLimit: Number(finalPerUserLimit || 1) }),
        ...(isActive !== undefined && { isActive: boolValue(isActive) }),
      },
    });

    return res.json({
      success: true,
      message: "Coupon updated successfully",
      coupon,
      data: coupon,
    });
  } catch (error) {
    console.error("Update Coupon Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteCoupon = async (req, res) => {
  try {
    if (!prisma.coupon) {
      return res.status(501).json({
        success: false,
        message: "Coupon model is missing in Prisma schema/backend",
      });
    }

    const { id } = req.params;

    try {
      await prisma.coupon.delete({ where: { id } });
      return res.json({ success: true, message: "Coupon deleted successfully" });
    } catch (deleteError) {
      if (deleteError?.code !== "P2003") throw deleteError;

      const coupon = await prisma.coupon.update({
        where: { id },
        data: { isActive: false },
      });

      return res.json({
        success: true,
        message: "Coupon has linked orders, so it was deactivated safely",
        coupon,
        data: coupon,
      });
    }
  } catch (error) {
    console.error("Delete Coupon Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   BILLING
========================= */

export const getRiderBilling = async (req, res) => {
  try {
    const { id } = req.params;
    const { start, end } = getDateRange({
      from: req.query.from,
      to: req.query.to,
      type: req.query.type || "daily",
    });

    const rider = await prisma.user.findFirst({
      where: { id, role: "RIDER" },
      select: { id: true, fullName: true, phone: true, email: true, vehicleNo: true, vehicleType: true },
    });
    if (!rider) return res.status(404).json({ success: false, message: "Rider not found" });

    const orders = await prisma.order.findMany({
      where: { riderId: id, status: "DELIVERED", paymentStatus: "PAID", deliveredAt: { gte: start, lte: end } },
      include: { restaurant: { select: { id: true, name: true } } },
      orderBy: { deliveredAt: "desc" },
    });

    const settlements = prisma.riderSettlement
      ? await prisma.riderSettlement.findMany({ where: { riderId: id, createdAt: { gte: start, lte: end } }, orderBy: { createdAt: "desc" } })
      : [];

    const deliveryEarnings = roundMoney(orders.reduce((sum, o) => sum + moneyNumber(o.deliveryFee), 0));
    const settledAmount = roundMoney(settlements.filter((s) => s.status === "PAID").reduce((sum, s) => sum + moneyNumber(s.amount), 0));
    const pendingAmount = roundMoney(settlements.filter((s) => ["PENDING", "PROCESSING"].includes(s.status)).reduce((sum, s) => sum + moneyNumber(s.amount), 0));

    return res.json({
      success: true,
      data: {
        rider,
        type: req.query.type || "daily",
        periodStart: start,
        periodEnd: end,
        deliveredOrders: orders.length,
        deliveryEarnings,
        bonus: 0,
        deductions: 0,
        payable: deliveryEarnings,
        settledAmount,
        pendingAmount,
        orders,
        settlements,
      },
    });
  } catch (error) {
    console.error("Rider Billing Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getMonthlyBilling = async (req, res) => {
  try {
    const { start, end } = getDateRange({
      from: req.query.from,
      to: req.query.to,
      type: req.query.type || "monthly",
    });

    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: {
        restaurant: { include: { city: true, vendor: true } },
        rider: { select: { id: true, fullName: true, phone: true, email: true } },
        user: { select: { id: true, fullName: true, phone: true, email: true } },
        refunds: true,
        paymentTransactions: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const summary = {
      periodStart: start,
      periodEnd: end,
      totalOrders: orders.length,
      deliveredOrders: 0,
      cancelledOrders: 0,
      activeOrders: 0,
      paidOrders: 0,
      pendingPayments: 0,
      failedPayments: 0,
      refundedOrders: 0,
      codOrders: 0,
      onlineOrders: 0,
      upiOrders: 0,
      cardOrders: 0,
      walletOrders: 0,
      recognizedRevenue: 0,
      platformCommission: 0,
      vendorPayable: 0,
      riderPayable: 0,
      codCollected: 0,
      onlineCollected: 0,
      heldOnlineAmount: 0,
      refundCompleted: 0,
      refundPending: 0,
      taxCollected: 0,
      cgstCollected: 0,
      sgstCollected: 0,
      platformFees: 0,
      discounts: 0,
      deliveryFees: 0,
      legacyCommissionOrders: 0,
    };

    const vendorMap = new Map();

    for (const order of orders) {
      const finance = getOrderFinancials(order);
      const isDelivered = order.status === "DELIVERED";
      const isCancelled = order.status === "CANCELLED";
      const isPaid = order.paymentStatus === "PAID";
      const isRefunded = order.paymentStatus === "REFUNDED";
      const refundTotal = roundMoney((order.refunds || []).filter((r) => r.status === "COMPLETED").reduce((s, r) => s + moneyNumber(r.amount), 0));

      if (isDelivered) summary.deliveredOrders += 1;
      else if (isCancelled) summary.cancelledOrders += 1;
      else summary.activeOrders += 1;

      if (order.paymentStatus === "PAID") summary.paidOrders += 1;
      else if (order.paymentStatus === "PENDING") summary.pendingPayments += 1;
      else if (order.paymentStatus === "FAILED") summary.failedPayments += 1;
      else if (order.paymentStatus === "REFUNDED") summary.refundedOrders += 1;

      if (order.paymentMethod === "COD") summary.codOrders += 1;
      else if (order.paymentMethod === "ONLINE") summary.onlineOrders += 1;
      else if (order.paymentMethod === "UPI") summary.upiOrders += 1;
      else if (order.paymentMethod === "CARD") summary.cardOrders += 1;
      else if (order.paymentMethod === "WALLET") summary.walletOrders += 1;

      if (finance.legacyCommissionFallback && isDelivered && isPaid) summary.legacyCommissionOrders += 1;

      if (isRecognizedOrder(order)) {
        summary.recognizedRevenue += finance.totalAmount;
        summary.platformCommission += finance.platformCommission;
        summary.vendorPayable += finance.vendorPayable;
        summary.riderPayable += moneyNumber(order.deliveryFee);
        summary.taxCollected += moneyNumber(order.taxAmount);
        summary.cgstCollected += moneyNumber(order.cgstAmount);
        summary.sgstCollected += moneyNumber(order.sgstAmount);
        summary.platformFees += moneyNumber(order.platformFee);
        summary.discounts += moneyNumber(order.discount);
        summary.deliveryFees += moneyNumber(order.deliveryFee);
        if (order.paymentMethod === "COD") summary.codCollected += finance.totalAmount;
        else summary.onlineCollected += finance.totalAmount;
      }

      if (!isDelivered && !isCancelled && isPaid && isPrepaidMethod(order.paymentMethod)) {
        summary.heldOnlineAmount += Math.max(finance.totalAmount - refundTotal, 0);
      }

      if (isCancelled && isPrepaidMethod(order.paymentMethod)) {
        if (isRefunded || refundTotal >= finance.totalAmount) {
          summary.refundCompleted += refundTotal || finance.totalAmount;
        } else if (isPaid) {
          summary.refundCompleted += refundTotal;
          summary.refundPending += Math.max(finance.totalAmount - refundTotal, 0);
        }
      }

      const vendorKey = order.restaurantId;
      if (!vendorMap.has(vendorKey)) {
        vendorMap.set(vendorKey, {
          id: vendorKey,
          vendorId: order.restaurant?.vendorId || order.vendorId || null,
          name: order.restaurant?.name || "Unknown Vendor",
          city: order.restaurant?.city?.name || "-",
          currentCommissionRate: roundMoney(order.restaurant?.commission),
          totalOrders: 0,
          deliveredOrders: 0,
          cancelledOrders: 0,
          activeOrders: 0,
          codOrders: 0,
          prepaidOrders: 0,
          recognizedRevenue: 0,
          commissionableAmount: 0,
          platformCommission: 0,
          vendorPayable: 0,
          refundPending: 0,
          refundCompleted: 0,
          orders: [],
        });
      }

      const vendor = vendorMap.get(vendorKey);
      vendor.totalOrders += 1;
      if (isDelivered) vendor.deliveredOrders += 1;
      else if (isCancelled) vendor.cancelledOrders += 1;
      else vendor.activeOrders += 1;
      if (order.paymentMethod === "COD") vendor.codOrders += 1;
      else vendor.prepaidOrders += 1;

      if (isRecognizedOrder(order)) {
        vendor.recognizedRevenue += finance.totalAmount;
        vendor.commissionableAmount += finance.commissionableAmount;
        vendor.platformCommission += finance.platformCommission;
        vendor.vendorPayable += finance.vendorPayable;
      }

      if (isCancelled && isPrepaidMethod(order.paymentMethod)) {
        if (isRefunded || refundTotal >= finance.totalAmount) vendor.refundCompleted += refundTotal || finance.totalAmount;
        else if (isPaid) {
          vendor.refundCompleted += refundTotal;
          vendor.refundPending += Math.max(finance.totalAmount - refundTotal, 0);
        }
      }

      vendor.orders.push({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        totalAmount: finance.totalAmount,
        commissionableAmount: finance.commissionableAmount,
        commissionRate: finance.commissionRate,
        platformCommission: isRecognizedOrder(order) ? finance.platformCommission : 0,
        vendorPayable: isRecognizedOrder(order) ? finance.vendorPayable : 0,
        legacyCommissionFallback: finance.legacyCommissionFallback,
        deliveryFee: roundMoney(order.deliveryFee),
        itemTotal: roundMoney(order.itemTotal),
        discount: roundMoney(order.discount),
        taxAmount: roundMoney(order.taxAmount),
        cgstAmount: roundMoney(order.cgstAmount),
        sgstAmount: roundMoney(order.sgstAmount),
        platformFee: roundMoney(order.platformFee),
        refundAmount: refundTotal,
        customer: order.user?.fullName || "Customer",
        rider: order.rider?.fullName || null,
        createdAt: order.createdAt,
        deliveredAt: order.deliveredAt,
        cancelledAt: order.cancelledAt,
        cancelReason: order.cancelReason,
      });
    }

    Object.keys(summary).forEach((key) => {
      if (typeof summary[key] === "number" && !Number.isInteger(summary[key])) summary[key] = roundMoney(summary[key]);
    });

    const vendorBilling = Array.from(vendorMap.values())
      .map((v) => ({
        ...v,
        recognizedRevenue: roundMoney(v.recognizedRevenue),
        commissionableAmount: roundMoney(v.commissionableAmount),
        platformCommission: roundMoney(v.platformCommission),
        vendorPayable: roundMoney(v.vendorPayable),
        refundPending: roundMoney(v.refundPending),
        refundCompleted: roundMoney(v.refundCompleted),
      }))
      .sort((a, b) => b.recognizedRevenue - a.recognizedRevenue);

    return res.json({
      success: true,
      data: {
        monthStart: start,
        ...summary,
        totalDeliveredOrders: summary.deliveredOrders,
        totalRevenue: summary.recognizedRevenue,
        netPlatformIncome: roundMoney(summary.platformCommission - summary.riderPayable),
        vendorBilling,
        orders,
      },
    });
  } catch (error) {
    console.error("Monthly Billing Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Unable to load billing" });
  }
};

export const deleteCity = async (req, res) => {
  try {
    const { id } = req.params;

    const city = await prisma.city.findUnique({ where: { id } });

    if (!city) {
      return res.status(404).json({ success: false, message: "City not found" });
    }

    try {
      await prisma.city.delete({ where: { id } });
      return res.json({ success: true, message: "City deleted successfully" });
    } catch (deleteError) {
      if (deleteError?.code !== "P2003") throw deleteError;

      const updated = await prisma.city.update({
        where: { id },
        data: { isActive: false },
      });

      return res.json({
        success: true,
        message: "City has linked records, so it was deactivated safely",
        city: updated,
        data: updated,
      });
    }
  } catch (error) {
    console.error("Delete City Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
export const updateCity = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, stateId, isActive } = req.body;

    const city = await prisma.city.findUnique({ where: { id } });

    if (!city) {
      return res.status(404).json({ success: false, message: "City not found" });
    }

    const updatedCity = await prisma.city.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: cleanString(name) }),
        ...(code !== undefined && { code: cleanString(code)?.toUpperCase() }),
        ...(stateId !== undefined && { stateId }),
        ...(isActive !== undefined && { isActive: boolValue(isActive) }),
      },
    });

    return res.json({
      success: true,
      message: "City updated successfully",
      city: updatedCity,
      data: updatedCity,
    });
  } catch (error) {
    console.error("Update City Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
/* =========================
   ADMIN NOTIFICATIONS
========================= */

const notificationAllowedTypes = [
  "ORDER",
  "PAYMENT",
  "OFFER",
  "SUPPORT",
  "REFERRAL",
  "WALLET",
  "SYSTEM",
];

export const getAdminNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      take: 150,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            cityId: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      notifications,
      data: notifications,
    });
  } catch (error) {
    console.error("Get Admin Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const sendAdminNotification = async (req, res) => {
  try {
    const {
      title,
      body,
      target = "ALL",
      role,
      userId,
      cityId,
      type = "OFFER",
      imageUrl,
      deepLink,
    } = req.body;

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({
        success: false,
        message: "title and body are required",
      });
    }

    if (!notificationAllowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification type",
      });
    }

    const where = {
      isActive: true,
      ...(target === "USER" && userId ? { id: userId } : {}),
      ...(target === "ROLE" && role ? { role } : {}),
      ...(target === "CITY" && cityId ? { cityId } : {}),
    };

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        role: true,
        cityId: true,
      },
    });

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: "No active users found for this target",
      });
    }

    const cleanTitle = title.trim();
    const cleanBody = body.trim();

    const dataPayload = {
      source: "ADMIN",
      target,
      role: role || null,
      cityId: cityId || null,
      imageUrl: imageUrl || null,
      deepLink: deepLink || null,
      sentBy: req.user?.id || null,
    };

    await prisma.notification.createMany({
      data: users.map((user) => ({
        userId: user.id,
        type,
        title: cleanTitle,
        body: cleanBody,
        data: dataPayload,
        isRead: false,
      })),
    });

    let sent = 0;
    let failed = 0;

    await Promise.allSettled(
      users.map(async (user) => {
        try {
          await sendPushToUser({
            userId: user.id,
            type,
            title: cleanTitle,
            body: cleanBody,
            data: dataPayload,
            saveToDb: false,
          });

          sent += 1;
        } catch (error) {
          failed += 1;
          console.error("Admin Push Error:", error.message);
        }
      })
    );

    return res.status(201).json({
      success: true,
      message: "Notification sent successfully",
      data: {
        totalUsers: users.length,
        sent,
        failed,
        title: cleanTitle,
        body: cleanBody,
        type,
        target,
      },
    });
  } catch (error) {
    console.error("Send Admin Notification Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

/* =========================================================
   PRODUCTION ADMIN: PAYMENTS, REFUNDS, BILLING & INVOICES
========================================================= */

export const updateOrderPaymentStatusByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentStatus, note } = req.body;
    const allowed = ["PENDING", "PAID", "FAILED", "REFUNDED"];
    if (!allowed.includes(paymentStatus)) return res.status(400).json({ success: false, message: "Invalid paymentStatus" });

    const before = await prisma.order.findUnique({ where: { id }, include: { restaurant: true, rider: true, vendor: true } });
    if (!before) return res.status(404).json({ success: false, message: "Order not found" });

    const order = await prisma.$transaction(async (tx) => {
      let updated = await tx.order.update({
        where: { id },
        data: { paymentStatus },
        include: { restaurant: true, rider: true, vendor: true },
      });
      if (isRecognizedOrder(updated)) {
        await ensureSettlementsForRecognizedOrder(tx, updated);
        updated = await tx.order.findUnique({ where: { id }, include: { restaurant: true, rider: true, vendor: true } });
      }
      return updated;
    });

    await auditAdminAction(req, { action: "ORDER_PAYMENT_STATUS_UPDATED", entityType: "Order", entityId: id, oldData: { paymentStatus: before.paymentStatus }, newData: { paymentStatus }, metadata: { note: note || null } });
    return res.json({ success: true, message: "Payment status updated", order, data: order });
  } catch (error) {
    console.error("Admin Payment Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getAdminPayments = async (req, res) => {
  try {
    const { status, method, provider, orderId } = req.query;
    const { start, end } = getDateRange({ from: req.query.from, to: req.query.to, type: req.query.type || "monthly" });
    const data = await prisma.paymentTransaction.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        ...(status && status !== "ALL" ? { status } : {}),
        ...(method && method !== "ALL" ? { method } : {}),
        ...(provider ? { provider: { contains: String(provider), mode: "insensitive" } } : {}),
        ...(orderId ? { orderId } : {}),
      },
      include: {
        order: { include: { user: { select: { id: true, fullName: true, phone: true, email: true } }, restaurant: { select: { id: true, name: true } } } },
        refunds: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const summary = data.reduce((a, p) => {
      a.total += moneyNumber(p.amount); a.gatewayFee += moneyNumber(p.gatewayFee); a.netReceived += moneyNumber(p.netReceived);
      if (p.status === "SUCCESS") a.success += 1; else if (p.status === "FAILED") a.failed += 1; else a.pending += 1;
      return a;
    }, { count: data.length, total: 0, gatewayFee: 0, netReceived: 0, success: 0, failed: 0, pending: 0 });
    summary.total = roundMoney(summary.total); summary.gatewayFee = roundMoney(summary.gatewayFee); summary.netReceived = roundMoney(summary.netReceived);
    return res.json({ success: true, data, payments: data, summary, periodStart: start, periodEnd: end });
  } catch (error) { console.error("Get Payments Error:", error); return res.status(500).json({ success: false, message: error.message }); }
};

export const getAdminRefunds = async (req, res) => {
  try {
    const { status, orderId } = req.query;
    const { start, end } = getDateRange({ from: req.query.from, to: req.query.to, type: req.query.type || "monthly" });
    const data = await prisma.refund.findMany({
      where: { createdAt: { gte: start, lte: end }, ...(status && status !== "ALL" ? { status } : {}), ...(orderId ? { orderId } : {}) },
      include: {
        order: { include: { user: { select: { id: true, fullName: true, phone: true, email: true } }, restaurant: { select: { id: true, name: true } } } },
        paymentTransaction: true,
        processedByAdmin: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const summary = { count: data.length, pending: 0, processing: 0, completed: 0, failed: 0, totalRequested: 0, totalCompleted: 0 };
    for (const r of data) { summary.totalRequested += moneyNumber(r.amount); if (r.status === "PENDING") summary.pending++; else if (r.status === "PROCESSING") summary.processing++; else if (r.status === "COMPLETED") { summary.completed++; summary.totalCompleted += moneyNumber(r.amount); } else if (r.status === "FAILED") summary.failed++; }
    summary.totalRequested = roundMoney(summary.totalRequested); summary.totalCompleted = roundMoney(summary.totalCompleted);
    return res.json({ success: true, refunds: data, data, summary });
  } catch (error) { console.error("Get Refunds Error:", error); return res.status(500).json({ success: false, message: error.message }); }
};

export const createRefundByAdmin = async (req, res) => {
  try {
    const { orderId, paymentTransactionId, amount, reason } = req.body;
    if (!orderId || !amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: "orderId and positive amount are required" });
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { refunds: true } });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (!isPrepaidMethod(order.paymentMethod)) return res.status(400).json({ success: false, message: "COD orders do not use online refund workflow" });
    const alreadyCompleted = roundMoney((order.refunds || []).filter((r) => r.status === "COMPLETED").reduce((s, r) => s + moneyNumber(r.amount), 0));
    const refundable = roundMoney(Math.max(moneyNumber(order.totalAmount) - alreadyCompleted, 0));
    if (Number(amount) > refundable) return res.status(400).json({ success: false, message: `Refund exceeds refundable amount ${refundable}` });

    const refund = await prisma.refund.create({ data: { orderId, paymentTransactionId: paymentTransactionId || null, processedByAdminId: req.user?.id || null, amount: Number(amount), reason: cleanString(reason) || null, status: "PENDING" } });
    await auditAdminAction(req, { action: "REFUND_CREATED", entityType: "Refund", entityId: refund.id, newData: refund });
    return res.status(201).json({ success: true, message: "Refund request created. Process it through your payment gateway then mark completed.", refund, data: refund });
  } catch (error) { console.error("Create Refund Error:", error); return res.status(500).json({ success: false, message: error.message }); }
};

export const updateRefundStatusByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, providerRefundId, failureReason } = req.body;
    const allowed = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: "Invalid refund status" });
    const before = await prisma.refund.findUnique({ where: { id }, include: { order: true } });
    if (!before) return res.status(404).json({ success: false, message: "Refund not found" });

    const refund = await prisma.$transaction(async (tx) => {
      const updated = await tx.refund.update({
        where: { id },
        data: {
          status,
          processedByAdminId: req.user?.id || before.processedByAdminId,
          ...(providerRefundId !== undefined && { providerRefundId: providerRefundId || null }),
          ...(failureReason !== undefined && { failureReason: failureReason || null }),
          ...(status === "PROCESSING" && { processedAt: new Date() }),
          ...(status === "COMPLETED" && { processedAt: before.processedAt || new Date(), completedAt: new Date() }),
        },
      });

      if (status === "COMPLETED") {
        const completed = await tx.refund.findMany({ where: { orderId: before.orderId, status: "COMPLETED" } });
        const totalRefunded = roundMoney(completed.reduce((s, r) => s + moneyNumber(r.amount), 0));
        const orderTotal = roundMoney(before.order.totalAmount);
        await tx.order.update({ where: { id: before.orderId }, data: { refundAmount: totalRefunded, ...(totalRefunded >= orderTotal ? { paymentStatus: "REFUNDED" } : {}) } });
      }
      return updated;
    });
    await auditAdminAction(req, { action: "REFUND_STATUS_UPDATED", entityType: "Refund", entityId: id, oldData: { status: before.status }, newData: { status, providerRefundId: providerRefundId || null } });
    return res.json({ success: true, message: "Refund updated", refund, data: refund });
  } catch (error) { console.error("Update Refund Error:", error); return res.status(500).json({ success: false, message: error.message }); }
};

const invoiceInclude = {
  vendor: { select: { id: true, fullName: true, email: true, phone: true } },
  restaurant: { include: { city: true, payoutAccount: true } },
  items: { orderBy: { deliveredAt: "asc" }, include: { order: { select: { id: true, status: true, paymentStatus: true } } } },
};

export const generateVendorInvoice = async (req, res) => {
  try {
    const { restaurantId, periodStart, periodEnd, dueAt, note, adjustmentAmount = 0 } = req.body;
    if (!restaurantId || !periodStart) return res.status(400).json({ success: false, message: "restaurantId and periodStart are required" });
    const startInput = safeDate(periodStart);
    if (!startInput) return res.status(400).json({ success: false, message: "Invalid periodStart" });
    startInput.setHours(0, 0, 0, 0);
    let endInput = safeDate(periodEnd);
    if (!endInput) endInput = new Date(startInput.getFullYear(), startInput.getMonth() + 1, 0, 23, 59, 59, 999);
    const { start, end } = getDateRange({ from: startInput, to: endInput, type: "monthly" });
    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId }, include: { vendor: true } });
    if (!restaurant) return res.status(404).json({ success: false, message: "Vendor restaurant not found" });
    if (!restaurant.vendorId) return res.status(400).json({ success: false, message: "Restaurant is not linked to vendor user" });

    const existing = await prisma.vendorInvoice.findUnique({ where: { restaurantId_periodStart_periodEnd: { restaurantId, periodStart: start, periodEnd: end } }, include: invoiceInclude });
    if (existing) return res.status(409).json({ success: false, message: "Invoice already exists for this vendor and period", invoice: existing, data: existing });

    const orders = await prisma.order.findMany({
      where: { restaurantId, status: "DELIVERED", paymentStatus: "PAID", deliveredAt: { gte: start, lte: end } },
      include: { restaurant: true, refunds: true },
      orderBy: { deliveredAt: "asc" },
    });
    if (!orders.length) return res.status(400).json({ success: false, message: "No delivered + paid orders found for invoice period" });

    const invoice = await prisma.$transaction(async (tx) => {
      let gross = 0, commission = 0, vendorPayable = 0, tax = 0;
      const items = [];
      for (let order of orders) {
        const snap = await createOrderSnapshotIfMissing(tx, order);
        order = snap.order;
        const f = snap.finance;
        const completedRefund = roundMoney((order.refunds || []).filter((r) => r.status === "COMPLETED").reduce((s, r) => s + moneyNumber(r.amount), 0));
        gross += f.commissionableAmount; commission += f.platformCommission; vendorPayable += f.vendorPayable; tax += moneyNumber(order.taxAmount);
        items.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          deliveredAt: order.deliveredAt,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          grossAmount: f.totalAmount,
          commissionableAmount: f.commissionableAmount,
          commissionRate: f.commissionRate,
          commissionAmount: f.platformCommission,
          vendorPayable: f.vendorPayable,
          deliveryFee: moneyNumber(order.deliveryFee),
          taxAmount: moneyNumber(order.taxAmount),
          discountAmount: moneyNumber(order.discount),
          platformFee: moneyNumber(order.platformFee),
          refundAmount: completedRefund,
        });
        await ensureSettlementsForRecognizedOrder(tx, order);
      }
      const adj = roundMoney(adjustmentAmount);
      const invoiceNumber = `KARTO-${start.getFullYear()}${String(start.getMonth()+1).padStart(2,"0")}-${restaurantId.slice(0,6).toUpperCase()}-${Date.now().toString().slice(-6)}`;
      return tx.vendorInvoice.create({
        data: {
          invoiceNumber,
          vendorId: restaurant.vendorId,
          restaurantId,
          periodStart: start,
          periodEnd: end,
          totalOrders: items.length,
          grossAmount: roundMoney(gross),
          commissionAmount: roundMoney(commission),
          taxAmount: roundMoney(tax),
          adjustmentAmount: adj,
          netPayable: roundMoney(vendorPayable + adj),
          status: "GENERATED",
          dueAt: safeDate(dueAt),
          note: cleanString(note) || null,
          items: { create: items },
        },
        include: invoiceInclude,
      });
    });
    await auditAdminAction(req, { action: "VENDOR_INVOICE_GENERATED", entityType: "VendorInvoice", entityId: invoice.id, newData: { invoiceNumber: invoice.invoiceNumber, restaurantId, periodStart: start, periodEnd: end, netPayable: invoice.netPayable } });
    return res.status(201).json({ success: true, message: "Vendor invoice generated", invoice, data: invoice });
  } catch (error) { console.error("Generate Vendor Invoice Error:", error); return res.status(500).json({ success: false, message: error.message }); }
};

export const getVendorInvoices = async (req, res) => {
  try {
    const { restaurantId, vendorId, status } = req.query;
    const data = await prisma.vendorInvoice.findMany({ where: { ...(restaurantId ? { restaurantId } : {}), ...(vendorId ? { vendorId } : {}), ...(status && status !== "ALL" ? { status } : {}) }, include: invoiceInclude, orderBy: { generatedAt: "desc" } });
    return res.json({ success: true, invoices: data, data });
  } catch (error) { console.error("Get Vendor Invoices Error:", error); return res.status(500).json({ success: false, message: error.message }); }
};

export const getVendorInvoiceById = async (req, res) => {
  try {
    const data = await prisma.vendorInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude });
    if (!data) return res.status(404).json({ success: false, message: "Invoice not found" });
    return res.json({ success: true, invoice: data, data });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const updateVendorInvoiceStatus = async (req, res) => {
  try {
    const { status, transactionRef, note } = req.body;
    const allowed = ["DRAFT", "GENERATED", "APPROVED", "PROCESSING", "PAID", "CANCELLED"];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: "Invalid invoice status" });
    const before = await prisma.vendorInvoice.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ success: false, message: "Invoice not found" });
    const data = await prisma.$transaction(async (tx) => {
      const invoice = await tx.vendorInvoice.update({ where: { id: req.params.id }, data: { status, ...(note !== undefined && { note: note || null }), ...(status === "PAID" && { paidAt: new Date() }) }, include: invoiceInclude });
      if (status === "PAID") {
        const orderIds = invoice.items.map((i) => i.orderId);
        await tx.vendorSettlement.updateMany({ where: { orderId: { in: orderIds }, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "PAID", paidAt: new Date(), processedAt: new Date(), ...(transactionRef ? { transactionRef } : {}) } });
      }
      return invoice;
    });
    await auditAdminAction(req, { action: "VENDOR_INVOICE_STATUS_UPDATED", entityType: "VendorInvoice", entityId: req.params.id, oldData: { status: before.status }, newData: { status, transactionRef: transactionRef || null } });
    return res.json({ success: true, message: "Invoice status updated", invoice: data, data });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const downloadVendorInvoicePdf = async (req, res) => {
  try {
    const invoice = await prisma.vendorInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude });
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    const doc = setupPdfResponse(res, `${invoice.invoiceNumber}.pdf`, `Vendor Invoice ${invoice.invoiceNumber}`);
    pdfKeyValue(doc, "Vendor", invoice.restaurant?.name || invoice.vendor?.fullName || "-");
    pdfKeyValue(doc, "Invoice No", invoice.invoiceNumber);
    pdfKeyValue(doc, "Period", `${new Date(invoice.periodStart).toLocaleDateString("en-IN")} - ${new Date(invoice.periodEnd).toLocaleDateString("en-IN")}`);
    pdfKeyValue(doc, "Status", invoice.status);
    pdfKeyValue(doc, "Total Orders", invoice.totalOrders);
    pdfKeyValue(doc, "Commission", formatPdfMoney(invoice.commissionAmount));
    pdfKeyValue(doc, "Adjustment", formatPdfMoney(invoice.adjustmentAmount));
    pdfKeyValue(doc, "Net Payable", formatPdfMoney(invoice.netPayable));
    doc.moveDown(); doc.fontSize(10).font("Helvetica-Bold").text("Order Breakdown"); doc.moveDown(0.3);
    for (const item of invoice.items) {
      if (doc.y > 730) doc.addPage();
      doc.fontSize(8).font("Helvetica-Bold").text(`#${item.orderNumber}  ${item.deliveredAt ? new Date(item.deliveredAt).toLocaleDateString("en-IN") : ""}`);
      doc.font("Helvetica").text(`Payment: ${item.paymentMethod}/${item.paymentStatus} | Gross: ${formatPdfMoney(item.grossAmount)} | Base: ${formatPdfMoney(item.commissionableAmount)} | Rate: ${moneyNumber(item.commissionRate)}% | Karto: ${formatPdfMoney(item.commissionAmount)} | Vendor: ${formatPdfMoney(item.vendorPayable)}`);
      doc.moveDown(0.35);
    }
    doc.end();
  } catch (error) { console.error("Invoice PDF Error:", error); if (!res.headersSent) return res.status(500).json({ success: false, message: error.message }); }
};

export const downloadVendorInvoiceCsv = async (req, res) => {
  try {
    const invoice = await prisma.vendorInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude });
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    const rows = [["Invoice","Order","Delivered At","Payment Method","Payment Status","Gross","Commission Base","Commission Rate","Karto Commission","Vendor Payable","Delivery Fee","Tax","Discount","Platform Fee","Refund"]];
    invoice.items.forEach((i) => rows.push([invoice.invoiceNumber,i.orderNumber,i.deliveredAt?.toISOString()||"",i.paymentMethod,i.paymentStatus,i.grossAmount,i.commissionableAmount,i.commissionRate,i.commissionAmount,i.vendorPayable,i.deliveryFee,i.taxAmount,i.discountAmount,i.platformFee,i.refundAmount]));
    return sendCsv(res, `${invoice.invoiceNumber}.csv`, rows);
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const getVendorSettlements = async (req, res) => {
  try {
    const { restaurantId, vendorId, status } = req.query;
    const data = await prisma.vendorSettlement.findMany({
      where: { ...(restaurantId ? { restaurantId } : {}), ...(vendorId ? { vendorId } : {}), ...(status && status !== "ALL" ? { status } : {}) },
      include: { vendor: { select: { id: true, fullName: true, email: true, phone: true } }, restaurant: { select: { id: true, name: true } }, order: { select: { id: true, orderNumber: true, deliveredAt: true, paymentMethod: true, paymentStatus: true } } },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ success: true, settlements: data, data });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const updateVendorSettlementStatus = async (req, res) => {
  try {
    const { status, transactionRef, failureReason, note } = req.body;
    const allowed = ["PENDING", "PROCESSING", "PAID", "FAILED", "CANCELLED"];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: "Invalid settlement status" });
    const before = await prisma.vendorSettlement.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ success: false, message: "Settlement not found" });
    const data = await prisma.vendorSettlement.update({ where: { id: req.params.id }, data: { status, ...(transactionRef !== undefined && { transactionRef: transactionRef || null }), ...(failureReason !== undefined && { failureReason: failureReason || null }), ...(note !== undefined && { note: note || null }), ...(status === "PROCESSING" && { processedAt: new Date() }), ...(status === "PAID" && { processedAt: before.processedAt || new Date(), paidAt: new Date() }) } });
    await auditAdminAction(req, { action: "VENDOR_SETTLEMENT_UPDATED", entityType: "VendorSettlement", entityId: data.id, oldData: { status: before.status }, newData: { status, transactionRef: transactionRef || null } });
    return res.json({ success: true, settlement: data, data });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const getRiderSettlements = async (req, res) => {
  try {
    const { riderId, status } = req.query;
    const data = await prisma.riderSettlement.findMany({ where: { ...(riderId ? { riderId } : {}), ...(status && status !== "ALL" ? { status } : {}) }, include: { rider: { select: { id: true, fullName: true, phone: true, email: true } }, order: { select: { id: true, orderNumber: true, deliveredAt: true, deliveryFee: true } } }, orderBy: { createdAt: "desc" } });
    return res.json({ success: true, settlements: data, data });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const updateRiderSettlementStatus = async (req, res) => {
  try {
    const { status, transactionRef, failureReason, note } = req.body;
    const allowed = ["PENDING", "PROCESSING", "PAID", "FAILED", "CANCELLED"];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: "Invalid settlement status" });
    const before = await prisma.riderSettlement.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ success: false, message: "Settlement not found" });
    const data = await prisma.riderSettlement.update({ where: { id: req.params.id }, data: { status, ...(transactionRef !== undefined && { transactionRef: transactionRef || null }), ...(failureReason !== undefined && { failureReason: failureReason || null }), ...(note !== undefined && { note: note || null }), ...(status === "PROCESSING" && { processedAt: new Date() }), ...(status === "PAID" && { processedAt: before.processedAt || new Date(), paidAt: new Date() }) } });
    await auditAdminAction(req, { action: "RIDER_SETTLEMENT_UPDATED", entityType: "RiderSettlement", entityId: data.id, oldData: { status: before.status }, newData: { status, transactionRef: transactionRef || null } });
    return res.json({ success: true, settlement: data, data });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const downloadMonthlyBillingCsv = async (req, res) => {
  try {
    const { start, end } = getDateRange({ from: req.query.from, to: req.query.to, type: req.query.type || "monthly" });
    const orders = await prisma.order.findMany({ where: { status: "DELIVERED", paymentStatus: "PAID", deliveredAt: { gte: start, lte: end } }, include: { restaurant: true, rider: true }, orderBy: { deliveredAt: "asc" } });
    const rows = [["Order","Delivered At","Vendor","Rider","Method","Order Total","Commission Base","Commission Rate","Karto Commission","Vendor Payable","Rider Fee","Tax","Platform Fee","Discount"]];
    orders.forEach((o) => { const f=getOrderFinancials(o); rows.push([o.orderNumber,o.deliveredAt?.toISOString()||"",o.restaurant?.name||"",o.rider?.fullName||"",o.paymentMethod,f.totalAmount,f.commissionableAmount,f.commissionRate,f.platformCommission,f.vendorPayable,o.deliveryFee,o.taxAmount,o.platformFee,o.discount]); });
    return sendCsv(res, `karto-billing-${start.toISOString().slice(0,10)}-${end.toISOString().slice(0,10)}.csv`, rows);
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
};

export const downloadMonthlyBillingPdf = async (req, res) => {
  try {
    const { start, end } = getDateRange({ from: req.query.from, to: req.query.to, type: req.query.type || "monthly" });
    const orders = await prisma.order.findMany({ where: { status: "DELIVERED", paymentStatus: "PAID", deliveredAt: { gte: start, lte: end } }, include: { restaurant: true, rider: true }, orderBy: { deliveredAt: "asc" } });
    const income = calcIncome(orders);
    const riderPayable = roundMoney(orders.reduce((s,o)=>s+moneyNumber(o.deliveryFee),0));
    const doc = setupPdfResponse(res, `karto-billing-${start.toISOString().slice(0,10)}-${end.toISOString().slice(0,10)}.pdf`, "Platform Billing Report");
    pdfKeyValue(doc,"Period",`${start.toLocaleDateString("en-IN")} - ${end.toLocaleDateString("en-IN")}`);
    pdfKeyValue(doc,"Delivered + Paid Orders",orders.length);
    pdfKeyValue(doc,"Recognized Revenue",formatPdfMoney(income.totalRevenue));
    pdfKeyValue(doc,"Karto Commission",formatPdfMoney(income.kartoIncome));
    pdfKeyValue(doc,"Vendor Payable",formatPdfMoney(income.vendorIncome));
    pdfKeyValue(doc,"Rider Payable",formatPdfMoney(riderPayable));
    pdfKeyValue(doc,"Net Platform After Rider",formatPdfMoney(income.kartoIncome-riderPayable));
    doc.moveDown(); doc.fontSize(10).font("Helvetica-Bold").text("Orders");
    for (const o of orders) { if(doc.y>730) doc.addPage(); const f=getOrderFinancials(o); doc.fontSize(8).font("Helvetica-Bold").text(`#${o.orderNumber} - ${o.restaurant?.name||"Vendor"}`); doc.font("Helvetica").text(`${o.paymentMethod} | Total ${formatPdfMoney(f.totalAmount)} | Base ${formatPdfMoney(f.commissionableAmount)} | ${f.commissionRate}% | Karto ${formatPdfMoney(f.platformCommission)} | Vendor ${formatPdfMoney(f.vendorPayable)} | Rider ${formatPdfMoney(o.deliveryFee)}`); doc.moveDown(.25); }
    doc.end();
  } catch (error) { console.error("Billing PDF Error:",error); if(!res.headersSent) return res.status(500).json({success:false,message:error.message}); }
};

export const downloadRiderBillingPdf = async (req, res) => {
  try {
    const { start, end } = getDateRange({ from: req.query.from, to: req.query.to, type: req.query.type || "monthly" });
    const rider = await prisma.user.findFirst({ where: { id: req.params.id, role: "RIDER" } });
    if(!rider) return res.status(404).json({success:false,message:"Rider not found"});
    const orders=await prisma.order.findMany({where:{riderId:rider.id,status:"DELIVERED",paymentStatus:"PAID",deliveredAt:{gte:start,lte:end}},include:{restaurant:true},orderBy:{deliveredAt:"asc"}});
    const total=roundMoney(orders.reduce((s,o)=>s+moneyNumber(o.deliveryFee),0));
    const doc=setupPdfResponse(res,`rider-${rider.id}-${start.toISOString().slice(0,10)}.pdf`,"Rider Earnings Statement");
    pdfKeyValue(doc,"Rider",rider.fullName||rider.phone||rider.id); pdfKeyValue(doc,"Period",`${start.toLocaleDateString("en-IN")} - ${end.toLocaleDateString("en-IN")}`); pdfKeyValue(doc,"Deliveries",orders.length); pdfKeyValue(doc,"Payable",formatPdfMoney(total)); doc.moveDown();
    orders.forEach(o=>{ if(doc.y>730)doc.addPage(); doc.fontSize(8).text(`#${o.orderNumber} | ${o.restaurant?.name||"Vendor"} | ${o.deliveredAt?new Date(o.deliveredAt).toLocaleString("en-IN"):""} | ${formatPdfMoney(o.deliveryFee)}`); }); doc.end();
  } catch(error){if(!res.headersSent)return res.status(500).json({success:false,message:error.message});}
};

export const downloadRiderBillingCsv = async (req, res) => {
  try { const {start,end}=getDateRange({from:req.query.from,to:req.query.to,type:req.query.type||"monthly"}); const rider=await prisma.user.findFirst({where:{id:req.params.id,role:"RIDER"}}); if(!rider)return res.status(404).json({success:false,message:"Rider not found"}); const orders=await prisma.order.findMany({where:{riderId:rider.id,status:"DELIVERED",paymentStatus:"PAID",deliveredAt:{gte:start,lte:end}},include:{restaurant:true},orderBy:{deliveredAt:"asc"}}); const rows=[["Rider","Order","Vendor","Delivered At","Delivery Fee"]]; orders.forEach(o=>rows.push([rider.fullName||rider.id,o.orderNumber,o.restaurant?.name||"",o.deliveredAt?.toISOString()||"",o.deliveryFee])); return sendCsv(res,`rider-${rider.id}-billing.csv`,rows); } catch(error){return res.status(500).json({success:false,message:error.message});}
};

export const downloadOrdersCsv = async (req, res) => {
  try {
    const { status, cityId, vendorId, paymentMethod, paymentStatus } = req.query;
    const orders=await prisma.order.findMany({where:{...(status&&status!=="ALL"?{status}:{}),...(vendorId&&vendorId!=="ALL"?{restaurantId:vendorId}:{}),...(cityId&&cityId!=="ALL"?{restaurant:{cityId}}:{}),...(paymentMethod&&paymentMethod!=="ALL"?{paymentMethod}:{}),...(paymentStatus&&paymentStatus!=="ALL"?{paymentStatus}:{})},include:{user:true,restaurant:true,rider:true},orderBy:{createdAt:"desc"}});
    const rows=[["Order","Created","Customer","Vendor","Rider","Status","Payment Method","Payment Status","Total","Delivery Fee","Tax","Platform Fee","Discount"]]; orders.forEach(o=>rows.push([o.orderNumber,o.createdAt.toISOString(),o.user?.fullName||"",o.restaurant?.name||"",o.rider?.fullName||"",o.status,o.paymentMethod,o.paymentStatus,o.totalAmount,o.deliveryFee,o.taxAmount,o.platformFee,o.discount])); return sendCsv(res,"karto-orders.csv",rows);
  } catch(error){return res.status(500).json({success:false,message:error.message});}
};

/* =========================================================
   PRODUCTION ADMIN: KYC / VERIFICATION
========================================================= */

export const getVendorDocumentsByAdmin = async (req,res)=>{try{const data=await prisma.vendorDocument.findMany({where:{...(req.query.restaurantId?{restaurantId:req.query.restaurantId}:{}),...(req.query.status&&req.query.status!=="ALL"?{status:req.query.status}:{})},include:{restaurant:{include:{vendor:true}},reviewedBy:{select:{id:true,fullName:true,email:true}}},orderBy:{createdAt:"desc"}});return res.json({success:true,documents:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const reviewVendorDocumentByAdmin = async (req,res)=>{try{const {status,rejectionReason}=req.body;const allowed=["PENDING","UNDER_REVIEW","APPROVED","REJECTED","EXPIRED"];if(!allowed.includes(status))return res.status(400).json({success:false,message:"Invalid document status"});const before=await prisma.vendorDocument.findUnique({where:{id:req.params.id}});if(!before)return res.status(404).json({success:false,message:"Document not found"});const data=await prisma.vendorDocument.update({where:{id:req.params.id},data:{status,rejectionReason:status==="REJECTED"?(cleanString(rejectionReason)||"Rejected by admin"):null,reviewedById:req.user?.id||null,reviewedAt:new Date()}});await auditAdminAction(req,{action:"VENDOR_DOCUMENT_REVIEWED",entityType:"VendorDocument",entityId:data.id,oldData:{status:before.status},newData:{status}});return res.json({success:true,document:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const updateVendorVerificationByAdmin = async (req,res)=>{try{const {status,note}=req.body;const allowed=["PENDING","UNDER_REVIEW","APPROVED","REJECTED","SUSPENDED"];if(!allowed.includes(status))return res.status(400).json({success:false,message:"Invalid verification status"});const before=await prisma.restaurant.findUnique({where:{id:req.params.id}});if(!before)return res.status(404).json({success:false,message:"Vendor not found"});const data=await prisma.restaurant.update({where:{id:req.params.id},data:{verificationStatus:status,isVerified:status==="APPROVED",verificationNote:cleanString(note)||null,...(status==="APPROVED"?{verifiedAt:new Date(),suspendedAt:null,suspensionReason:null}:{}),...(status==="SUSPENDED"?{suspendedAt:new Date(),suspensionReason:cleanString(note)||"Suspended by admin",isOpen:false,isAcceptingOrders:false}:{})}});await auditAdminAction(req,{action:"VENDOR_VERIFICATION_UPDATED",entityType:"Restaurant",entityId:data.id,oldData:{verificationStatus:before.verificationStatus},newData:{verificationStatus:status}});return res.json({success:true,vendor:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const getRiderDocumentsByAdmin = async (req,res)=>{try{const data=await prisma.riderDocument.findMany({where:{...(req.query.riderId?{riderId:req.query.riderId}:{}),...(req.query.status&&req.query.status!=="ALL"?{status:req.query.status}:{})},include:{rider:{select:{id:true,fullName:true,email:true,phone:true,kycStatus:true}},reviewedBy:{select:{id:true,fullName:true,email:true}}},orderBy:{createdAt:"desc"}});return res.json({success:true,documents:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const reviewRiderDocumentByAdmin = async (req,res)=>{try{const {status,rejectionReason}=req.body;const allowed=["PENDING","UNDER_REVIEW","APPROVED","REJECTED","EXPIRED"];if(!allowed.includes(status))return res.status(400).json({success:false,message:"Invalid document status"});const before=await prisma.riderDocument.findUnique({where:{id:req.params.id}});if(!before)return res.status(404).json({success:false,message:"Document not found"});const data=await prisma.riderDocument.update({where:{id:req.params.id},data:{status,rejectionReason:status==="REJECTED"?(cleanString(rejectionReason)||"Rejected by admin"):null,reviewedById:req.user?.id||null,reviewedAt:new Date()}});await auditAdminAction(req,{action:"RIDER_DOCUMENT_REVIEWED",entityType:"RiderDocument",entityId:data.id,oldData:{status:before.status},newData:{status}});return res.json({success:true,document:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const updateRiderKycByAdmin = async (req,res)=>{try{const {status,rejectionReason}=req.body;const normalized=String(status||"").toUpperCase();if(!["PENDING","UNDER_REVIEW","APPROVED","REJECTED"].includes(normalized))return res.status(400).json({success:false,message:"Invalid KYC status"});const before=await prisma.user.findFirst({where:{id:req.params.id,role:"RIDER"}});if(!before)return res.status(404).json({success:false,message:"Rider not found"});const data=await prisma.user.update({where:{id:req.params.id},data:{kycStatus:normalized,kycReviewedAt:new Date(),kycRejectionReason:normalized==="REJECTED"?(cleanString(rejectionReason)||"Rejected by admin"):null}});await auditAdminAction(req,{action:"RIDER_KYC_UPDATED",entityType:"User",entityId:data.id,oldData:{kycStatus:before.kycStatus},newData:{kycStatus:normalized}});return res.json({success:true,rider:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

/* =========================================================
   PRODUCTION ADMIN: SUPPORT, SETTINGS, BANNERS, AUDIT
========================================================= */

export const getAdminSupportTickets = async (req,res)=>{try{const {status,priority,assignedAdminId}=req.query;const data=await prisma.supportTicket.findMany({where:{...(status&&status!=="ALL"?{status}:{}),...(priority&&priority!=="ALL"?{priority}:{}),...(assignedAdminId?{assignedAdminId}:{})},include:{user:{select:{id:true,fullName:true,email:true,phone:true}},assignedAdmin:{select:{id:true,fullName:true,email:true}},order:{select:{id:true,orderNumber:true,status:true,paymentStatus:true}},_count:{select:{messages:true}}},orderBy:[{priority:"desc"},{updatedAt:"desc"}]});return res.json({success:true,tickets:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const getAdminSupportTicketById = async (req,res)=>{try{const data=await prisma.supportTicket.findUnique({where:{id:req.params.id},include:{user:true,assignedAdmin:true,order:{include:{restaurant:true,rider:true}},messages:{include:{sender:{select:{id:true,fullName:true,role:true,avatarUrl:true}}},orderBy:{createdAt:"asc"}}}});if(!data)return res.status(404).json({success:false,message:"Ticket not found"});return res.json({success:true,ticket:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const updateSupportTicketByAdmin = async (req,res)=>{try{const {status,priority,assignedAdminId,tags}=req.body;const before=await prisma.supportTicket.findUnique({where:{id:req.params.id}});if(!before)return res.status(404).json({success:false,message:"Ticket not found"});const data=await prisma.supportTicket.update({where:{id:req.params.id},data:{...(status&&{status}),...(priority&&{priority}),...(assignedAdminId!==undefined&&{assignedAdminId:assignedAdminId||null}),...(tags!==undefined&&{tags}),...(status==="RESOLVED"&&{resolvedAt:new Date()}),...(status==="CLOSED"&&{closedAt:new Date()})}});await auditAdminAction(req,{action:"SUPPORT_TICKET_UPDATED",entityType:"SupportTicket",entityId:data.id,oldData:{status:before.status,priority:before.priority},newData:{status:data.status,priority:data.priority}});return res.json({success:true,ticket:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const replySupportTicketByAdmin = async (req,res)=>{try{const {message,imageUrl}=req.body;if(!message?.trim())return res.status(400).json({success:false,message:"message is required"});const ticket=await prisma.supportTicket.findUnique({where:{id:req.params.id}});if(!ticket)return res.status(404).json({success:false,message:"Ticket not found"});const finalImage=(await fileUrl(req,"support"))||imageUrl||null;const data=await prisma.$transaction(async tx=>{const msg=await tx.supportMessage.create({data:{ticketId:req.params.id,senderId:req.user.id,message:message.trim(),imageUrl:finalImage}});await tx.supportTicket.update({where:{id:req.params.id},data:{assignedAdminId:ticket.assignedAdminId||req.user.id,lastReplyAt:new Date(),...(ticket.status==="OPEN"?{status:"IN_PROGRESS"}:{})}});return msg;});return res.status(201).json({success:true,message:"Reply sent",supportMessage:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const getSystemSettingsByAdmin = async (req,res)=>{try{const data=await prisma.systemSetting.findMany({orderBy:{key:"asc"}});return res.json({success:true,settings:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const upsertSystemSettingByAdmin = async (req,res)=>{try{const {key,value,description,isPublic}=req.body;if(!key?.trim())return res.status(400).json({success:false,message:"key is required"});const before=await prisma.systemSetting.findUnique({where:{key:key.trim()}});const data=await prisma.systemSetting.upsert({where:{key:key.trim()},update:{value,description:description??undefined,isPublic:isPublic===undefined?undefined:boolValue(isPublic)},create:{key:key.trim(),value,description:description||null,isPublic:boolValue(isPublic)}});await auditAdminAction(req,{action:"SYSTEM_SETTING_UPSERTED",entityType:"SystemSetting",entityId:data.id,oldData:before,newData:data});return res.json({success:true,setting:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const getBannersByAdmin = async (req,res)=>{try{const data=await prisma.banner.findMany({orderBy:[{sortOrder:"asc"},{createdAt:"desc"}]});return res.json({success:true,banners:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const createBannerByAdmin = async (req,res)=>{try{const {title,subtitle,imageUrl,deepLink,placement="HOME",sortOrder=0,isActive=true,startsAt,endsAt}=req.body;if(!title?.trim())return res.status(400).json({success:false,message:"title is required"});const finalImage=(await fileUrl(req,"banners"))||imageUrl;if(!finalImage)return res.status(400).json({success:false,message:"banner image is required"});const data=await prisma.banner.create({data:{title:title.trim(),subtitle:cleanString(subtitle)||null,imageUrl:finalImage,deepLink:cleanString(deepLink)||null,placement,sortOrder:Number(sortOrder||0),isActive:boolValue(isActive,true),startsAt:safeDate(startsAt),endsAt:safeDate(endsAt)}});return res.status(201).json({success:true,banner:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const updateBannerByAdmin = async (req,res)=>{try{const {title,subtitle,imageUrl,deepLink,placement,sortOrder,isActive,startsAt,endsAt}=req.body;const finalImage=await fileUrl(req,"banners");const data=await prisma.banner.update({where:{id:req.params.id},data:{...(title!==undefined&&{title:title.trim()}),...(subtitle!==undefined&&{subtitle:cleanString(subtitle)||null}),...(finalImage&&{imageUrl:finalImage}),...(!finalImage&&imageUrl!==undefined&&{imageUrl:imageUrl||null}),...(deepLink!==undefined&&{deepLink:cleanString(deepLink)||null}),...(placement!==undefined&&{placement}),...(sortOrder!==undefined&&{sortOrder:Number(sortOrder||0)}),...(isActive!==undefined&&{isActive:boolValue(isActive)}),...(startsAt!==undefined&&{startsAt:safeDate(startsAt)}),...(endsAt!==undefined&&{endsAt:safeDate(endsAt)})}});return res.json({success:true,banner:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const deleteBannerByAdmin = async (req,res)=>{try{await prisma.banner.delete({where:{id:req.params.id}});return res.json({success:true,message:"Banner deleted"});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const getAdminAuditLogs = async (req,res)=>{try{const {adminId,action,entityType,entityId}=req.query;const {start,end}=getDateRange({from:req.query.from,to:req.query.to,type:req.query.type||"monthly"});const data=await prisma.adminAuditLog.findMany({where:{createdAt:{gte:start,lte:end},...(adminId?{adminId}:{}),...(action?{action:{contains:String(action),mode:"insensitive"}}:{}),...(entityType?{entityType}:{}),...(entityId?{entityId}:{})},include:{admin:{select:{id:true,fullName:true,email:true}}},orderBy:{createdAt:"desc"},take:500});return res.json({success:true,logs:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const getAdminPermissions = async (req,res)=>{try{const userId=req.params.id;let profile=await prisma.adminProfile.findUnique({where:{userId},include:{permissions:true,user:{select:{id:true,fullName:true,email:true,role:true}}}});if(!profile)return res.status(404).json({success:false,message:"Admin profile not found"});return res.json({success:true,profile,data:profile});}catch(error){return res.status(500).json({success:false,message:error.message});}};

export const setAdminPermissions = async (req,res)=>{try{const userId=req.params.id;const {permissions=[],isSuperAdmin=false,designation}=req.body;const admin=await prisma.user.findFirst({where:{id:userId,role:"ADMIN"}});if(!admin)return res.status(404).json({success:false,message:"Admin user not found"});const allowed=["DASHBOARD_VIEW","USER_VIEW","USER_MANAGE","VENDOR_VIEW","VENDOR_MANAGE","RIDER_VIEW","RIDER_MANAGE","ORDER_VIEW","ORDER_MANAGE","BILLING_VIEW","SETTLEMENT_MANAGE","REFUND_MANAGE","COUPON_MANAGE","CATEGORY_MANAGE","NOTIFICATION_MANAGE","SUPPORT_MANAGE","SERVICE_AREA_MANAGE","REPORT_VIEW","AUDIT_VIEW","SETTINGS_MANAGE","ADMIN_MANAGE"];const unique=[...new Set(Array.isArray(permissions)?permissions:[])].filter(p=>allowed.includes(p));const profile=await prisma.$transaction(async tx=>{const p=await tx.adminProfile.upsert({where:{userId},update:{isSuperAdmin:boolValue(isSuperAdmin),...(designation!==undefined&&{designation:cleanString(designation)||null})},create:{userId,isSuperAdmin:boolValue(isSuperAdmin),designation:cleanString(designation)||null}});await tx.adminPermissionGrant.deleteMany({where:{adminProfileId:p.id}});if(unique.length)await tx.adminPermissionGrant.createMany({data:unique.map(permission=>({adminProfileId:p.id,permission}))});return tx.adminProfile.findUnique({where:{id:p.id},include:{permissions:true,user:{select:{id:true,fullName:true,email:true}}}});});await auditAdminAction(req,{action:"ADMIN_PERMISSIONS_UPDATED",entityType:"AdminProfile",entityId:profile.id,newData:{isSuperAdmin:profile.isSuperAdmin,permissions:unique}});return res.json({success:true,profile,data:profile});}catch(error){return res.status(500).json({success:false,message:error.message});}};

/* =========================================================
   PRODUCTION ADMIN: SERVICE AREAS
========================================================= */
export const getServiceAreasByAdmin = async (req,res)=>{try{const data=await prisma.serviceArea.findMany({where:{...(req.query.isActive!==undefined?{isActive:boolValue(req.query.isActive)}:{})},orderBy:[{city:"asc"},{createdAt:"desc"}]});return res.json({success:true,serviceAreas:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const createServiceAreaByAdmin = async (req,res)=>{try{const {city,state,country="India",pinCode,latitude,longitude,radiusKm,isActive=true}=req.body;if(!city||latitude===undefined||longitude===undefined||radiusKm===undefined)return res.status(400).json({success:false,message:"city, latitude, longitude and radiusKm are required"});const data=await prisma.serviceArea.create({data:{city:city.trim(),state:cleanString(state)||null,country:country||"India",pinCode:cleanString(pinCode)||null,latitude:Number(latitude),longitude:Number(longitude),radiusKm:Number(radiusKm),isActive:boolValue(isActive,true)}});return res.status(201).json({success:true,serviceArea:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const updateServiceAreaByAdmin = async (req,res)=>{try{const {city,state,country,pinCode,latitude,longitude,radiusKm,isActive}=req.body;const data=await prisma.serviceArea.update({where:{id:req.params.id},data:{...(city!==undefined&&{city:city.trim()}),...(state!==undefined&&{state:cleanString(state)||null}),...(country!==undefined&&{country}),...(pinCode!==undefined&&{pinCode:cleanString(pinCode)||null}),...(latitude!==undefined&&{latitude:Number(latitude)}),...(longitude!==undefined&&{longitude:Number(longitude)}),...(radiusKm!==undefined&&{radiusKm:Number(radiusKm)}),...(isActive!==undefined&&{isActive:boolValue(isActive)})}});return res.json({success:true,serviceArea:data,data});}catch(error){return res.status(500).json({success:false,message:error.message});}};
export const deleteServiceAreaByAdmin = async (req,res)=>{try{await prisma.serviceArea.delete({where:{id:req.params.id}});return res.json({success:true,message:"Service area deleted"});}catch(error){return res.status(500).json({success:false,message:error.message});}};
