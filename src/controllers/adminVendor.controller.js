import bcrypt from "bcryptjs";
import PDFDocument from "pdfkit";
import prisma from "../prisma.js";
import { getIO } from "../socket.js";
import { uploadToCloudinary } from "../utils/cloudinaryUpload.js";

const boolValue = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  const normalized = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on", "open", "active"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off", "closed", "inactive"].includes(normalized)) {
    return false;
  }

  return fallback;
};

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const trimValue = (value) => String(value || "").trim();


const moneyNumber = (value) => Number(value || 0);

const roundMoney = (value) =>
  Math.round((moneyNumber(value) + Number.EPSILON) * 100) / 100;

const cleanOptional = (value) =>
  value === undefined || value === null ? undefined : String(value).trim();

const safeInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const pageParams = (req, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(1, safeInt(req.query?.page, 1));
  const limit = clamp(safeInt(req.query?.limit, defaultLimit), 1, maxLimit);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

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

    if (type === "daily") {
      start.setHours(0, 0, 0, 0);
    } else if (type === "weekly") {
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

  if (!end) {
    end = new Date(now);
  }

  end.setHours(23, 59, 59, 999);

  if (start > end) {
    const temp = start;
    start = end;
    end = temp;
  }

  return { start, end };
};

const validLatitude = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= -90 && number <= 90;
};

const validLongitude = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= -180 && number <= 180;
};

const uploadFile = async (req, folder) => {
  if (!req.file) return undefined;
  return uploadToCloudinary(req.file, folder);
};

const isRecognizedOrder = (order) =>
  order?.status === "DELIVERED" &&
  order?.paymentStatus === "PAID";

const isPrepaidMethod = (method) =>
  ["ONLINE", "UPI", "CARD", "WALLET"].includes(
    String(method || "").toUpperCase()
  );

const getCommissionableAmount = (order) => {
  if (
    order?.commissionableAmount !== null &&
    order?.commissionableAmount !== undefined
  ) {
    return roundMoney(order.commissionableAmount);
  }

  const itemTotal = moneyNumber(order?.itemTotal);
  const discount = moneyNumber(order?.discount);

  if (itemTotal > 0) {
    return roundMoney(Math.max(itemTotal - discount, 0));
  }

  const total = moneyNumber(order?.totalAmount);
  const deliveryFee = moneyNumber(order?.deliveryFee);
  const platformFee = moneyNumber(order?.platformFee);
  const taxAmount = moneyNumber(order?.taxAmount);

  return roundMoney(
    Math.max(total - deliveryFee - platformFee - taxAmount, 0)
  );
};

const getOrderFinancials = (order) => {
  const totalAmount = roundMoney(order?.totalAmount);
  const commissionableAmount = getCommissionableAmount(order);

  const commissionRate = roundMoney(
    order?.commissionRate ??
      order?.restaurant?.commission ??
      0
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
      : Math.max(
          commissionableAmount - platformCommission,
          0
        )
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

const cleanOrder = (order) => {
  if (!order) return null;

  return {
    ...order,
    totalAmount: roundMoney(order.totalAmount),
    itemTotal: roundMoney(order.itemTotal),
    deliveryFee: roundMoney(order.deliveryFee),
    discount: roundMoney(order.discount),
    taxAmount: roundMoney(order.taxAmount),
    cgstAmount: roundMoney(order.cgstAmount),
    sgstAmount: roundMoney(order.sgstAmount),
    platformFee: roundMoney(order.platformFee),
    refundAmount: roundMoney(order.refundAmount),
    commissionableAmount:
      order.commissionableAmount === null ||
      order.commissionableAmount === undefined
        ? null
        : roundMoney(order.commissionableAmount),
    commissionRate:
      order.commissionRate === null ||
      order.commissionRate === undefined
        ? null
        : roundMoney(order.commissionRate),
    platformCommissionAmount:
      order.platformCommissionAmount === null ||
      order.platformCommissionAmount === undefined
        ? null
        : roundMoney(order.platformCommissionAmount),
    vendorSettlementAmount:
      order.vendorSettlementAmount === null ||
      order.vendorSettlementAmount === undefined
        ? null
        : roundMoney(order.vendorSettlementAmount),
  };
};

const vendorOrderInclude = {
  user: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      avatarUrl: true,
    },
  },
  rider: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      avatarUrl: true,
      vehicleNo: true,
      vehicleType: true,
    },
  },
  address: true,
  items: true,
  history: {
    orderBy: { createdAt: "desc" },
  },
  refunds: {
    orderBy: { createdAt: "desc" },
  },
  paymentTransactions: {
    orderBy: { createdAt: "desc" },
  },
};

