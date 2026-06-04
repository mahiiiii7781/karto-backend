import prisma from "../prisma.js";
import { emitOrderStatus } from "../config/socket.js";

const ACTIVE_STATUSES = [
  "PLACED",
  "ACCEPTED_BY_VENDOR",
  "PREPARING",
  "READY_FOR_PICKUP",
  "ASSIGNED_TO_RIDER",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

const toNumber = value => Number(value || 0);

const getDateRange = () => {
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const last7Days = new Date(now);
  last7Days.setDate(now.getDate() - 6);
  last7Days.setHours(0, 0, 0, 0);

  return { todayStart, monthStart, last7Days };
};

const getVendorRestaurantIds = async vendorId => {
  const restaurants = await prisma.restaurant.findMany({
    where: { vendorId },
    select: { id: true },
  });

  return restaurants.map(r => r.id);
};

const getPrimaryRestaurant = async vendorId => {
  return prisma.restaurant.findFirst({
    where: { vendorId },
    orderBy: { createdAt: "asc" },
  });
};

const dayNameToNumber = value => {
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  if (!value || String(value).toLowerCase() === "none") return null;

  return map[String(value).toLowerCase()] ?? null;
};

/* =========================
   PUBLIC APIs
========================= */

export const getCategories = async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      data: categories,
      categories,
    });
  } catch (error) {
    console.error("Categories Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendors = async (req, res) => {
  try {
    const { cityId, categoryId, type } = req.query;

    const where = {
      isOpen: true,
      ...(cityId && { cityId }),
      ...(categoryId && { categoryId }),
      ...(type && { type }),
    };

    const vendors = await prisma.restaurant.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        menuItems: {
          where: { isAvailable: true },
          take: 5,
          orderBy: [
            { isBestSeller: "desc" },
            { isPopular: "desc" },
            { createdAt: "desc" },
          ],
        },
      },
      orderBy: [
        { isFeatured: "desc" },
        { rating: "desc" },
        { createdAt: "desc" },
      ],
    });

    return res.json({
      success: true,
      data: vendors,
      vendors,
    });
  } catch (error) {
    console.error("Get Vendors Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorById = async (req, res) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        ratings: {
          where: { isActive: true },
          take: 5,
          orderBy: { createdAt: "desc" },
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
        menuItems: {
          where: { isAvailable: true },
          include: {
            addons: { where: { isActive: true } },
            customizations: { where: { isActive: true } },
            reviews: {
              where: { isActive: true },
              take: 3,
              orderBy: { createdAt: "desc" },
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
          orderBy: [
            { isBestSeller: "desc" },
            { isPopular: "desc" },
            { createdAt: "desc" },
          ],
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    return res.json({
      success: true,
      data: vendor,
      vendor,
    });
  } catch (error) {
    console.error("Get Vendor By Id Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   DASHBOARD
========================= */

export const getVendorDashboard = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { todayStart, monthStart } = getDateRange();

    const restaurants = await prisma.restaurant.findMany({
      where: { vendorId },
      include: {
        orders: true,
        menuItems: true,
        timings: true,
      },
    });

    const restaurantIds = restaurants.map(r => r.id);

    const todayOrders = await prisma.order.findMany({
      where: {
        vendorId,
        createdAt: { gte: todayStart },
      },
    });

    const monthlyOrders = await prisma.order.findMany({
      where: {
        vendorId,
        createdAt: { gte: monthStart },
      },
    });

    const activeOrders = await prisma.order.count({
      where: {
        vendorId,
        status: { in: ACTIVE_STATUSES },
      },
    });

    const deliveredOrders = await prisma.order.findMany({
      where: {
        vendorId,
        status: "DELIVERED",
      },
    });

    const cancelledOrders = await prisma.order.count({
      where: {
        vendorId,
        status: "CANCELLED",
      },
    });

    const recentOrders = await prisma.order.findMany({
      where: { vendorId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
        restaurant: true,
        address: true,
        items: {
          include: { menuItem: true },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const totalOrders = restaurants.reduce(
      (sum, r) => sum + r.orders.length,
      0
    );

    const totalMenuItems = restaurants.reduce(
      (sum, r) => sum + r.menuItems.length,
      0
    );

    const todayRevenue = todayOrders.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const monthlyRevenue = monthlyOrders.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const lifetimeRevenue = deliveredOrders.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const averageOrderValue =
      monthlyOrders.length > 0 ? monthlyRevenue / monthlyOrders.length : 0;

    return res.json({
      success: true,
      data: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        todayOrders: todayOrders.length,
        todayRevenue,
        monthlyOrders: monthlyOrders.length,
        monthlyRevenue,
        lifetimeRevenue,
        activeOrders,
        completedOrders: deliveredOrders.length,
        cancelledOrders,
        averageOrderValue,
        restaurants,
        restaurantIds,
        recentOrders,
      },
      dashboard: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        revenue: lifetimeRevenue,
        restaurants,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   ORDERS
========================= */

export const getVendorOrders = async (req, res) => {
  try {
    const { status } = req.query;

    const where = {
      vendorId: req.user.id,
      ...(status && { status }),
    };

    const orders = await prisma.order.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
        restaurant: true,
        address: true,
        items: {
          include: { menuItem: true },
          orderBy: { createdAt: "asc" },
        },
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        history: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      data: orders,
      orders,
    });
  } catch (error) {
    console.error("Vendor Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateVendorOrderStatus = async (req, res) => {
  try {
    const { orderId, id } = req.params;
    const finalOrderId = orderId || id;

    const { status, note, estimatedPreparationMinutes } = req.body;

    const allowedVendorStatuses = [
      "ACCEPTED_BY_VENDOR",
      "PREPARING",
      "READY_FOR_PICKUP",
      "CANCELLED",
    ];

    if (!allowedVendorStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor order status",
      });
    }

    const existingOrder = await prisma.order.findFirst({
      where: {
        id: finalOrderId,
        vendorId: req.user.id,
      },
      include: { restaurant: true },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    const updateData = { status };

    if (status === "ACCEPTED_BY_VENDOR") {
      updateData.acceptedAt = new Date();
      updateData.estimatedPreparationMinutes =
        Number(estimatedPreparationMinutes) ||
        existingOrder.estimatedPreparationMinutes ||
        30;
    }

    if (status === "PREPARING") {
      updateData.preparingAt = new Date();
    }

    if (status === "READY_FOR_PICKUP") {
      updateData.readyAt = new Date();
    }

    if (status === "CANCELLED") {
      updateData.cancelledAt = new Date();
      updateData.cancelReason = note || "Cancelled by vendor";
      updateData.cancelledBy = req.user.id;
    }

    const order = await prisma.$transaction(async tx => {
      const updated = await tx.order.update({
        where: { id: finalOrderId },
        data: updateData,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
            },
          },
          restaurant: true,
          address: true,
          items: {
            include: { menuItem: true },
            orderBy: { createdAt: "asc" },
          },
          rider: {
            select: {
              id: true,
              fullName: true,
              phone: true,
            },
          },
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: finalOrderId,
          status,
          changedBy: req.user.id,
          note: note || `Vendor updated order to ${status}`,
        },
      });

      return updated;
    });

    emitOrderStatus(finalOrderId, status, { order });

    return res.json({
      success: true,
      message: "Order status updated",
      data: order,
      order,
    });
  } catch (error) {
    console.error("Vendor Update Order Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updatePreparationTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { estimatedPreparationMinutes } = req.body;

    const minutes = Number(estimatedPreparationMinutes);

    if (!minutes || minutes < 5 || minutes > 120) {
      return res.status(400).json({
        success: false,
        message: "Preparation time must be between 5 and 120 minutes",
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        id,
        vendorId: req.user.id,
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { estimatedPreparationMinutes: minutes },
    });

    return res.json({
      success: true,
      message: "Preparation time updated",
      data: updated,
      order: updated,
    });
  } catch (error) {
    console.error("Update Prep Time Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   VENDOR MENU
========================= */

export const getVendorMenu = async (req, res) => {
  try {
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const items = await prisma.menuItem.findMany({
      where: {
        restaurantId: { in: restaurantIds },
      },
      include: {
        category: true,
        subCategory: true,
        vendorCategory: true,
        vendorSubCategory: true,
      },
      orderBy: [
        { isBestSeller: "desc" },
        { isPopular: "desc" },
        { createdAt: "desc" },
      ],
    });

    return res.json({
      success: true,
      data: items,
      items,
      menuItems: items,
    });
  } catch (error) {
    console.error("Get Vendor Menu Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const createVendorMenuItem = async (req, res) => {
  try {
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "No restaurant found for this vendor",
      });
    }

    const {
      name,
      description,
      price,
      imageUrl,
      isVeg,
      isVegetarian,
      isPopular,
      isBestSeller,
      isAvailable,
      prepTimeMin,
      categoryId,
      subCategoryId,
      vendorCategoryId,
      vendorSubCategoryId,
    } = req.body;

    if (!name || !price) {
      return res.status(400).json({
        success: false,
        message: "Name and price are required",
      });
    }

    const item = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        name: String(name).trim(),
        description: description || null,
        price: Number(price),
        imageUrl: imageUrl || null,
        isVeg: isVeg === undefined ? true : Boolean(isVeg),
        isVegetarian:
          isVegetarian === undefined
            ? isVeg === undefined
              ? true
              : Boolean(isVeg)
            : Boolean(isVegetarian),
        isPopular: Boolean(isPopular),
        isBestSeller: Boolean(isBestSeller),
        isAvailable: isAvailable === undefined ? true : Boolean(isAvailable),
        prepTimeMin: Number(prepTimeMin) || 20,
        categoryId: categoryId || null,
        subCategoryId: subCategoryId || null,
        vendorCategoryId: vendorCategoryId || null,
        vendorSubCategoryId: vendorSubCategoryId || null,
      },
      include: {
        category: true,
        subCategory: true,
        vendorCategory: true,
        vendorSubCategory: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Menu item created",
      data: item,
      item,
    });
  } catch (error) {
    console.error("Create Vendor Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateVendorMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.menuItem.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const allowedFields = [
      "name",
      "description",
      "price",
      "imageUrl",
      "isVeg",
      "isVegetarian",
      "isPopular",
      "isBestSeller",
      "isAvailable",
      "prepTimeMin",
      "categoryId",
      "subCategoryId",
      "vendorCategoryId",
      "vendorSubCategoryId",
    ];

    const data = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    }

    if (data.price !== undefined) data.price = Number(data.price);
    if (data.prepTimeMin !== undefined) {
      data.prepTimeMin = Number(data.prepTimeMin) || 20;
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data,
      include: {
        category: true,
        subCategory: true,
        vendorCategory: true,
        vendorSubCategory: true,
      },
    });

    return res.json({
      success: true,
      message: "Menu item updated",
      data: updated,
      item: updated,
    });
  } catch (error) {
    console.error("Update Vendor Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const deleteVendorMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.menuItem.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    await prisma.menuItem.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Menu item deleted",
    });
  } catch (error) {
    console.error("Delete Vendor Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message:
        "Unable to delete this item. It may already be linked with orders.",
      error: error.message,
    });
  }
};

/* =========================
   VENDOR CATEGORIES
========================= */

export const getVendorCategories = async (req, res) => {
  try {
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const categories = await prisma.vendorCategory.findMany({
      where: {
        restaurantId: { in: restaurantIds },
      },
      include: {
        subCategories: true,
        menuItems: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      data: categories,
      categories,
      vendorCategories: categories,
    });
  } catch (error) {
    console.error("Get Vendor Categories Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const createVendorCategory = async (req, res) => {
  try {
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "No restaurant found for this vendor",
      });
    }

    const { name, description, imageUrl, isActive } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const category = await prisma.vendorCategory.create({
      data: {
        restaurantId: restaurant.id,
        name: String(name).trim(),
        description: description || null,
        imageUrl: imageUrl || null,
        isActive: isActive === undefined ? true : Boolean(isActive),
      },
      include: {
        subCategories: true,
        menuItems: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Category created",
      data: category,
      category,
    });
  } catch (error) {
    console.error("Create Vendor Category Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateVendorCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.vendorCategory.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const { name, description, imageUrl, isActive } = req.body;

    const category = await prisma.vendorCategory.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(description !== undefined && { description }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
      include: {
        subCategories: true,
        menuItems: true,
      },
    });

    return res.json({
      success: true,
      message: "Category updated",
      data: category,
      category,
    });
  } catch (error) {
    console.error("Update Vendor Category Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const deleteVendorCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.vendorCategory.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
      include: {
        menuItems: true,
        subCategories: true,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    if (existing.menuItems.length > 0 || existing.subCategories.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete category with menu items or subcategories. Pause it instead.",
      });
    }

    await prisma.vendorCategory.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Category deleted",
    });
  } catch (error) {
    console.error("Delete Vendor Category Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   VENDOR SETTINGS
========================= */

export const updateVendorSettings = async (req, res) => {
  try {
    const { id } = req.params;

    const restaurant = id
      ? await prisma.restaurant.findFirst({
          where: { id, vendorId: req.user.id },
        })
      : await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
    }

    const {
      name,
      phone,
      address,
      deliveryTime,
      minimumOrder,
      isOpen,
      isAcceptingOrders,
      defaultPrepTime,
      openingTime,
      closingTime,
      weeklyOffDay,
    } = req.body;

    const data = {};

    if (name !== undefined) data.name = String(name).trim();
    if (phone !== undefined) data.phone = String(phone).trim();
    if (address !== undefined) data.address = String(address).trim();
    if (deliveryTime !== undefined) data.deliveryTime = String(deliveryTime);
    if (minimumOrder !== undefined) data.minimumOrder = Number(minimumOrder);
    if (isOpen !== undefined) data.isOpen = Boolean(isOpen);
    if (isAcceptingOrders !== undefined)
      data.isAcceptingOrders = Boolean(isAcceptingOrders);
    if (defaultPrepTime !== undefined)
      data.defaultPrepTime = Number(defaultPrepTime) || 30;
    if (openingTime !== undefined) data.openingTime = String(openingTime);
    if (closingTime !== undefined) data.closingTime = String(closingTime);
    if (weeklyOffDay !== undefined) data.weeklyOffDay = String(weeklyOffDay);

    const updated = await prisma.restaurant.update({
      where: { id: restaurant.id },
      data,
      include: { timings: true },
    });

    if (openingTime && closingTime) {
      const weeklyOff = dayNameToNumber(weeklyOffDay);

      for (let day = 0; day <= 6; day++) {
        await prisma.restaurantTiming.upsert({
          where: {
            restaurantId_dayOfWeek: {
              restaurantId: restaurant.id,
              dayOfWeek: day,
            },
          },
          update: {
            openTime: String(openingTime),
            closeTime: String(closingTime),
            isClosed: weeklyOff === day,
          },
          create: {
            restaurantId: restaurant.id,
            dayOfWeek: day,
            openTime: String(openingTime),
            closeTime: String(closingTime),
            isClosed: weeklyOff === day,
          },
        });
      }
    }

    const finalRestaurant = await prisma.restaurant.findUnique({
      where: { id: restaurant.id },
      include: { timings: true },
    });

    return res.json({
      success: true,
      message: "Vendor settings updated",
      data: finalRestaurant || updated,
      restaurant: finalRestaurant || updated,
    });
  } catch (error) {
    console.error("Update Vendor Settings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const setVendorBusyMode = async (req, res) => {
  try {
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
    }

    const minutes = Number(req.body.minutes || 30);

    if (!minutes || minutes < 5 || minutes > 180) {
      return res.status(400).json({
        success: false,
        message: "Busy time must be between 5 and 180 minutes",
      });
    }

    const busyUntil = new Date(Date.now() + minutes * 60 * 1000);

    const updated = await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        isOpen: false,
        isAcceptingOrders: false,
        busyUntil,
      },
    });

    return res.json({
      success: true,
      message: `Busy mode enabled for ${minutes} minutes`,
      data: {
        restaurant: updated,
        busyUntil,
        busyMinutes: minutes,
      },
    });
  } catch (error) {
    console.error("Vendor Busy Mode Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   PAYMENTS
========================= */

export const getVendorPayments = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const settlements = await prisma.vendorSettlement.findMany({
      where: { vendorId },
      include: {
        restaurant: true,
        order: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const pendingAmount = settlements
      .filter(s => s.status === "PENDING")
      .reduce((sum, s) => sum + toNumber(s.netAmount), 0);

    const paidAmount = settlements
      .filter(s => s.status === "PAID")
      .reduce((sum, s) => sum + toNumber(s.netAmount), 0);

    const grossEarnings = settlements.reduce(
      (sum, s) => sum + toNumber(s.grossAmount),
      0
    );

    const platformFee = settlements.reduce(
      (sum, s) => sum + toNumber(s.commissionAmount),
      0
    );

    const netPayable = settlements.reduce(
      (sum, s) => sum + toNumber(s.netAmount),
      0
    );

    return res.json({
      success: true,
      data: {
        grossEarnings,
        platformFee,
        netPayable,
        pendingAmount,
        paidAmount,
        settlements,
      },
    });
  } catch (error) {
    console.error("Vendor Payments Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   GRAPH
========================= */

export const getVendorEarningsGraph = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { last7Days } = getDateRange();

    const restaurantIds = await getVendorRestaurantIds(vendorId);

    const orders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        createdAt: { gte: last7Days },
        status: { not: "CANCELLED" },
      },
      select: {
        createdAt: true,
        totalAmount: true,
      },
    });

    const result = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(last7Days);
      date.setDate(last7Days.getDate() + i);

      const key = date.toISOString().slice(0, 10);

      const total = orders
        .filter(o => o.createdAt.toISOString().slice(0, 10) === key)
        .reduce((sum, o) => sum + toNumber(o.totalAmount), 0);

      result.push({
        date: key,
        label: date.toLocaleDateString("en-IN", {
          weekday: "short",
        }),
        earnings: total,
      });
    }

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Graph Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};
export const getAvailableRidersForVendor = async (req, res) => {
  try {
    const riders = await prisma.user.findMany({
      where: {
        role: "RIDER",
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const mappedRiders = riders.map(rider => ({
      id: rider.id,
      fullName: rider.fullName,
      phone: rider.phone,
      email: rider.email,
      avatarUrl: rider.avatarUrl,
      isAvailable: true,
      currentStatus: "AVAILABLE",
    }));

    return res.json({
      success: true,
      data: mappedRiders,
      riders: mappedRiders,
    });
  } catch (error) {
    console.error("Get Available Riders Error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const assignVendorOrderRider = async (req, res) => {
  try {
    const { id } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({
        success: false,
        message: "Rider id is required",
      });
    }

    const existingOrder = await prisma.order.findFirst({
      where: {
        id,
        vendorId: req.user.id,
      },
      include: {
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    if (
      existingOrder.status !== "READY_FOR_PICKUP" &&
      existingOrder.status !== "ASSIGNED_TO_RIDER"
    ) {
      return res.status(400).json({
        success: false,
        message: "Rider can be assigned only after order is ready",
      });
    }

    const rider = await prisma.user.findFirst({
      where: {
        id: riderId,
        role: "RIDER",
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
      },
    });

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Rider not found",
      });
    }

    const order = await prisma.$transaction(async tx => {
      const updated = await tx.order.update({
        where: { id },
        data: {
          riderId,
          status: "ASSIGNED_TO_RIDER",
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
            },
          },
          restaurant: true,
          address: true,
          rider: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
            },
          },
          items: {
            include: {
              menuItem: true,
            },
            orderBy: {
              createdAt: "asc",
            },
          },
          history: {
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: "ASSIGNED_TO_RIDER",
          changedBy: req.user.id,
          note: existingOrder.riderId
            ? `Rider reassigned to ${rider.fullName || rider.phone || rider.id}`
            : `Rider assigned to ${rider.fullName || rider.phone || rider.id}`,
        },
      });

      return updated;
    });

    emitOrderStatus(id, "ASSIGNED_TO_RIDER", {
      order,
      rider,
      assignedBy: req.user.id,
    });

    return res.json({
      success: true,
      message: existingOrder.riderId
        ? "Rider reassigned successfully"
        : "Rider assigned successfully",
      data: order,
      order,
    });
  } catch (error) {
    console.error("Assign Vendor Order Rider Error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};
export default {
  getCategories,
  getVendors,
  getVendorById,

  getVendorDashboard,
  getVendorOrders,
  updateVendorOrderStatus,
  updatePreparationTime,
getAvailableRidersForVendor,
assignVendorOrderRider,
  getVendorMenu,
  createVendorMenuItem,
  updateVendorMenuItem,
  deleteVendorMenuItem,

  getVendorCategories,
  createVendorCategory,
  updateVendorCategory,
  deleteVendorCategory,

  updateVendorSettings,
  setVendorBusyMode,

  getVendorPayments,
  getVendorEarningsGraph,
};