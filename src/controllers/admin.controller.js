import bcrypt from "bcryptjs";
import prisma from "../prisma.js";
import { emitOrderStatus } from "../config/socket.js";

const allowedRoles = ["CUSTOMER", "VENDOR", "RIDER", "ADMIN"];

const moneyNumber = (value) => Number(value || 0);

const fileUrl = (req) => {
  if (!req.file) return undefined;
  return `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
};

const calcIncome = (orders = []) => {
  let totalRevenue = 0;
  let kartoIncome = 0;
  let vendorIncome = 0;

  for (const order of orders) {
    const amount = moneyNumber(order.totalAmount);
    const commission = moneyNumber(order.restaurant?.commission);
    const adminCut = (amount * commission) / 100;

    totalRevenue += amount;
    kartoIncome += adminCut;
    vendorIncome += amount - adminCut;
  }

  return { totalRevenue, kartoIncome, vendorIncome };
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
          user: { select: { id: true, fullName: true, email: true, phone: true } },
          restaurant: { include: { city: true } },
          rider: { select: { id: true, fullName: true, phone: true } },
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
        OR: [{ email: email.trim().toLowerCase() }, phone ? { phone } : undefined].filter(Boolean),
      },
    });

    if (existing) {
      return res.status(409).json({ success: false, message: "Email or phone already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone || null,
        password: hashedPassword,
        avatarUrl: avatarUrl || null,
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

    return res.json({ success: true, message: "User role updated", user, data: user });
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
      data: { isActive: Boolean(isActive) },
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
      update: { name: name.trim(), isActive: true },
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
    const cities = await prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });

    return res.json({ success: true, cities, data: cities });
  } catch (error) {
    console.error("Get Cities Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   VENDOR CREATE + LIST
========================= */

export const createVendorByAdmin = async (req, res) => {
  try {
    const {
      cityId,
      categoryId,
      name,
      ownerName,
      ownerMobileNo,
      phone,
      email,
      password,
      address,
      type = "RESTAURANT",
      commission = 0,
      role = "VENDOR",
    } = req.body;

    const imageUrl = fileUrl(req) || req.body.imageUrl || null;

    if (!cityId || !name || !ownerName || !ownerMobileNo || !phone || !email || !password || !address) {
      return res.status(400).json({
        success: false,
        message: "cityId, name, ownerName, ownerMobileNo, phone, email, password and address are required",
      });
    }

    if (role !== "VENDOR") {
      return res.status(400).json({ success: false, message: "Vendor create role must be VENDOR" });
    }

    const city = await prisma.city.findUnique({ where: { id: cityId } });

    if (!city) {
      return res.status(404).json({ success: false, message: "City not found" });
    }

    if (categoryId) {
      const category = await prisma.category.findUnique({ where: { id: categoryId } });
      if (!category) {
        return res.status(404).json({ success: false, message: "Category not found" });
      }
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.trim().toLowerCase() },
          { phone: ownerMobileNo.trim() },
        ],
      },
    });

    if (existingUser) {
      return res.status(409).json({ success: false, message: "Vendor user already exists" });
    }

    const existingRestaurant = await prisma.restaurant.findFirst({
      where: {
        OR: [{ email: email.trim().toLowerCase() }, { phone: phone.trim() }],
      },
    });

    if (existingRestaurant) {
      return res.status(409).json({ success: false, message: "Vendor restaurant already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const vendorUser = await tx.user.create({
        data: {
          fullName: ownerName.trim(),
          email: email.trim().toLowerCase(),
          phone: ownerMobileNo.trim(),
          password: hashedPassword,
          role: "VENDOR",
          avatarUrl: imageUrl,
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
          vendorId: vendorUser.id,
          cityId,
          categoryId: categoryId || null,

          name: name.trim(),
          ownerName: ownerName.trim(),
          ownerMobileNo: ownerMobileNo.trim(),
          phone: phone.trim(),
          email: email.trim().toLowerCase(),
          address: address.trim(),
          imageUrl,
          type,
          commission: Number(commission || 0),

          isActive: true,
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
          orders: true,
          menuItems: true,
        },
      });

      return { user: vendorUser, vendor };
    });

    return res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      data: result,
    });
  } catch (error) {
    console.error("Create Vendor Error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
        category: true,
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

    return res.json({ success: true, vendors: data, data });
  } catch (error) {
    console.error("Get Admin Vendors Error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
      data: { isActive: Boolean(isActive) },
    });

    return res.json({
      success: true,
      message: restaurant.isActive ? "Vendor activated" : "Vendor blocked",
      restaurant,
      data: restaurant,
    });
  } catch (error) {
    console.error("Restaurant Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   RIDER CREATE + LIST
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
    } = req.body;

    const avatarUrl = fileUrl(req) || req.body.avatarUrl || null;

    if (!cityId || !fullName || !email || !password || !phone || !vehicleNo || !address) {
      return res.status(400).json({
        success: false,
        message: "cityId, fullName, email, password, phone, vehicleNo and address are required",
      });
    }

    if (role !== "RIDER") {
      return res.status(400).json({ success: false, message: "Rider create role must be RIDER" });
    }

    const city = await prisma.city.findUnique({ where: { id: cityId } });

    if (!city) {
      return res.status(404).json({ success: false, message: "City not found" });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: email.trim().toLowerCase() }, { phone: phone.trim() }],
      },
    });

    if (existing) {
      return res.status(409).json({ success: false, message: "Rider already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const rider = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        password: hashedPassword,
        avatarUrl,
        role: "RIDER",
        isActive: true,

        // These fields require schema support.
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
        ...(cityId ? { cityId } : {}),
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
      const totalDeliveryFee = delivered.reduce((sum, o) => sum + moneyNumber(o.deliveryFee), 0);

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

/* =========================
   CATEGORIES
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
    const { name, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const category = await prisma.category.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        imageUrl: fileUrl(req) || null,
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
    const { name, description } = req.body;

    const updateData = {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
    };

    const image = fileUrl(req);
    if (image) updateData.imageUrl = image;

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
    return res.json({ success: true, message: "Category deleted successfully" });
  } catch (error) {
    console.error("Delete Category Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   PRODUCT SUBCATEGORIES
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

    return res.json({ success: true, subCategories, data: subCategories });
  } catch (error) {
    console.error("Get Subcategories Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createSubCategory = async (req, res) => {
  try {
    const { categoryId, name, description } = req.body;

    if (!categoryId || !name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category and subcategory name are required",
      });
    }

    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const subCategory = await prisma.productSubCategory.create({
      data: {
        categoryId,
        name: name.trim(),
        description: description?.trim() || null,
        imageUrl: fileUrl(req) || null,
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
    const { categoryId, name, description } = req.body;

    const updateData = {
      ...(categoryId !== undefined && { categoryId }),
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
    };

    const image = fileUrl(req);
    if (image) updateData.imageUrl = image;

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
    await prisma.productSubCategory.delete({ where: { id: req.params.id } });
    return res.json({ success: true, message: "Subcategory deleted successfully" });
  } catch (error) {
    console.error("Delete Subcategory Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================
   MENU ITEMS
========================= */

/* =========================
   MENU ITEMS
========================= */

const parseJsonArray = value => {
  if (!value) return [];

  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const boolValue = value => {
  if (typeof value === "boolean") return value;
  return String(value) === "true";
};

export const getAdminMenuItems = async (req, res) => {
  try {
    const { restaurantId, categoryId, subCategoryId } = req.query;

    const menuItems = await prisma.menuItem.findMany({
      where: {
        ...(restaurantId && restaurantId !== "ALL" ? { restaurantId } : {}),
        ...(categoryId && categoryId !== "ALL" ? { categoryId } : {}),
        ...(subCategoryId && subCategoryId !== "ALL" ? { subCategoryId } : {}),
      },
      include: {
        restaurant: true,
        category: true,
        subCategory: true,
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
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, menuItems, data: menuItems });
  } catch (error) {
    console.error("Get Admin Menu Items Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createMenuItem = async (req, res) => {
  try {
    const {
      restaurantId,
      categoryId,
      subCategoryId,

      name,
      description,
      price,

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
    } = req.body;

    if (!restaurantId || !name?.trim() || price === undefined) {
      return res.status(400).json({
        success: false,
        message: "Vendor, product name and price are required",
      });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
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

    if (subCategoryId) {
      const subCategory = await prisma.productSubCategory.findUnique({
        where: { id: subCategoryId },
      });

      if (!subCategory) {
        return res.status(404).json({
          success: false,
          message: "Subcategory not found",
        });
      }
    }

    const finalAddons = parseJsonArray(addons);
    const finalCustomizations = parseJsonArray(customizations);

    const menuItem = await prisma.menuItem.create({
      data: {
        restaurantId,
        categoryId: categoryId || null,
        subCategoryId: subCategoryId || null,

        name: name.trim(),
        description: description?.trim() || null,
        price: Number(price),

        imageUrl: fileUrl(req) || req.body.imageUrl || null,

        isVegetarian: boolValue(isVegetarian || isVeg),
        isVeg: boolValue(isVeg || isVegetarian),
        isPopular: boolValue(isPopular),
        isBestSeller: boolValue(isBestSeller),
        isAvailable: String(isAvailable) !== "false",

        calories: calories ? Number(calories) : null,
        servingInfo: servingInfo?.trim() || null,
        prepTimeMin: prepTimeMin ? Number(prepTimeMin) : 20,
        spiceLevel: spiceLevel ? Number(spiceLevel) : 0,

        addons: {
          create: finalAddons
            .filter(a => a?.title)
            .map(a => ({
              title: String(a.title).trim(),
              price: Number(a.price || 0),
              imageUrl: a.imageUrl || null,
              isActive: a.isActive === undefined ? true : Boolean(a.isActive),
            })),
        },

        customizations: {
          create: finalCustomizations
            .filter(c => c?.title)
            .map(c => ({
              title: String(c.title).trim(),
              price: Number(c.price || 0),
              isRequired: Boolean(c.isRequired),
              isActive: c.isActive === undefined ? true : Boolean(c.isActive),
            })),
        },
      },
      include: {
        restaurant: true,
        category: true,
        subCategory: true,
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMenuItem = async (req, res) => {
  try {
    const {
      categoryId,
      subCategoryId,

      name,
      description,
      price,

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
    } = req.body;

    const updateData = {
      ...(categoryId !== undefined && { categoryId: categoryId || null }),
      ...(subCategoryId !== undefined && { subCategoryId: subCategoryId || null }),

      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && {
        description: description?.trim() || null,
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
        isAvailable: String(isAvailable) !== "false",
      }),

      ...(calories !== undefined && {
        calories: calories ? Number(calories) : null,
      }),
      ...(servingInfo !== undefined && {
        servingInfo: servingInfo?.trim() || null,
      }),
      ...(prepTimeMin !== undefined && {
        prepTimeMin: prepTimeMin ? Number(prepTimeMin) : 20,
      }),
      ...(spiceLevel !== undefined && {
        spiceLevel: spiceLevel ? Number(spiceLevel) : 0,
      }),
    };

    const image = fileUrl(req);
    if (image) updateData.imageUrl = image;

    const finalAddons = parseJsonArray(addons);
    const finalCustomizations = parseJsonArray(customizations);

    const menuItem = await prisma.$transaction(async tx => {
      const updated = await tx.menuItem.update({
        where: { id: req.params.id },
        data: updateData,
      });

      if (addons !== undefined) {
        await tx.menuItemAddon.deleteMany({
          where: { menuItemId: req.params.id },
        });

        if (finalAddons.length) {
          await tx.menuItemAddon.createMany({
            data: finalAddons
              .filter(a => a?.title)
              .map(a => ({
                menuItemId: req.params.id,
                title: String(a.title).trim(),
                price: Number(a.price || 0),
                imageUrl: a.imageUrl || null,
                isActive: a.isActive === undefined ? true : Boolean(a.isActive),
              })),
          });
        }
      }

      if (customizations !== undefined) {
        await tx.menuItemCustomization.deleteMany({
          where: { menuItemId: req.params.id },
        });

        if (finalCustomizations.length) {
          await tx.menuItemCustomization.createMany({
            data: finalCustomizations
              .filter(c => c?.title)
              .map(c => ({
                menuItemId: req.params.id,
                title: String(c.title).trim(),
                price: Number(c.price || 0),
                isRequired: Boolean(c.isRequired),
                isActive: c.isActive === undefined ? true : Boolean(c.isActive),
              })),
          });
        }
      }

      return tx.menuItem.findUnique({
        where: { id: req.params.id },
        include: {
          restaurant: true,
          category: true,
          subCategory: true,
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteMenuItem = async (req, res) => {
  try {
    await prisma.menuItem.delete({ where: { id: req.params.id } });

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
    const { title, price, imageUrl, isActive = true } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Addon title is required",
      });
    }

    const addon = await prisma.menuItemAddon.create({
      data: {
        menuItemId,
        title: title.trim(),
        price: Number(price || 0),
        imageUrl: fileUrl(req) || imageUrl || null,
        isActive: Boolean(isActive),
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
    const { title, price, imageUrl, isActive } = req.body;

    const updateData = {
      ...(title !== undefined && { title: title.trim() }),
      ...(price !== undefined && { price: Number(price || 0) }),
      ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
      ...(isActive !== undefined && { isActive: Boolean(isActive) }),
    };

    const image = fileUrl(req);
    if (image) updateData.imageUrl = image;

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
    const { title, price, isRequired = false, isActive = true } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Customization title is required",
      });
    }

    const customization = await prisma.menuItemCustomization.create({
      data: {
        menuItemId,
        title: title.trim(),
        price: Number(price || 0),
        isRequired: Boolean(isRequired),
        isActive: Boolean(isActive),
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
    const { title, price, isRequired, isActive } = req.body;

    const customization = await prisma.menuItemCustomization.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        ...(price !== undefined && { price: Number(price || 0) }),
        ...(isRequired !== undefined && { isRequired: Boolean(isRequired) }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
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
    if (vendorId) where.vendorId = vendorId;
    if (cityId) where.restaurant = { cityId };

    const orders = await prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, email: true, phone: true } },
        restaurant: { include: { city: true, vendor: true } },
        rider: { select: { id: true, fullName: true, email: true, phone: true } },
        address: true,
        items: { include: { menuItem: true } },
        history: { orderBy: { createdAt: "asc" } },
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
    const { id } = req.params;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: true,
        restaurant: { include: { city: true, vendor: true } },
        rider: true,
        address: true,
        items: { include: { menuItem: true } },
        history: { orderBy: { createdAt: "asc" } },
        riderLocations: { orderBy: { updatedAt: "desc" }, take: 1 },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
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

    const timeFieldMap = {
  ACCEPTED_BY_VENDOR: "acceptedAt",
  PREPARING: "preparingAt",
  READY_FOR_PICKUP: "readyAt",
  PICKED_UP: "pickedAt",
  DELIVERED: "deliveredAt",
  CANCELLED: "cancelledAt",
};

    const updateData = { status };

    if (timeFieldMap[status]) updateData[timeFieldMap[status]] = new Date();

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: updateData,
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
          status,
          changedBy: req.user.id,
          note: note || `Admin updated status to ${status}`,
        },
      });

      return updated;
    });

    emitOrderStatus(id, status, { order });

    return res.json({
      success: true,
      message: "Order status updated",
      order,
      data: order,
    });
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
      return res.status(400).json({ success: false, message: "riderId is required" });
    }

    const rider = await prisma.user.findFirst({
      where: { id: riderId, role: "RIDER", isActive: true },
    });

    if (!rider) {
      return res.status(404).json({ success: false, message: "Active rider not found" });
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
   BILLING
========================= */

export const getRiderBilling = async (req, res) => {
  try {
    const { id } = req.params;
    const { type = "daily" } = req.query;

    const start = new Date();

    if (type === "monthly") {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setHours(0, 0, 0, 0);
    }

    const orders = await prisma.order.findMany({
      where: {
        riderId: id,
        status: "DELIVERED",
        deliveredAt: { gte: start },
      },
      orderBy: { deliveredAt: "desc" },
    });

    const deliveryEarnings = orders.reduce((sum, o) => sum + moneyNumber(o.deliveryFee), 0);
    const bonus = orders.length >= 20 ? 100 : 0;
    const deductions = 0;
    const payable = deliveryEarnings + bonus - deductions;

    return res.json({
      success: true,
      data: {
        riderId: id,
        type,
        deliveredOrders: orders.length,
        deliveryEarnings,
        bonus,
        deductions,
        payable,
        orders,
      },
    });
  } catch (error) {
    console.error("Rider Billing Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getMonthlyBilling = async (req, res) => {
  try {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const deliveredOrders = await prisma.order.findMany({
      where: {
        status: "DELIVERED",
        deliveredAt: { gte: start },
      },
      include: { restaurant: true },
    });

    const income = calcIncome(deliveredOrders);
    const deliveryFees = deliveredOrders.reduce((sum, o) => sum + moneyNumber(o.deliveryFee), 0);

    return res.json({
      success: true,
      data: {
        monthStart: start,
        totalDeliveredOrders: deliveredOrders.length,
        totalRevenue: income.totalRevenue,
        platformCommission: income.kartoIncome,
        vendorPayable: income.vendorIncome,
        riderPayable: deliveryFees,
        orders: deliveredOrders,
      },
    });
  } catch (error) {
    console.error("Monthly Billing Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