const resolveVendorAccess = async (userId) => {
  const ownedRestaurant = await prisma.restaurant.findFirst({
    where: {
      vendorId: userId,
      deletedAt: null,
    },
    include: {
      city: true,
      category: true,
      payoutAccount: true,
    },
  });

  if (ownedRestaurant) {
    return {
      restaurant: ownedRestaurant,
      memberRole: "OWNER",
      permissions: null,
      isOwner: true,
    };
  }

  const membership = await prisma.restaurantMember.findFirst({
    where: {
      userId,
      isActive: true,
      restaurant: {
        deletedAt: null,
      },
    },
    include: {
      restaurant: {
        include: {
          city: true,
          category: true,
          payoutAccount: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return null;

  return {
    restaurant: membership.restaurant,
    memberRole: membership.role,
    permissions: membership.permissions,
    isOwner: membership.role === "OWNER",
  };
};

const requireVendorAccess = async (req, res) => {
  const access = await resolveVendorAccess(req.user.id);

  if (!access) {
    res.status(404).json({
      success: false,
      message: "Vendor restaurant access not found",
    });

    return null;
  }

  if (!req.user?.isActive && req.user?.isActive !== undefined) {
    res.status(403).json({
      success: false,
      message: "Vendor account is inactive",
    });

    return null;
  }

  return access;
};

const ensureOrderSnapshot = async (tx, order) => {
  const finance = getOrderFinancials(order);

  if (finance.hasSnapshot) {
    return {
      order,
      finance,
    };
  }

  const updated = await tx.order.update({
    where: { id: order.id },
    data: {
      commissionableAmount:
        finance.commissionableAmount,
      commissionRate: finance.commissionRate,
      platformCommissionAmount:
        finance.platformCommission,
      vendorSettlementAmount:
        finance.vendorPayable,
    },
    include: {
      restaurant: true,
    },
  });

  return {
    order: updated,
    finance: getOrderFinancials(updated),
  };
};

const emitVendorOrder = (
  restaurantId,
  orderId,
  event,
  payload
) => {
  const io = getIO();

  if (!io) return;

  io.to(`order-${orderId}`).emit(
    "order-updated",
    payload
  );

  io.to(`vendor-${restaurantId}`).emit(
    event,
    payload
  );

  io.emit(event, payload);
};

const setupPdfResponse = (
  res,
  filename,
  title
) => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 42,
    bufferPages: true,
  });

  res.setHeader(
    "Content-Type",
    "application/pdf"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  doc.pipe(res);

  doc.fontSize(20).text("KARTO", {
    align: "center",
  });

  doc.fontSize(13).text(title, {
    align: "center",
  });

  doc.moveDown(0.5);

  doc
    .fontSize(8)
    .fillColor("#666666")
    .text(
      `Generated: ${new Date().toLocaleString("en-IN")}`,
      {
        align: "center",
      }
    );

  doc.fillColor("#000000").moveDown();

  return doc;
};

const pdfKeyValue = (doc, key, value) => {
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(`${key}: `, {
      continued: true,
    });

  doc
    .font("Helvetica")
    .text(String(value ?? "-"));
};

const formatPdfMoney = (value) =>
  `INR ${roundMoney(value).toFixed(2)}`;

/* =========================
   CITIES
========================= */

export const createCity = async (req, res) => {
  try {
    const { name, code } = req.body;

    if (!trimValue(name) || !trimValue(code)) {
      return res.status(400).json({
        success: false,
        message: "City name and code are required",
      });
    }

    const city = await prisma.city.upsert({
      where: { code: trimValue(code).toUpperCase() },
      update: {
        name: trimValue(name),
        isActive: true,
      },
      create: {
        name: trimValue(name),
        code: trimValue(code).toUpperCase(),
        isActive: true,
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
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const getCities = async (req, res) => {
  try {
    const { includeInactive } = req.query;

    const cities = await prisma.city.findMany({
      where: boolValue(includeInactive) ? {} : { isActive: true },
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      cities,
      data: cities,
    });
  } catch (error) {
    console.error("Get Cities Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const updateCity = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, isActive } = req.body;

    const city = await prisma.city.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: trimValue(name) }),
        ...(code !== undefined && { code: trimValue(code).toUpperCase() }),
        ...(isActive !== undefined && { isActive: boolValue(isActive) }),
      },
    });

    return res.json({
      success: true,
      message: "City updated successfully",
      city,
      data: city,
    });
  } catch (error) {
    console.error("Update City Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const deleteCity = async (req, res) => {
  try {
    const { id } = req.params;

    const vendors = await prisma.restaurant.count({ where: { cityId: id } });
    const riders = await prisma.user.count({ where: { cityId: id } });

    if (vendors > 0 || riders > 0) {
      const city = await prisma.city.update({
        where: { id },
        data: { isActive: false },
      });

      return res.json({
        success: true,
        message: "City has linked vendors/riders, so it was deactivated safely",
        city,
        data: city,
      });
    }

    await prisma.city.delete({ where: { id } });

    return res.json({
      success: true,
      message: "City deleted successfully",
    });
  } catch (error) {
    console.error("Delete City Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

/* =========================
   VENDORS
========================= */

export const createVendorByAdmin = async (req, res) => {
  try {
    const {
      name,
      ownerName,
      ownerMobileNo,
      phone,
      email,
      password,
      address,
      imageUrl,
      type = "RESTAURANT",
      commission = 0,
      cityId,
      categoryId,
    } = req.body;

    if (
      !trimValue(name) ||
      !trimValue(ownerName) ||
      !trimValue(ownerMobileNo) ||
      !trimValue(phone) ||
      !normalizeEmail(email) ||
      !trimValue(password) ||
      !trimValue(address) ||
      !cityId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "name, ownerName, ownerMobileNo, phone, email, password, address and cityId are required",
      });
    }

    const city = await prisma.city.findUnique({ where: { id: cityId } });

    if (!city) {
      return res.status(404).json({
        success: false,
        message: "City not found",
      });
    }

    if (categoryId) {
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
      });

      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Category not found",
        });
      }
    }

    const finalEmail = normalizeEmail(email);
    const finalOwnerPhone = trimValue(ownerMobileNo);
    const finalShopPhone = trimValue(phone);

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: finalEmail }, { phone: finalOwnerPhone }],
      },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Vendor user already exists with this email or owner mobile number",
      });
    }

    const existingRestaurant = await prisma.restaurant.findFirst({
      where: {
        OR: [{ email: finalEmail }, { phone: finalShopPhone }],
      },
    });

    if (existingRestaurant) {
      return res.status(409).json({
        success: false,
        message: "Vendor already exists with this email or phone",
      });
    }

    const uploadedImageUrl = await uploadFile(req, "vendor/admin-create");
    const finalImageUrl = uploadedImageUrl || imageUrl || null;

    const hashedPassword = await bcrypt.hash(trimValue(password), 10);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: trimValue(ownerName),
          email: finalEmail,
          phone: finalOwnerPhone,
          password: hashedPassword,
          role: "VENDOR",
          isActive: true,
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      const vendor = await tx.restaurant.create({
        data: {
          name: trimValue(name),
          ownerName: trimValue(ownerName),
          ownerMobileNo: finalOwnerPhone,
          phone: finalShopPhone,
          email: finalEmail,
          address: trimValue(address),
          imageUrl: finalImageUrl,
          type: type || "RESTAURANT",
          commission: Number(commission || 0),
          vendorId: user.id,
          cityId,
          categoryId: categoryId || null,
          isOpen: true,
        },
        include: {
          city: true,
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
          category: true,
        },
      });

      return { user, vendor };
    });

    return res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      data: result,
      vendor: result.vendor,
      user: result.user,
    });
  } catch (error) {
    console.error("Create Vendor Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const getAdminVendors = async (req, res) => {
  try {
    const {
      cityId,
      categoryId,
      verificationStatus,
      search,
    } = req.query;

    const vendors = await prisma.restaurant.findMany({
      where: {
        deletedAt: null,
        ...(cityId && cityId !== "ALL"
          ? { cityId }
          : {}),
        ...(categoryId && categoryId !== "ALL"
          ? { categoryId }
          : {}),
        ...(verificationStatus &&
        verificationStatus !== "ALL"
          ? { verificationStatus }
          : {}),
        ...(search
          ? {
              OR: [
                {
                  name: {
                    contains: String(search),
                    mode: "insensitive",
                  },
                },
                {
                  email: {
                    contains: String(search),
                    mode: "insensitive",
                  },
                },
                {
                  phone: {
                    contains: String(search),
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        city: true,
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
        category: true,
        orders: {
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            totalAmount: true,
            itemTotal: true,
            deliveryFee: true,
            platformFee: true,
            taxAmount: true,
            discount: true,
            commissionableAmount: true,
            commissionRate: true,
            platformCommissionAmount: true,
            vendorSettlementAmount: true,
          },
        },
        menuItems: {
          select: {
            id: true,
            isAvailable: true,
          },
        },
        payoutAccount: true,
        documents: {
          select: {
            id: true,
            type: true,
            status: true,
            expiresAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = vendors.map((vendor) => {
      let totalRevenue = 0;
      let kartoIncome = 0;
      let vendorIncome = 0;

      const deliveredOrders = [];
      const cancelledOrders = [];
      const activeOrders = [];

      for (const order of vendor.orders || []) {
        if (order.status === "DELIVERED") {
          deliveredOrders.push(order);
        } else if (order.status === "CANCELLED") {
          cancelledOrders.push(order);
        } else {
          activeOrders.push(order);
        }

        if (!isRecognizedOrder(order)) continue;

        const finance = getOrderFinancials({
          ...order,
          restaurant: vendor,
        });

        totalRevenue += finance.totalAmount;
        kartoIncome += finance.platformCommission;
        vendorIncome += finance.vendorPayable;
      }

      return {
        ...vendor,
        totalOrders: vendor.orders.length,
        deliveredOrders: deliveredOrders.length,
        cancelledOrders: cancelledOrders.length,
        activeOrders: activeOrders.length,
        totalMenuItems: vendor.menuItems.length,
        availableMenuItems: vendor.menuItems.filter(
          (item) => item.isAvailable
        ).length,
        totalRevenue: roundMoney(totalRevenue),
        kartoIncome: roundMoney(kartoIncome),
        vendorIncome: roundMoney(vendorIncome),
      };
    });

    return res.json({
      success: true,
      vendors: data,
      data,
    });
  } catch (error) {
    console.error("Get Admin Vendors Error:", error);

    return res.status(500).json({
      success: false,
      message:
        error.message || "Something went wrong",
    });
  }
};

export const updateVendorByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      ownerName,
      ownerMobileNo,
      phone,
      email,
      password,
      address,
      imageUrl,
      type,
      commission,
      cityId,
      categoryId,
      isOpen,
      isActive,
    } = req.body;

    const existingVendor = await prisma.restaurant.findUnique({
      where: { id },
      include: { vendor: true },
    });

    if (!existingVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    if (cityId) {
      const city = await prisma.city.findUnique({ where: { id: cityId } });

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
          message: "Category not found",
        });
      }
    }

    const finalEmail = email !== undefined ? normalizeEmail(email) : undefined;
    const finalOwnerPhone =
      ownerMobileNo !== undefined ? trimValue(ownerMobileNo) : undefined;
    const finalShopPhone = phone !== undefined ? trimValue(phone) : undefined;

    if (finalEmail || finalOwnerPhone) {
      const duplicateUser = await prisma.user.findFirst({
        where: {
          id: { not: existingVendor.vendorId },
          OR: [
            finalEmail ? { email: finalEmail } : undefined,
            finalOwnerPhone ? { phone: finalOwnerPhone } : undefined,
          ].filter(Boolean),
        },
      });

      if (duplicateUser) {
        return res.status(409).json({
          success: false,
          message: "Another user already exists with this email or owner mobile number",
        });
      }
    }

    if (finalEmail || finalShopPhone) {
      const duplicateRestaurant = await prisma.restaurant.findFirst({
        where: {
          id: { not: id },
          OR: [
            finalEmail ? { email: finalEmail } : undefined,
            finalShopPhone ? { phone: finalShopPhone } : undefined,
          ].filter(Boolean),
        },
      });

      if (duplicateRestaurant) {
        return res.status(409).json({
          success: false,
          message: "Another vendor already exists with this email or phone",
        });
      }
    }

    const uploadedImageUrl = await uploadFile(req, "vendor/admin-update");
    const finalImageUrl = uploadedImageUrl || imageUrl;

    const hashedPassword = password
      ? await bcrypt.hash(trimValue(password), 10)
      : undefined;

    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: existingVendor.vendorId },
        data: {
          ...(ownerName !== undefined && { fullName: trimValue(ownerName) }),
          ...(finalEmail !== undefined && { email: finalEmail }),
          ...(finalOwnerPhone !== undefined && { phone: finalOwnerPhone }),
          ...(hashedPassword && { password: hashedPassword }),
          ...(isActive !== undefined && { isActive: boolValue(isActive) }),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      const updatedVendor = await tx.restaurant.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: trimValue(name) }),
          ...(ownerName !== undefined && { ownerName: trimValue(ownerName) }),
          ...(finalOwnerPhone !== undefined && {
            ownerMobileNo: finalOwnerPhone,
          }),
          ...(finalShopPhone !== undefined && { phone: finalShopPhone }),
          ...(finalEmail !== undefined && { email: finalEmail }),
          ...(address !== undefined && { address: trimValue(address) }),
          ...(finalImageUrl !== undefined && { imageUrl: finalImageUrl || null }),
          ...(type !== undefined && { type }),
          ...(commission !== undefined && {
            commission: Number(commission || 0),
          }),
          ...(cityId !== undefined && { cityId }),
          ...(categoryId !== undefined && { categoryId: categoryId || null }),
          ...(isOpen !== undefined && { isOpen: boolValue(isOpen) }),
        },
        include: {
          city: true,
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
          category: true,
        },
      });

      return { user: updatedUser, vendor: updatedVendor };
    });

    return res.json({
      success: true,
      message: "Vendor updated successfully",
      data: result,
      user: result.user,
      vendor: result.vendor,
    });
  } catch (error) {
    console.error("Update Vendor Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const updateVendorCommission = async (req, res) => {
  try {
    const { id } = req.params;
    const { commission } = req.body;

    if (commission === undefined || Number.isNaN(Number(commission))) {
      return res.status(400).json({
        success: false,
        message: "Valid commission is required",
      });
    }

    const vendor = await prisma.restaurant.update({
      where: { id },
      data: {
        commission: Number(commission),
      },
      include: {
        city: true,
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
        category: true,
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
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const toggleRestaurantStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, isOpen } = req.body;

    const nextStatus =
      isOpen !== undefined ? boolValue(isOpen) : boolValue(isActive);

    const vendor = await prisma.restaurant.update({
      where: { id },
      data: {
        isOpen: nextStatus,
      },
      include: {
        city: true,
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
        category: true,
      },
    });

    return res.json({
      success: true,
      message: vendor.isOpen ? "Vendor activated" : "Vendor blocked",
      vendor,
      restaurant: vendor,
      data: vendor,
    });
  } catch (error) {
    console.error("Toggle Vendor Status Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

export const deleteVendorByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        orders: true,
        menuItems: true,
      },
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    if ((vendor.orders?.length || 0) > 0) {
      const updated = await prisma.$transaction(async (tx) => {
        const restaurant = await tx.restaurant.update({
          where: { id },
          data: { isOpen: false },
        });

        await tx.user.update({
          where: { id: vendor.vendorId },
          data: { isActive: false },
        });

        return restaurant;
      });

      return res.json({
        success: true,
        message:
          "Vendor has orders, so it was safely blocked instead of hard deleted",
        vendor: updated,
        data: updated,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.menuItemAddon.deleteMany({
        where: {
          menuItem: {
            restaurantId: id,
          },
        },
      });

      await tx.menuItemCustomization.deleteMany({
        where: {
          menuItem: {
            restaurantId: id,
          },
        },
      });

      await tx.menuItem.deleteMany({
        where: { restaurantId: id },
      });

      await tx.vendorSubCategory.deleteMany({
        where: {
          vendorCategory: {
            restaurantId: id,
          },
        },
      });

      await tx.vendorCategory.deleteMany({
        where: { restaurantId: id },
      });

      await tx.restaurant.delete({
        where: { id },
      });

      await tx.user.delete({
        where: { id: vendor.vendorId },
      });
    });

    return res.json({
      success: true,
      message: "Vendor deleted successfully",
    });
  } catch (error) {
    console.error("Delete Vendor Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
};

/* =========================================================
   VENDOR APP - PRODUCTION CONTROLLER
========================================================= */

export const getVendorDashboard = async (req, res) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const restaurant = access.restaurant;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const month = new Date();
    month.setDate(1);
    month.setHours(0, 0, 0, 0);

    const [
      activeOrders,
      todayOrders,
      monthlyOrders,
      menuCount,
      availableMenuCount,
      pendingSettlements,
      latestInvoices,
      recentRatings,
    ] = await Promise.all([
      prisma.order.findMany({
        where: {
          restaurantId: restaurant.id,
          status: {
            in: [
              "PLACED",
              "ACCEPTED_BY_VENDOR",
              "PREPARING",
              "READY_FOR_PICKUP",
              "ASSIGNED_TO_RIDER",
              "PICKED_UP",
              "OUT_FOR_DELIVERY",
            ],
          },
        },
        include: vendorOrderInclude,
        orderBy: { createdAt: "desc" },
        take: 20,
      }),

      prisma.order.findMany({
        where: {
          restaurantId: restaurant.id,
          createdAt: { gte: today },
        },
        include: {
          restaurant: true,
        },
      }),

      prisma.order.findMany({
        where: {
          restaurantId: restaurant.id,
          createdAt: { gte: month },
        },
        include: {
          restaurant: true,
        },
      }),

      prisma.menuItem.count({
        where: {
          restaurantId: restaurant.id,
        },
      }),

      prisma.menuItem.count({
        where: {
          restaurantId: restaurant.id,
          isAvailable: true,
        },
      }),

      prisma.vendorSettlement.aggregate({
        where: {
          restaurantId: restaurant.id,
          status: {
            in: ["PENDING", "PROCESSING"],
          },
        },
        _sum: {
          netAmount: true,
        },
        _count: {
          _all: true,
        },
      }),

      prisma.vendorInvoice.findMany({
        where: {
          restaurantId: restaurant.id,
        },
        orderBy: {
          generatedAt: "desc",
        },
        take: 5,
      }),

      prisma.restaurantRating.findMany({
        where: {
          restaurantId: restaurant.id,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 5,
      }),
    ]);

    const summarize = (orders) => {
      let recognizedRevenue = 0;
      let platformCommission = 0;
      let vendorPayable = 0;
      let delivered = 0;
      let cancelled = 0;
      let active = 0;

      for (const order of orders) {
        if (order.status === "DELIVERED") {
          delivered += 1;
        } else if (order.status === "CANCELLED") {
          cancelled += 1;
        } else {
          active += 1;
        }

        if (!isRecognizedOrder(order)) continue;

        const finance = getOrderFinancials(order);
        recognizedRevenue += finance.totalAmount;
        platformCommission +=
          finance.platformCommission;
        vendorPayable += finance.vendorPayable;
      }

      return {
        totalOrders: orders.length,
        delivered,
        cancelled,
        active,
        recognizedRevenue:
          roundMoney(recognizedRevenue),
        platformCommission:
          roundMoney(platformCommission),
        vendorPayable:
          roundMoney(vendorPayable),
      };
    };

    return res.json({
      success: true,
      dashboard: {
        access: {
          memberRole: access.memberRole,
          permissions: access.permissions,
          isOwner: access.isOwner,
        },
        restaurant,
        status: {
          isOpen: restaurant.isOpen,
          isAcceptingOrders:
            restaurant.isAcceptingOrders,
          busyUntil: restaurant.busyUntil,
          verificationStatus:
            restaurant.verificationStatus,
          isVerified: restaurant.isVerified,
        },
        menu: {
          total: menuCount,
          available: availableMenuCount,
          unavailable:
            menuCount - availableMenuCount,
        },
        today: summarize(todayOrders),
        month: summarize(monthlyOrders),
        pendingSettlement: {
          amount: roundMoney(
            pendingSettlements._sum.netAmount
          ),
          count:
            pendingSettlements._count._all,
        },
        activeOrders:
          activeOrders.map(cleanOrder),
        recentInvoices: latestInvoices.map(
          (invoice) => ({
            ...invoice,
            grossAmount: roundMoney(
              invoice.grossAmount
            ),
            commissionAmount: roundMoney(
              invoice.commissionAmount
            ),
            adjustmentAmount: roundMoney(
              invoice.adjustmentAmount
            ),
            netPayable: roundMoney(
              invoice.netPayable
            ),
          })
        ),
        recentRatings,
      },
    });
  } catch (error) {
    console.error(
      "Vendor Dashboard Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        "Failed to fetch vendor dashboard",
    });
  }
};

export const getVendorProfile = async (req, res) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const restaurant =
      await prisma.restaurant.findUnique({
        where: {
          id: access.restaurant.id,
        },
        include: {
          city: true,
          category: true,
          vendor: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              avatarUrl: true,
              isActive: true,
              createdAt: true,
            },
          },
          payoutAccount: true,
          timings: {
            orderBy: {
              dayOfWeek: "asc",
            },
          },
          operatingExceptions: {
            where: {
              date: {
                gte: new Date(
                  new Date().setHours(
                    0,
                    0,
                    0,
                    0
                  )
                ),
              },
            },
            orderBy: {
              date: "asc",
            },
            take: 30,
          },
          documents: {
            orderBy: {
              createdAt: "desc",
            },
          },
          members: {
            where: {
              isActive: true,
            },
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  phone: true,
                  avatarUrl: true,
                  isActive: true,
                },
              },
            },
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });

    return res.json({
      success: true,
      vendor: restaurant,
      access: {
        memberRole: access.memberRole,
        permissions: access.permissions,
        isOwner: access.isOwner,
      },
    });
  } catch (error) {
    console.error(
      "Vendor Profile Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor profile",
    });
  }
};

