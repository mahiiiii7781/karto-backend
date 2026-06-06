import bcrypt from "bcryptjs";
import prisma from "../prisma.js";

const boolValue = (value) => {
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
};

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const trimValue = (value) => String(value || "").trim();

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
          imageUrl: imageUrl || null,
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
    const { cityId, categoryId } = req.query;

    const vendors = await prisma.restaurant.findMany({
      where: {
        ...(cityId && cityId !== "ALL" ? { cityId } : {}),
        ...(categoryId && categoryId !== "ALL" ? { categoryId } : {}),
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
        orders: true,
        menuItems: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const data = vendors.map((vendor) => {
      const totalOrders = vendor.orders?.length || 0;
      const totalMenuItems = vendor.menuItems?.length || 0;
      const totalRevenue = (vendor.orders || []).reduce(
        (sum, order) => sum + Number(order.totalAmount || 0),
        0
      );
      const kartoIncome = (totalRevenue * Number(vendor.commission || 0)) / 100;
      const vendorIncome = totalRevenue - kartoIncome;

      return {
        ...vendor,
        totalOrders,
        totalMenuItems,
        totalRevenue,
        kartoIncome,
        vendorIncome,
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
      message: error.message || "Something went wrong",
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
          ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
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