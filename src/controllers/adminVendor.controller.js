import bcrypt from "bcryptjs";
import prisma from "../prisma.js";

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
      where: { code: code.toUpperCase() },
      update: { name, isActive: true },
      create: {
        name,
        code: code.toUpperCase(),
      },
    });

    return res.status(201).json({
      success: true,
      message: "City saved successfully",
      city,
    });
  } catch (error) {
    console.error("Create City Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const getCities = async (req, res) => {
  try {
    const cities = await prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      cities,
    });
  } catch (error) {
    console.error("Get Cities Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

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
      type,
      commission,
      cityId,
      categoryId,
      role = "VENDOR",
    } = req.body;

    if (!name || !ownerName || !ownerMobileNo || !phone || !email || !password || !address || !cityId) {
      return res.status(400).json({
        success: false,
        message:
          "name, ownerName, ownerMobileNo, phone, email, password, address and cityId are required",
      });
    }

    if (!["VENDOR", "ADMIN", "RIDER", "CUSTOMER"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role",
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

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { phone: ownerMobileNo }],
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
        OR: [{ email }, { phone }],
      },
    });

    if (existingRestaurant) {
      return res.status(409).json({
        success: false,
        message: "Vendor already exists with this email or phone",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: ownerName,
          email,
          phone: ownerMobileNo,
          password: hashedPassword,
          role,
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
          name,
          ownerName,
          ownerMobileNo,
          phone,
          email,
          address,
          imageUrl,
          type: type || "RESTAURANT",
          commission: Number(commission || 0),
          vendorId: user.id,
          cityId,
          categoryId: categoryId || null,
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
    const { cityId } = req.query;

    const vendors = await prisma.restaurant.findMany({
      where: cityId ? { cityId } : {},
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
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      vendors,
    });
  } catch (error) {
    console.error("Get Admin Vendors Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const updateVendorCommission = async (req, res) => {
  try {
    const { id } = req.params;
    const { commission } = req.body;

    const vendor = await prisma.restaurant.update({
      where: { id },
      data: {
        commission: Number(commission || 0),
      },
    });

    return res.json({
      success: true,
      message: "Commission updated successfully",
      vendor,
    });
  } catch (error) {
    console.error("Update Commission Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};