export const updateVendorProfile = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can update restaurant profile",
      });
    }

    const {
      name,
      address,
      phone,
      email,
      ownerName,
      ownerMobileNo,
      type,
      categoryId,
      deliveryFee,
      minimumOrder,
      deliveryTime,
      defaultPrepTime,
      openingTime,
      closingTime,
      weeklyOffDay,
      isPureVeg,
      latitude,
      longitude,
      gstNumber,
      fssaiNumber,
      imageUrl,
      bannerUrl,
    } = req.body;

    if (categoryId) {
      const category =
        await prisma.category.findUnique({
          where: {
            id: categoryId,
          },
        });

      if (!category) {
        return res.status(404).json({
          success: false,
          message:
            "Business category not found",
        });
      }
    }

    if (
      latitude !== undefined &&
      !validLatitude(latitude)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid latitude",
      });
    }

    if (
      longitude !== undefined &&
      !validLongitude(longitude)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid longitude",
      });
    }

    const uploadedImage = await uploadFile(
      req,
      "vendor/profile"
    );

    const updateData = {
      ...(name !== undefined && {
        name: cleanOptional(name),
      }),
      ...(address !== undefined && {
        address: cleanOptional(address),
      }),
      ...(phone !== undefined && {
        phone: cleanOptional(phone),
      }),
      ...(email !== undefined && {
        email: normalizeEmail(email),
      }),
      ...(ownerName !== undefined && {
        ownerName: cleanOptional(ownerName),
      }),
      ...(ownerMobileNo !== undefined && {
        ownerMobileNo:
          cleanOptional(ownerMobileNo),
      }),
      ...(type !== undefined && {
        type: cleanOptional(type),
      }),
      ...(categoryId !== undefined && {
        categoryId: categoryId || null,
      }),
      ...(deliveryFee !== undefined && {
        deliveryFee:
          Number(deliveryFee || 0),
      }),
      ...(minimumOrder !== undefined && {
        minimumOrder:
          Number(minimumOrder || 0),
      }),
      ...(deliveryTime !== undefined && {
        deliveryTime:
          cleanOptional(deliveryTime),
      }),
      ...(defaultPrepTime !== undefined && {
        defaultPrepTime: Math.max(
          1,
          safeInt(defaultPrepTime, 30)
        ),
      }),
      ...(openingTime !== undefined && {
        openingTime:
          cleanOptional(openingTime) || null,
      }),
      ...(closingTime !== undefined && {
        closingTime:
          cleanOptional(closingTime) || null,
      }),
      ...(weeklyOffDay !== undefined && {
        weeklyOffDay:
          cleanOptional(weeklyOffDay) || null,
      }),
      ...(isPureVeg !== undefined && {
        isPureVeg: boolValue(isPureVeg),
      }),
      ...(latitude !== undefined && {
        latitude: Number(latitude),
      }),
      ...(longitude !== undefined && {
        longitude: Number(longitude),
      }),
      ...(gstNumber !== undefined && {
        gstNumber:
          cleanOptional(gstNumber) || null,
      }),
      ...(fssaiNumber !== undefined && {
        fssaiNumber:
          cleanOptional(fssaiNumber) || null,
      }),
      ...(uploadedImage && {
        imageUrl: uploadedImage,
      }),
      ...(!uploadedImage &&
        imageUrl !== undefined && {
          imageUrl: imageUrl || null,
        }),
      ...(bannerUrl !== undefined && {
        bannerUrl: bannerUrl || null,
      }),
    };

    const restaurant =
      await prisma.restaurant.update({
        where: {
          id: access.restaurant.id,
        },
        data: updateData,
        include: {
          city: true,
          category: true,
          payoutAccount: true,
        },
      });

    return res.json({
      success: true,
      message:
        "Vendor profile updated successfully",
      vendor: restaurant,
    });
  } catch (error) {
    console.error(
      "Update Vendor Profile Error:",
      error
    );

    return res.status(
      error?.code === "P2002" ? 409 : 500
    ).json({
      success: false,
      message:
        error?.code === "P2002"
          ? "Email or phone is already in use"
          : "Failed to update vendor profile",
    });
  }
};

export const toggleVendorAcceptingOrders = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const {
      isOpen,
      isAcceptingOrders,
    } = req.body;

    const updateData = {};

    if (isOpen !== undefined) {
      updateData.isOpen =
        boolValue(isOpen);
    }

    if (isAcceptingOrders !== undefined) {
      updateData.isAcceptingOrders =
        boolValue(isAcceptingOrders);
    }

    if (!Object.keys(updateData).length) {
      return res.status(400).json({
        success: false,
        message:
          "isOpen or isAcceptingOrders is required",
      });
    }

    const vendor =
      await prisma.restaurant.update({
        where: {
          id: access.restaurant.id,
        },
        data: updateData,
      });

    getIO()?.emit(
      "vendor-availability-changed",
      {
        restaurantId: vendor.id,
        isOpen: vendor.isOpen,
        isAcceptingOrders:
          vendor.isAcceptingOrders,
      }
    );

    return res.json({
      success: true,
      message:
        vendor.isOpen &&
        vendor.isAcceptingOrders
          ? "Restaurant is accepting orders"
          : "Restaurant availability updated",
      vendor,
    });
  } catch (error) {
    console.error(
      "Vendor Availability Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update restaurant availability",
    });
  }
};

export const setVendorBusyUntil = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const busyUntil =
      req.body?.busyUntil === null ||
      req.body?.busyUntil === ""
        ? null
        : safeDate(req.body?.busyUntil);

    if (
      req.body?.busyUntil &&
      !busyUntil
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid busyUntil date",
      });
    }

    const vendor =
      await prisma.restaurant.update({
        where: {
          id: access.restaurant.id,
        },
        data: {
          busyUntil,
        },
      });

    return res.json({
      success: true,
      message: busyUntil
        ? "Restaurant marked busy"
        : "Busy status cleared",
      busyUntil: vendor.busyUntil,
    });
  } catch (error) {
    console.error(
      "Set Vendor Busy Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update busy status",
    });
  }
};

/* =========================
   VENDOR TIMINGS
========================= */

export const getVendorTimings = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const [timings, exceptions] =
      await Promise.all([
        prisma.restaurantTiming.findMany({
          where: {
            restaurantId:
              access.restaurant.id,
          },
          orderBy: {
            dayOfWeek: "asc",
          },
        }),

        prisma.vendorOperatingException.findMany({
          where: {
            restaurantId:
              access.restaurant.id,
            date: {
              gte: new Date(
                new Date().setHours(
                  0,
                  0,
                  0,
                  0
                )
              ),
            },
          },
          orderBy: {
            date: "asc",
          },
          take: 90,
        }),
      ]);

    return res.json({
      success: true,
      timings,
      exceptions,
    });
  } catch (error) {
    console.error(
      "Get Vendor Timings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch operating hours",
    });
  }
};

export const updateVendorTimings = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const timings = Array.isArray(
      req.body?.timings
    )
      ? req.body.timings
      : [];

    if (!timings.length) {
      return res.status(400).json({
        success: false,
        message:
          "timings array is required",
      });
    }

    for (const timing of timings) {
      const day = safeInt(
        timing.dayOfWeek,
        -1
      );

      if (day < 0 || day > 6) {
        return res.status(400).json({
          success: false,
          message:
            "dayOfWeek must be between 0 and 6",
        });
      }

      if (
        !boolValue(
          timing.isClosed,
          false
        ) &&
        (!timing.openTime ||
          !timing.closeTime)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "openTime and closeTime are required for open days",
        });
      }
    }

    const result =
      await prisma.$transaction(
        async (tx) => {
          const updated = [];

          for (const timing of timings) {
            const item =
              await tx.restaurantTiming.upsert({
                where: {
                  restaurantId_dayOfWeek: {
                    restaurantId:
                      access.restaurant.id,
                    dayOfWeek:
                      safeInt(
                        timing.dayOfWeek
                      ),
                  },
                },
                update: {
                  openTime:
                    cleanOptional(
                      timing.openTime
                    ) || "00:00",
                  closeTime:
                    cleanOptional(
                      timing.closeTime
                    ) || "00:00",
                  isClosed:
                    boolValue(
                      timing.isClosed,
                      false
                    ),
                },
                create: {
                  restaurantId:
                    access.restaurant.id,
                  dayOfWeek:
                    safeInt(
                      timing.dayOfWeek
                    ),
                  openTime:
                    cleanOptional(
                      timing.openTime
                    ) || "00:00",
                  closeTime:
                    cleanOptional(
                      timing.closeTime
                    ) || "00:00",
                  isClosed:
                    boolValue(
                      timing.isClosed,
                      false
                    ),
                },
              });

            updated.push(item);
          }

          return updated;
        }
      );

    return res.json({
      success: true,
      message:
        "Operating hours updated",
      timings: result,
    });
  } catch (error) {
    console.error(
      "Update Vendor Timings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update operating hours",
    });
  }
};

export const upsertVendorOperatingException = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const date = safeDate(
      req.body?.date
    );

    if (!date) {
      return res.status(400).json({
        success: false,
        message: "Valid date is required",
      });
    }

    date.setHours(0, 0, 0, 0);

    const isClosed = boolValue(
      req.body?.isClosed,
      true
    );

    if (
      !isClosed &&
      (!req.body?.openTime ||
        !req.body?.closeTime)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "openTime and closeTime are required when restaurant is open",
      });
    }

    const exception =
      await prisma.vendorOperatingException.upsert({
        where: {
          restaurantId_date: {
            restaurantId:
              access.restaurant.id,
            date,
          },
        },
        update: {
          isClosed,
          openTime:
            cleanOptional(
              req.body?.openTime
            ) || null,
          closeTime:
            cleanOptional(
              req.body?.closeTime
            ) || null,
          reason:
            cleanOptional(
              req.body?.reason
            ) || null,
        },
        create: {
          restaurantId:
            access.restaurant.id,
          date,
          isClosed,
          openTime:
            cleanOptional(
              req.body?.openTime
            ) || null,
          closeTime:
            cleanOptional(
              req.body?.closeTime
            ) || null,
          reason:
            cleanOptional(
              req.body?.reason
            ) || null,
        },
      });

    return res.json({
      success: true,
      message:
        "Special operating day saved",
      exception,
    });
  } catch (error) {
    console.error(
      "Vendor Operating Exception Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to save special operating day",
    });
  }
};

export const deleteVendorOperatingException = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const exception =
      await prisma.vendorOperatingException.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!exception) {
      return res.status(404).json({
        success: false,
        message:
          "Operating exception not found",
      });
    }

    await prisma.vendorOperatingException.delete({
      where: {
        id: exception.id,
      },
    });

    return res.json({
      success: true,
      message:
        "Special operating day deleted",
    });
  } catch (error) {
    console.error(
      "Delete Operating Exception Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete operating exception",
    });
  }
};

/* =========================
   VENDOR KYC DOCUMENTS
========================= */

export const getVendorDocuments = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const documents =
      await prisma.vendorDocument.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    return res.json({
      success: true,
      documents,
      verificationStatus:
        access.restaurant
          .verificationStatus,
    });
  } catch (error) {
    console.error(
      "Vendor Documents Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor documents",
    });
  }
};

export const upsertVendorDocument = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const type = String(
      req.body?.type || ""
    ).toUpperCase();

    const allowedTypes = [
      "FSSAI",
      "GST",
      "PAN",
      "BANK_PROOF",
      "SHOP_LICENSE",
      "OWNER_ID",
      "OTHER",
    ];

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid vendor document type",
      });
    }

    const uploadedUrl =
      await uploadFile(
        req,
        "vendor/documents"
      );

    const existing =
      await prisma.vendorDocument.findFirst({
        where: {
          restaurantId:
            access.restaurant.id,
          type,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    const data = {
      type,
      documentNumber:
        cleanOptional(
          req.body?.documentNumber
        ) || null,
      documentUrl:
        uploadedUrl ||
        req.body?.documentUrl ||
        null,
      frontImageUrl:
        req.body?.frontImageUrl || null,
      backImageUrl:
        req.body?.backImageUrl || null,
      expiresAt: req.body?.expiresAt
        ? safeDate(req.body.expiresAt)
        : null,
      status: "PENDING",
      rejectionReason: null,
      reviewedById: null,
      reviewedAt: null,
    };

    const document = existing
      ? await prisma.vendorDocument.update({
          where: {
            id: existing.id,
          },
          data,
        })
      : await prisma.vendorDocument.create({
          data: {
            restaurantId:
              access.restaurant.id,
            ...data,
          },
        });

    await prisma.restaurant.update({
      where: {
        id: access.restaurant.id,
      },
      data: {
        verificationStatus:
          "PENDING",
        isVerified: false,
        verifiedAt: null,
        verificationNote: null,
      },
    });

    return res
      .status(existing ? 200 : 201)
      .json({
        success: true,
        message:
          "Document submitted for review",
        document,
      });
  } catch (error) {
    console.error(
      "Submit Vendor Document Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to submit vendor document",
    });
  }
};

export const deletePendingVendorDocument = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const document =
      await prisma.vendorDocument.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
    }

    if (
      !["PENDING", "REJECTED"].includes(
        document.status
      )
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Approved/under-review document cannot be deleted",
      });
    }

    await prisma.vendorDocument.delete({
      where: {
        id: document.id,
      },
    });

    return res.json({
      success: true,
      message: "Document deleted",
    });
  } catch (error) {
    console.error(
      "Delete Vendor Document Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete vendor document",
    });
  }
};

/* =========================
   VENDOR PAYOUT ACCOUNT
========================= */

export const updateVendorPayoutDetails = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (!access.isOwner) {
      return res.status(403).json({
        success: false,
        message:
          "Only restaurant owner can change payout details",
      });
    }

    const accountNumber =
      cleanOptional(
        req.body?.accountNumber
      );

    const account =
      await prisma.vendorPayoutAccount.upsert({
        where: {
          restaurantId:
            access.restaurant.id,
        },
        update: {
          ...(req.body
            ?.accountHolder !==
            undefined && {
            accountHolder:
              cleanOptional(
                req.body.accountHolder
              ) || null,
          }),
          ...(accountNumber !==
            undefined && {
            accountNumberEncrypted:
              accountNumber || null,
            accountLast4:
              accountNumber
                ? accountNumber.slice(
                    -4
                  )
                : null,
          }),
          ...(req.body?.bankName !==
            undefined && {
            bankName:
              cleanOptional(
                req.body.bankName
              ) || null,
          }),
          ...(req.body?.ifscCode !==
            undefined && {
            ifscCode:
              cleanOptional(
                req.body.ifscCode
              )?.toUpperCase() ||
              null,
          }),
          ...(req.body?.upiId !==
            undefined && {
            upiId:
              cleanOptional(
                req.body.upiId
              ) || null,
          }),
          isVerified: false,
          verifiedAt: null,
        },
        create: {
          restaurantId:
            access.restaurant.id,
          accountHolder:
            cleanOptional(
              req.body?.accountHolder
            ) || null,
          accountNumberEncrypted:
            accountNumber || null,
          accountLast4:
            accountNumber
              ? accountNumber.slice(-4)
              : null,
          bankName:
            cleanOptional(
              req.body?.bankName
            ) || null,
          ifscCode:
            cleanOptional(
              req.body?.ifscCode
            )?.toUpperCase() || null,
          upiId:
            cleanOptional(
              req.body?.upiId
            ) || null,
          isVerified: false,
        },
      });

    return res.json({
      success: true,
      message:
        "Payout account updated and sent for verification",
      payout: {
        accountHolder:
          account.accountHolder,
        accountLast4:
          account.accountLast4,
        bankName: account.bankName,
        ifscCode: account.ifscCode,
        upiId: account.upiId,
        isVerified:
          account.isVerified,
        verifiedAt:
          account.verifiedAt,
      },
    });
  } catch (error) {
    console.error(
      "Update Vendor Payout Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update payout details",
    });
  }
};

/* =========================
   VENDOR STAFF
========================= */

export const getVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const members =
      await prisma.restaurantMember.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              avatarUrl: true,
              isActive: true,
              lastSeen: true,
            },
          },
        },
        orderBy: [
          {
            isActive: "desc",
          },
          {
            createdAt: "asc",
          },
        ],
      });

    return res.json({
      success: true,
      members,
    });
  } catch (error) {
    console.error(
      "Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor staff",
    });
  }
};

export const addVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can add staff",
      });
    }

    const {
      fullName,
      email,
      phone,
      password,
      role = "STAFF",
      permissions,
    } = req.body;

    if (
      !trimValue(fullName) ||
      !normalizeEmail(email) ||
      !trimValue(password)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "fullName, email and password are required",
      });
    }

    const finalRole = String(
      role
    ).toUpperCase();

    if (
      ![
        "OWNER",
        "MANAGER",
        "STAFF",
        "ACCOUNTANT",
      ].includes(finalRole)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid restaurant member role",
      });
    }

    if (
      finalRole === "OWNER" &&
      !access.isOwner
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner can add another owner",
      });
    }

    const finalEmail =
      normalizeEmail(email);
    const finalPhone =
      cleanOptional(phone);

    const duplicate =
      await prisma.user.findFirst({
        where: {
          OR: [
            {
              email: finalEmail,
            },
            ...(finalPhone
              ? [
                  {
                    phone: finalPhone,
                  },
                ]
              : []),
          ],
        },
      });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message:
          "Email or phone already belongs to another account",
      });
    }

    const hashedPassword =
      await bcrypt.hash(
        trimValue(password),
        10
      );

    const result =
      await prisma.$transaction(
        async (tx) => {
          const user =
            await tx.user.create({
              data: {
                fullName:
                  trimValue(fullName),
                email: finalEmail,
                phone:
                  finalPhone || null,
                password:
                  hashedPassword,
                role: "VENDOR",
                isActive: true,
                cityId:
                  access.restaurant
                    .cityId,
              },
            });

          const member =
            await tx.restaurantMember.create({
              data: {
                restaurantId:
                  access.restaurant.id,
                userId: user.id,
                role: finalRole,
                permissions:
                  permissions ?? null,
                joinedAt: new Date(),
                isActive: true,
              },
              include: {
                user: true,
              },
            });

          return {
            user,
            member,
          };
        }
      );

    return res.status(201).json({
      success: true,
      message:
        "Vendor staff member created",
      member: result.member,
    });
  } catch (error) {
    console.error(
      "Add Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to add vendor staff",
    });
  }
};

export const updateVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can update staff",
      });
    }

    const member =
      await prisma.restaurantMember.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include: {
          user: true,
        },
      });

    if (!member) {
      return res.status(404).json({
        success: false,
        message:
          "Staff member not found",
      });
    }

    if (
      member.role === "OWNER" &&
      !access.isOwner
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner can modify owner access",
      });
    }

    const role =
      req.body?.role !== undefined
        ? String(
            req.body.role
          ).toUpperCase()
        : undefined;

    if (
      role !== undefined &&
      ![
        "OWNER",
        "MANAGER",
        "STAFF",
        "ACCOUNTANT",
      ].includes(role)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid restaurant member role",
      });
    }

    const result =
      await prisma.$transaction(
        async (tx) => {
          if (
            req.body?.fullName !==
              undefined ||
            req.body?.phone !==
              undefined ||
            req.body?.isActive !==
              undefined
          ) {
            await tx.user.update({
              where: {
                id: member.userId,
              },
              data: {
                ...(req.body
                  ?.fullName !==
                  undefined && {
                  fullName:
                    cleanOptional(
                      req.body.fullName
                    ),
                }),
                ...(req.body?.phone !==
                  undefined && {
                  phone:
                    cleanOptional(
                      req.body.phone
                    ) || null,
                }),
                ...(req.body?.isActive !==
                  undefined && {
                  isActive:
                    boolValue(
                      req.body.isActive
                    ),
                }),
              },
            });
          }

          return tx.restaurantMember.update({
            where: {
              id: member.id,
            },
            data: {
              ...(role !==
                undefined && {
                role,
              }),
              ...(req.body
                ?.permissions !==
                undefined && {
                permissions:
                  req.body.permissions,
              }),
              ...(req.body?.isActive !==
                undefined && {
                isActive:
                  boolValue(
                    req.body.isActive
                  ),
              }),
            },
            include: {
              user: true,
            },
          });
        }
      );

    return res.json({
      success: true,
      message:
        "Vendor staff updated",
      member: result,
    });
  } catch (error) {
    console.error(
      "Update Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update vendor staff",
    });
  }
};

export const removeVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can remove staff",
      });
    }

    const member =
      await prisma.restaurantMember.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!member) {
      return res.status(404).json({
        success: false,
        message:
          "Staff member not found",
      });
    }

    if (member.role === "OWNER") {
      return res.status(409).json({
        success: false,
        message:
          "Restaurant owner cannot be removed",
      });
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.restaurantMember.update({
          where: {
            id: member.id,
          },
          data: {
            isActive: false,
          },
        });

        await tx.user.update({
          where: {
            id: member.userId,
          },
          data: {
            isActive: false,
          },
        });
      }
    );

    return res.json({
      success: true,
      message:
        "Vendor staff access removed",
    });
  } catch (error) {
    console.error(
      "Remove Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to remove vendor staff",
    });
  }
};

/* =========================
   VENDOR ORDERS
========================= */

export const getVendorOrders = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const {
      status,
      paymentStatus,
      paymentMethod,
      search,
      from,
      to,
    } = req.query;

    const { page, limit, skip } =
      pageParams(req, 25, 100);

    const where = {
      restaurantId:
        access.restaurant.id,
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
      ...(paymentStatus &&
      paymentStatus !== "ALL"
        ? {
            paymentStatus,
          }
        : {}),
      ...(paymentMethod &&
      paymentMethod !== "ALL"
        ? {
            paymentMethod,
          }
        : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from && {
                gte: safeDate(from),
              }),
              ...(to && {
                lte: safeDate(to),
              }),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              {
                orderNumber: {
                  contains:
                    String(search),
                  mode: "insensitive",
                },
              },
              {
                user: {
                  fullName: {
                    contains:
                      String(search),
                    mode: "insensitive",
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [orders, total] =
      await Promise.all([
        prisma.order.findMany({
          where,
          include:
            vendorOrderInclude,
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.order.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      orders:
        orders.map(cleanOrder),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Get Vendor Orders Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor orders",
    });
  }
};

export const getVendorOrderById = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const order =
      await prisma.order.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include:
          vendorOrderInclude,
      });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.json({
      success: true,
      order: cleanOrder(order),
      financials:
        getOrderFinancials({
          ...order,
          restaurant:
            access.restaurant,
        }),
    });
  } catch (error) {
    console.error(
      "Get Vendor Order Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch order",
    });
  }
};

export const acceptOrderByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const restaurant =
      access.restaurant;

    if (
      !restaurant.isOpen ||
      !restaurant.isAcceptingOrders
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Restaurant is not accepting orders",
      });
    }

    const prepMinutes = Math.max(
      1,
      safeInt(
        req.body
          ?.estimatedPreparationMinutes,
        restaurant.defaultPrepTime ||
          30
      )
    );

    const result =
      await prisma.$transaction(
        async (tx) => {
          const order =
            await tx.order.findFirst({
              where: {
                id: req.params.id,
                restaurantId:
                  restaurant.id,
                status: "PLACED",
              },
              include: {
                restaurant: true,
              },
            });

          if (!order) {
            const error =
              new Error(
                "Order is not available for acceptance"
              );

            error.statusCode = 409;
            throw error;
          }

          const snapshot =
            await ensureOrderSnapshot(
              tx,
              order
            );

          return tx.order.update({
            where: {
              id: order.id,
            },
            data: {
              vendorId:
                restaurant.vendorId ||
                order.vendorId,
              status:
                "ACCEPTED_BY_VENDOR",
              acceptedAt:
                new Date(),
              estimatedPreparationMinutes:
                prepMinutes,
              history: {
                create: {
                  status:
                    "ACCEPTED_BY_VENDOR",
                  changedBy:
                    req.user.id,
                  note:
                    "Order accepted by vendor",
                },
              },
            },
            include:
              vendorOrderInclude,
          });
        }
      );

    const finalOrder =
      cleanOrder(result);

    emitVendorOrder(
      restaurant.id,
      result.id,
      "vendor-order-accepted",
      finalOrder
    );

    getIO()
      ?.to(
        `user-${result.userId}`
      )
      .emit(
        "order-updated",
        finalOrder
      );

    return res.json({
      success: true,
      message: "Order accepted",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Accept Order Error:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,
        message:
          error.message ||
          "Failed to accept order",
      });
  }
};

export const rejectOrderByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const reason =
      cleanOptional(
        req.body?.reason
      ) ||
      "Rejected by restaurant";

    const result =
      await prisma.$transaction(
        async (tx) => {
          const order =
            await tx.order.findFirst({
              where: {
                id: req.params.id,
                restaurantId:
                  access.restaurant.id,
                status: {
                  in: [
                    "PLACED",
                    "ACCEPTED_BY_VENDOR",
                    "PREPARING",
                  ],
                },
              },
              include: {
                paymentTransactions: {
                  where: {
                    status: "SUCCESS",
                  },
                  orderBy: {
                    createdAt: "desc",
                  },
                  take: 1,
                },
              },
            });

          if (!order) {
            const error =
              new Error(
                "Order cannot be rejected in its current state"
              );

            error.statusCode = 409;
            throw error;
          }

          const cancelled =
            await tx.order.update({
              where: {
                id: order.id,
              },
              data: {
                status: "CANCELLED",
                cancelledAt:
                  new Date(),
                cancelledBy:
                  req.user.id,
                cancelReason: reason,
                history: {
                  create: {
                    status:
                      "CANCELLED",
                    changedBy:
                      req.user.id,
                    note: reason,
                  },
                },
              },
              include:
                vendorOrderInclude,
            });

          if (
            isPrepaidMethod(
              order.paymentMethod
            ) &&
            order.paymentStatus ===
              "PAID"
          ) {
            const existingRefund =
              await tx.refund.findFirst({
                where: {
                  orderId:
                    order.id,
                  status: {
                    in: [
                      "PENDING",
                      "PROCESSING",
                      "COMPLETED",
                    ],
                  },
                },
              });

            if (!existingRefund) {
              await tx.refund.create({
                data: {
                  orderId:
                    order.id,
                  paymentTransactionId:
                    order
                      .paymentTransactions?.[0]
                      ?.id || null,
                  amount:
                    roundMoney(
                      order.totalAmount
                    ),
                  reason,
                  status:
                    "PENDING",
                },
              });
            }
          }

          return cancelled;
        }
      );

    const finalOrder =
      cleanOrder(result);

    emitVendorOrder(
      access.restaurant.id,
      result.id,
      "vendor-order-cancelled",
      finalOrder
    );

    getIO()
      ?.to(
        `user-${result.userId}`
      )
      .emit(
        "order-updated",
        finalOrder
      );

    return res.json({
      success: true,
      message:
        isPrepaidMethod(
          result.paymentMethod
        ) &&
        result.paymentStatus ===
          "PAID"
          ? "Order cancelled. Refund has been requested."
          : "Order cancelled",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Reject Order Error:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,
        message:
          error.message ||
          "Failed to reject order",
      });
  }
};

export const markOrderPreparingByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const order =
      await prisma.order.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
          status:
            "ACCEPTED_BY_VENDOR",
        },
      });

    if (!order) {
      return res.status(409).json({
        success: false,
        message:
          "Order must be accepted before preparation",
      });
    }

    const updated =
      await prisma.order.update({
        where: {
          id: order.id,
        },
        data: {
          status: "PREPARING",
          preparingAt:
            new Date(),
          history: {
            create: {
              status:
                "PREPARING",
              changedBy:
                req.user.id,
              note:
                "Restaurant started preparing order",
            },
          },
        },
        include:
          vendorOrderInclude,
      });

    const finalOrder =
      cleanOrder(updated);

    emitVendorOrder(
      access.restaurant.id,
      updated.id,
      "vendor-order-preparing",
      finalOrder
    );

    return res.json({
      success: true,
      message:
        "Order preparation started",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Preparing Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to start preparation",
    });
  }
};

export const markOrderReadyByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const order =
      await prisma.order.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
          status: {
            in: [
              "ACCEPTED_BY_VENDOR",
              "PREPARING",
            ],
          },
        },
      });

    if (!order) {
      return res.status(409).json({
        success: false,
        message:
          "Order is not in a valid state to mark ready",
      });
    }

    const updated =
      await prisma.order.update({
        where: {
          id: order.id,
        },
        data: {
          status:
            "READY_FOR_PICKUP",
          readyAt: new Date(),
          history: {
            create: {
              status:
                "READY_FOR_PICKUP",
              changedBy:
                req.user.id,
              note:
                "Order ready for rider pickup",
            },
          },
        },
        include:
          vendorOrderInclude,
      });

    const finalOrder =
      cleanOrder(updated);

    emitVendorOrder(
      access.restaurant.id,
      updated.id,
      "vendor-order-ready",
      finalOrder
    );

    getIO()?.emit(
      "new-rider-order",
      finalOrder
    );

    return res.json({
      success: true,
      message:
        "Order is ready for pickup",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Ready Order Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to mark order ready",
    });
  }
};

/* =========================
   VENDOR MENU
========================= */

export const getVendorMenu = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const items =
      await prisma.menuItem.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
          ...(req.query
            ?.vendorCategoryId
            ? {
                vendorCategoryId:
                  req.query
                    .vendorCategoryId,
              }
            : {}),
          ...(req.query
            ?.vendorSubCategoryId
            ? {
                vendorSubCategoryId:
                  req.query
                    .vendorSubCategoryId,
              }
            : {}),
        },
        include: {
          vendorCategory: true,
          vendorSubCategory: true,
          category: true,
          subCategory: true,
          addons: true,
          customizations: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    return res.json({
      success: true,
      menuItems: items.map(
        (item) => ({
          ...item,
          price:
            roundMoney(
              item.price
            ),
        })
      ),
    });
  } catch (error) {
    console.error(
      "Vendor Menu Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor menu",
    });
  }
};

export const createVendorMenuItem = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const {
      name,
      description,
      price,
      vendorCategoryId,
      vendorSubCategoryId,
      isVegetarian,
      isVeg,
      isPopular,
      isAvailable,
      isBestSeller,
      calories,
      servingInfo,
      prepTimeMin,
      spiceLevel,
      imageUrl,
    } = req.body;

    if (
      !trimValue(name) ||
      price === undefined ||
      Number.isNaN(
        Number(price)
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "name and valid price are required",
      });
    }

    if (vendorCategoryId) {
      const category =
        await prisma.vendorCategory.findFirst({
          where: {
            id: vendorCategoryId,
            restaurantId:
              access.restaurant.id,
          },
        });

      if (!category) {
        return res.status(404).json({
          success: false,
          message:
            "Vendor category not found",
        });
      }
    }

    if (vendorSubCategoryId) {
      const sub =
        await prisma.vendorSubCategory.findFirst({
          where: {
            id: vendorSubCategoryId,
            vendorCategory: {
              restaurantId:
                access.restaurant.id,
            },
          },
        });

      if (!sub) {
        return res.status(404).json({
          success: false,
          message:
            "Vendor subcategory not found",
        });
      }
    }

    const uploadedImage =
      await uploadFile(
        req,
        "vendor/menu"
      );

    const item =
      await prisma.menuItem.create({
        data: {
          restaurantId:
            access.restaurant.id,
          name: trimValue(name),
          description:
            cleanOptional(
              description
            ) || null,
          price: Number(price),
          imageUrl:
            uploadedImage ||
            imageUrl ||
            null,
          vendorCategoryId:
            vendorCategoryId ||
            null,
          vendorSubCategoryId:
            vendorSubCategoryId ||
            null,
          isVegetarian:
            boolValue(
              isVegetarian,
              false
            ),
          isVeg: boolValue(
            isVeg,
            true
          ),
          isPopular: boolValue(
            isPopular,
            false
          ),
          isAvailable:
            isAvailable === undefined
              ? true
              : boolValue(
                  isAvailable,
                  true
                ),
          isBestSeller:
            boolValue(
              isBestSeller,
              false
            ),
          calories:
            calories === undefined ||
            calories === ""
              ? null
              : safeInt(calories),
          servingInfo:
            cleanOptional(
              servingInfo
            ) || null,
          prepTimeMin:
            prepTimeMin ===
              undefined ||
            prepTimeMin === ""
              ? 20
              : Math.max(
                  1,
                  safeInt(
                    prepTimeMin,
                    20
                  )
                ),
          spiceLevel:
            spiceLevel ===
              undefined ||
            spiceLevel === ""
              ? 0
              : clamp(
                  safeInt(
                    spiceLevel,
                    0
                  ),
                  0,
                  5
                ),
        },
        include: {
          vendorCategory: true,
          vendorSubCategory: true,
          addons: true,
          customizations: true,
        },
      });

    return res.status(201).json({
      success: true,
      message:
        "Menu item created",
      menuItem: item,
    });
  } catch (error) {
    console.error(
      "Create Vendor Menu Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to create menu item",
    });
  }
};

export const updateVendorMenuItem = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const existing =
      await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message:
          "Menu item not found",
      });
    }

    const uploadedImage =
      await uploadFile(
        req,
        "vendor/menu"
      );

    const data = {
      ...(req.body?.name !==
        undefined && {
        name: trimValue(
          req.body.name
        ),
      }),
      ...(req.body?.description !==
        undefined && {
        description:
          cleanOptional(
            req.body.description
          ) || null,
      }),
      ...(req.body?.price !==
        undefined && {
        price: Number(
          req.body.price
        ),
      }),
      ...(req.body
        ?.vendorCategoryId !==
        undefined && {
        vendorCategoryId:
          req.body
            .vendorCategoryId ||
          null,
      }),
      ...(req.body
        ?.vendorSubCategoryId !==
        undefined && {
        vendorSubCategoryId:
          req.body
            .vendorSubCategoryId ||
          null,
      }),
      ...(req.body
        ?.isVegetarian !==
        undefined && {
        isVegetarian:
          boolValue(
            req.body
              .isVegetarian
          ),
      }),
      ...(req.body?.isVeg !==
        undefined && {
        isVeg: boolValue(
          req.body.isVeg
        ),
      }),
      ...(req.body?.isPopular !==
        undefined && {
        isPopular:
          boolValue(
            req.body
              .isPopular
          ),
      }),
      ...(req.body
        ?.isAvailable !==
        undefined && {
        isAvailable:
          boolValue(
            req.body
              .isAvailable
          ),
      }),
      ...(req.body
        ?.isBestSeller !==
        undefined && {
        isBestSeller:
          boolValue(
            req.body
              .isBestSeller
          ),
      }),
      ...(req.body?.calories !==
        undefined && {
        calories:
          req.body.calories ===
          ""
            ? null
            : safeInt(
                req.body
                  .calories
              ),
      }),
      ...(req.body
        ?.servingInfo !==
        undefined && {
        servingInfo:
          cleanOptional(
            req.body
              .servingInfo
          ) || null,
      }),
      ...(req.body
        ?.prepTimeMin !==
        undefined && {
        prepTimeMin:
          Math.max(
            1,
            safeInt(
              req.body
                .prepTimeMin,
              20
            )
          ),
      }),
      ...(req.body
        ?.spiceLevel !==
        undefined && {
        spiceLevel: clamp(
          safeInt(
            req.body
              .spiceLevel,
            0
          ),
          0,
          5
        ),
      }),
      ...(uploadedImage && {
        imageUrl:
          uploadedImage,
      }),
      ...(!uploadedImage &&
        req.body?.imageUrl !==
          undefined && {
          imageUrl:
            req.body.imageUrl ||
            null,
        }),
    };

    const updated =
      await prisma.menuItem.update({
        where: {
          id: existing.id,
        },
        data,
        include: {
          vendorCategory: true,
          vendorSubCategory: true,
          addons: true,
          customizations: true,
        },
      });

    return res.json({
      success: true,
      message:
        "Menu item updated",
      menuItem: updated,
    });
  } catch (error) {
    console.error(
      "Update Vendor Menu Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update menu item",
    });
  }
};

export const toggleVendorMenuItemAvailability = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const item =
      await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!item) {
      return res.status(404).json({
        success: false,
        message:
          "Menu item not found",
      });
    }

    const updated =
      await prisma.menuItem.update({
        where: {
          id: item.id,
        },
        data: {
          isAvailable:
            req.body?.isAvailable ===
            undefined
              ? !item.isAvailable
              : boolValue(
                  req.body
                    .isAvailable
                ),
        },
      });

    return res.json({
      success: true,
      message:
        updated.isAvailable
          ? "Menu item available"
          : "Menu item unavailable",
      menuItem: updated,
    });
  } catch (error) {
    console.error(
      "Toggle Vendor Menu Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update availability",
    });
  }
};

export const deleteVendorMenuItem = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const item =
      await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!item) {
      return res.status(404).json({
        success: false,
        message:
          "Menu item not found",
      });
    }

    const orderItemCount =
      await prisma.orderItem.count({
        where: {
          menuItemId: item.id,
        },
      });

    if (orderItemCount > 0) {
      const updated =
        await prisma.menuItem.update({
          where: {
            id: item.id,
          },
          data: {
            isAvailable: false,
          },
        });

      return res.json({
        success: true,
        message:
          "Item has order history, so it was disabled instead of deleted",
        menuItem: updated,
      });
    }

    await prisma.menuItem.delete({
      where: {
        id: item.id,
      },
    });

    return res.json({
      success: true,
      message:
        "Menu item deleted",
    });
  } catch (error) {
    console.error(
      "Delete Vendor Menu Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete menu item",
    });
  }
};

/* =========================
   VENDOR FINANCE
========================= */

export const getVendorFinancialSummary = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const type = String(
      req.query?.type || "monthly"
    ).toLowerCase();

    const { start, end } =
      getDateRange({
        from: req.query?.from,
        to: req.query?.to,
        type,
      });

    const orders =
      await prisma.order.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
          createdAt: {
            gte: start,
            lte: end,
          },
        },
        include: {
          restaurant: true,
          refunds: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    const summary = {
      totalOrders: orders.length,
      deliveredOrders: 0,
      cancelledOrders: 0,
      activeOrders: 0,
      paidOrders: 0,
      codOrders: 0,
      prepaidOrders: 0,
      recognizedRevenue: 0,
      commissionableAmount: 0,
      platformCommission: 0,
      vendorPayable: 0,
      refundPending: 0,
      refundedAmount: 0,
      legacySnapshotOrders: 0,
    };

    for (const order of orders) {
      if (order.status === "DELIVERED") {
        summary.deliveredOrders += 1;
      } else if (
        order.status === "CANCELLED"
      ) {
        summary.cancelledOrders += 1;
      } else {
        summary.activeOrders += 1;
      }

      if (
        order.paymentStatus === "PAID"
      ) {
        summary.paidOrders += 1;
      }

      if (
        order.paymentMethod === "COD"
      ) {
        summary.codOrders += 1;
      } else {
        summary.prepaidOrders += 1;
      }

      if (isRecognizedOrder(order)) {
        const finance =
          getOrderFinancials(order);

        summary.recognizedRevenue +=
          finance.totalAmount;

        summary.commissionableAmount +=
          finance.commissionableAmount;

        summary.platformCommission +=
          finance.platformCommission;

        summary.vendorPayable +=
          finance.vendorPayable;

        if (
          finance
            .legacyCommissionFallback
        ) {
          summary.legacySnapshotOrders +=
            1;
        }
      }

      for (const refund of
        order.refunds || []) {
        if (
          ["PENDING", "PROCESSING"].includes(
            refund.status
          )
        ) {
          summary.refundPending +=
            moneyNumber(refund.amount);
        }

        if (
          refund.status ===
          "COMPLETED"
        ) {
          summary.refundedAmount +=
            moneyNumber(refund.amount);
        }
      }
    }

    Object.keys(summary).forEach(
      (key) => {
        if (
          [
            "recognizedRevenue",
            "commissionableAmount",
            "platformCommission",
            "vendorPayable",
            "refundPending",
            "refundedAmount",
          ].includes(key)
        ) {
          summary[key] =
            roundMoney(
              summary[key]
            );
        }
      }
    );

    return res.json({
      success: true,
      period: {
        type,
        start,
        end,
      },
      summary,
      orders:
        orders.map((order) => ({
          ...cleanOrder(order),
          financials:
            getOrderFinancials(
              order
            ),
        })),
    });
  } catch (error) {
    console.error(
      "Vendor Financial Summary Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor finance summary",
    });
  }
};

export const getVendorSettlements = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 25, 100);

    const status = String(
      req.query?.status || ""
    ).toUpperCase();

    const where = {
      restaurantId:
        access.restaurant.id,
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
    };

    const [settlements, total] =
      await Promise.all([
        prisma.vendorSettlement.findMany({
          where,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                deliveredAt: true,
                paymentMethod: true,
                paymentStatus: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.vendorSettlement.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      settlements:
        settlements.map((item) => ({
          ...item,
          grossAmount:
            roundMoney(
              item.grossAmount
            ),
          commissionRate:
            item.commissionRate ===
              null
              ? null
              : roundMoney(
                  item.commissionRate
                ),
          commissionAmount:
            roundMoney(
              item.commissionAmount
            ),
          netAmount:
            roundMoney(
              item.netAmount
            ),
        })),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Settlements Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch settlements",
    });
  }
};

export const getVendorInvoices = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 20, 100);

    const status = String(
      req.query?.status || ""
    ).toUpperCase();

    const where = {
      restaurantId:
        access.restaurant.id,
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
    };

    const [invoices, total] =
      await Promise.all([
        prisma.vendorInvoice.findMany({
          where,
          include: {
            _count: {
              select: {
                items: true,
              },
            },
          },
          orderBy: {
            generatedAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.vendorInvoice.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      invoices:
        invoices.map((invoice) => ({
          ...invoice,
          grossAmount:
            roundMoney(
              invoice.grossAmount
            ),
          commissionAmount:
            roundMoney(
              invoice.commissionAmount
            ),
          taxAmount:
            roundMoney(
              invoice.taxAmount
            ),
          adjustmentAmount:
            roundMoney(
              invoice.adjustmentAmount
            ),
          netPayable:
            roundMoney(
              invoice.netPayable
            ),
        })),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Invoices Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch invoices",
    });
  }
};

export const getVendorInvoiceById = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const invoice =
      await prisma.vendorInvoice.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include: {
          items: {
            include: {
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  status: true,
                  paymentMethod: true,
                  paymentStatus: true,
                  deliveredAt: true,
                },
              },
            },
            orderBy: {
              deliveredAt: "asc",
            },
          },
          restaurant: true,
        },
      });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message:
          "Invoice not found",
      });
    }

    return res.json({
      success: true,
      invoice,
    });
  } catch (error) {
    console.error(
      "Vendor Invoice Detail Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch invoice",
    });
  }
};

export const downloadVendorInvoicePdf = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const invoice =
      await prisma.vendorInvoice.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include: {
          restaurant: true,
          items: {
            orderBy: {
              deliveredAt: "asc",
            },
          },
        },
      });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message:
          "Invoice not found",
      });
    }

    const doc =
      setupPdfResponse(
        res,
        `${invoice.invoiceNumber}.pdf`,
        "Vendor Settlement Invoice"
      );

    pdfKeyValue(
      doc,
      "Invoice",
      invoice.invoiceNumber
    );

    pdfKeyValue(
      doc,
      "Restaurant",
      invoice.restaurant.name
    );

    pdfKeyValue(
      doc,
      "Period",
      `${new Date(
        invoice.periodStart
      ).toLocaleDateString(
        "en-IN"
      )} - ${new Date(
        invoice.periodEnd
      ).toLocaleDateString(
        "en-IN"
      )}`
    );

    pdfKeyValue(
      doc,
      "Status",
      invoice.status
    );

    pdfKeyValue(
      doc,
      "Orders",
      invoice.totalOrders
    );

    pdfKeyValue(
      doc,
      "Gross",
      formatPdfMoney(
        invoice.grossAmount
      )
    );

    pdfKeyValue(
      doc,
      "Commission",
      formatPdfMoney(
        invoice.commissionAmount
      )
    );

    pdfKeyValue(
      doc,
      "Adjustment",
      formatPdfMoney(
        invoice.adjustmentAmount
      )
    );

    pdfKeyValue(
      doc,
      "Net Payable",
      formatPdfMoney(
        invoice.netPayable
      )
    );

    doc.moveDown();

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Order Breakdown");

    doc.moveDown(0.5);

    for (const item of invoice.items) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(
          `${item.orderNumber} | ${item.paymentMethod}/${item.paymentStatus} | Gross ${formatPdfMoney(
            item.grossAmount
          )} | Commission ${roundMoney(
            item.commissionRate
          )}% = ${formatPdfMoney(
            item.commissionAmount
          )} | Vendor ${formatPdfMoney(
            item.vendorPayable
          )}`
        );

      doc.moveDown(0.25);
    }

    doc.end();
  } catch (error) {
    console.error(
      "Vendor Invoice PDF Error:",
      error
    );

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message:
          "Failed to download invoice",
      });
    }
  }
};

export const getVendorRefunds = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 20, 100);

    const status = String(
      req.query?.status || ""
    ).toUpperCase();

    const where = {
      order: {
        restaurantId:
          access.restaurant.id,
      },
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
    };

    const [refunds, total] =
      await Promise.all([
        prisma.refund.findMany({
          where,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                totalAmount: true,
                paymentMethod: true,
                paymentStatus: true,
                status: true,
                cancelledAt: true,
                cancelReason: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.refund.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      refunds:
        refunds.map((refund) => ({
          ...refund,
          amount:
            roundMoney(
              refund.amount
            ),
        })),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Refunds Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch refunds",
    });
  }
};

/* =========================
   RATINGS
========================= */

export const getVendorRatings = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 20, 100);

    const [ratings, total] =
      await Promise.all([
        prisma.restaurantRating.findMany({
          where: {
            restaurantId:
              access.restaurant.id,
            isActive: true,
          },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.restaurantRating.count({
          where: {
            restaurantId:
              access.restaurant.id,
            isActive: true,
          },
        }),
      ]);

    const aggregate =
      await prisma.restaurantRating.aggregate({
        where: {
          restaurantId:
            access.restaurant.id,
          isActive: true,
        },
        _avg: {
          rating: true,
        },
      });

    return res.json({
      success: true,
      summary: {
        rating: roundMoney(
          aggregate._avg.rating
        ),
        totalRatings: total,
      },
      ratings,
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Ratings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch ratings",
    });
  }
};

/* =========================
   VENDOR NOTIFICATIONS
========================= */

export const getVendorNotifications = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 30, 100);

    const unreadOnly = boolValue(
      req.query?.unreadOnly,
      false
    );

    const where = {
      OR: [
        {
          userId: req.user.id,
        },
        {
          userId: null,
        },
      ],
      ...(unreadOnly
        ? {
            isRead: false,
          }
        : {}),
    };

    const [
      notifications,
      total,
      unreadCount,
    ] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: {
          createdAt: "desc",
        },
        skip,
        take: limit,
      }),

      prisma.notification.count({
        where,
      }),

      prisma.notification.count({
        where: {
          userId: req.user.id,
          isRead: false,
        },
      }),
    ]);

    return res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Notifications Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch notifications",
    });
  }
};

export const markVendorNotificationRead = async (
  req,
  res
) => {
  try {
    const notification =
      await prisma.notification.findFirst({
        where: {
          id: req.params.id,
          OR: [
            {
              userId:
                req.user.id,
            },
            {
              userId: null,
            },
          ],
        },
      });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message:
          "Notification not found",
      });
    }

    const updated =
      notification.userId === null
        ? notification
        : await prisma.notification.update({
            where: {
              id: notification.id,
            },
            data: {
              isRead: true,
              readAt: new Date(),
            },
          });

    return res.json({
      success: true,
      notification: updated,
    });
  } catch (error) {
    console.error(
      "Vendor Notification Read Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update notification",
    });
  }
};

export const markAllVendorNotificationsRead = async (
  req,
  res
) => {
  try {
    const result =
      await prisma.notification.updateMany({
        where: {
          userId: req.user.id,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

    return res.json({
      success: true,
      updatedCount:
        result.count,
    });
  } catch (error) {
    console.error(
      "Vendor Notifications Read All Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update notifications",
    });
  }
};

/* =========================
   VENDOR SUPPORT
========================= */

export const createVendorSupportTicket = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const subject =
      cleanOptional(
        req.body?.subject
      );

    const message =
      cleanOptional(
        req.body?.message
      );

    const orderId =
      cleanOptional(
        req.body?.orderId
      );

    const priority = String(
      req.body?.priority || "MEDIUM"
    ).toUpperCase();

    if (!subject) {
      return res.status(400).json({
        success: false,
        message:
          "Subject is required",
      });
    }

    if (
      ![
        "LOW",
        "MEDIUM",
        "HIGH",
        "URGENT",
      ].includes(priority)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid support priority",
      });
    }

    if (orderId) {
      const order =
        await prisma.order.findFirst({
          where: {
            id: orderId,
            restaurantId:
              access.restaurant.id,
          },
          select: {
            id: true,
          },
        });

      if (!order) {
        return res.status(404).json({
          success: false,
          message:
            "Linked order not found",
        });
      }
    }

    const ticket =
      await prisma.supportTicket.create({
        data: {
          userId: req.user.id,
          subject,
          message:
            message || null,
          status: "OPEN",
          priority,
          orderId:
            orderId || null,
          tags: [
            "VENDOR",
            access.restaurant.id,
          ],
          lastReplyAt: message
            ? new Date()
            : null,
        },
      });

    return res.status(201).json({
      success: true,
      message:
        "Support ticket created",
      ticket,
    });
  } catch (error) {
    console.error(
      "Create Vendor Support Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to create support ticket",
    });
  }
};

export const getVendorSupportTickets = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const tickets =
      await prisma.supportTicket.findMany({
        where: {
          userId: req.user.id,
        },
        include: {
          messages: {
            orderBy: {
              createdAt: "asc",
            },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

    return res.json({
      success: true,
      tickets,
    });
  } catch (error) {
    console.error(
      "Vendor Support Tickets Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch support tickets",
    });
  }
};

export const addVendorSupportMessage = async (
  req,
  res
) => {
  try {
    const ticket =
      await prisma.supportTicket.findFirst({
        where: {
          id: req.params.ticketId,
          userId: req.user.id,
        },
      });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message:
          "Support ticket not found",
      });
    }

    if (
      ticket.status === "CLOSED"
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Closed ticket cannot receive new messages",
      });
    }

    const uploadedImage =
      await uploadFile(
        req,
        "support/vendor"
      );

    const message =
      cleanOptional(
        req.body?.message
      );

    const imageUrl =
      uploadedImage ||
      req.body?.imageUrl ||
      null;

    if (!message && !imageUrl) {
      return res.status(400).json({
        success: false,
        message:
          "Message or image is required",
      });
    }

    const result =
      await prisma.$transaction(
        async (tx) => {
          const supportMessage =
            await tx.supportMessage.create({
              data: {
                ticketId:
                  ticket.id,
                senderId:
                  req.user.id,
                message:
                  message || "",
                imageUrl,
              },
            });

          const updatedTicket =
            await tx.supportTicket.update({
              where: {
                id: ticket.id,
              },
              data: {
                lastReplyAt:
                  new Date(),
                ...(ticket.status ===
                "RESOLVED"
                  ? {
                      status:
                        "OPEN",
                      resolvedAt:
                        null,
                    }
                  : {}),
              },
            });

          return {
            supportMessage,
            updatedTicket,
          };
        }
      );

    return res.json({
      success: true,
      message:
        "Support message sent",
      supportMessage:
        result.supportMessage,
      ticket:
        result.updatedTicket,
    });
  } catch (error) {
    console.error(
      "Vendor Support Message Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to send support message",
    });
  }
};
