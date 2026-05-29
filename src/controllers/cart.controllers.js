import prisma from "../prisma.js";

const toNumber = value => Number(value || 0);

const normalizeIds = value => {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean);
};

const getCartSummary = cartItems => {
  const itemCount = cartItems.reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );

  const totalAmount = cartItems.reduce(
    (sum, item) => sum + toNumber(item.totalPrice),
    0
  );

  return {
    itemCount,
    totalAmount,
    total: totalAmount,
  };
};

const calculateItemPricing = async ({
  menuItem,
  quantity,
  customizationIds = [],
  addonIds = [],
}) => {
  const safeQuantity = Math.max(1, Number(quantity) || 1);

  const customizations = customizationIds.length
    ? await prisma.menuItemCustomization.findMany({
        where: {
          id: { in: customizationIds },
          menuItemId: menuItem.id,
          isActive: true,
        },
      })
    : [];

  const addons = addonIds.length
    ? await prisma.menuItemAddon.findMany({
        where: {
          id: { in: addonIds },
          menuItemId: menuItem.id,
          isActive: true,
        },
      })
    : [];

  const basePrice = toNumber(menuItem.price);

  const customizationTotal = customizations.reduce(
    (sum, item) => sum + toNumber(item.price),
    0
  );

  const addonTotal = addons.reduce(
    (sum, item) => sum + toNumber(item.price),
    0
  );

  const unitPrice = basePrice + customizationTotal + addonTotal;
  const totalPrice = unitPrice * safeQuantity;

  return {
    safeQuantity,
    unitPrice,
    totalPrice,
    customizationJson: customizations.map(item => ({
      id: item.id,
      title: item.title,
      price: toNumber(item.price),
    })),
    addonJson: addons.map(item => ({
      id: item.id,
      title: item.title,
      price: toNumber(item.price),
      imageUrl: item.imageUrl || null,
    })),
  };
};

export const getCart = async (req, res) => {
  try {
    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: {
        menuItem: true,
        restaurant: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const summary = getCartSummary(cartItems);

    return res.json({
      success: true,
      data: cartItems,
      cartItems,
      ...summary,
    });
  } catch (error) {
    console.error("Get Cart Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getCartTotal = async (req, res) => {
  try {
    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      select: {
        quantity: true,
        totalPrice: true,
      },
    });

    const summary = getCartSummary(cartItems);

    return res.json({
      success: true,
      data: summary,
      ...summary,
    });
  } catch (error) {
    console.error("Get Cart Total Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const addToCart = async (req, res) => {
  try {
    const {
      menuItemId,
      restaurantId,
      quantity = 1,
      note,
      customizationIds = [],
      addonIds = [],
    } = req.body;

    if (!menuItemId) {
      return res.status(400).json({
        success: false,
        message: "Menu item id is required",
      });
    }

    const menuItem = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      include: {
        restaurant: true,
      },
    });

    if (!menuItem || !menuItem.isAvailable) {
      return res.status(404).json({
        success: false,
        message: "Menu item not available",
      });
    }

    if (restaurantId && restaurantId !== menuItem.restaurantId) {
      return res.status(400).json({
        success: false,
        message: "Invalid restaurant for this menu item",
      });
    }

    if (!menuItem.restaurant?.isOpen) {
      return res.status(400).json({
        success: false,
        message: "Store is currently closed",
      });
    }

    const existingCart = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
    });

    const otherRestaurantItem = existingCart.find(
      item => item.restaurantId !== menuItem.restaurantId
    );

    if (otherRestaurantItem) {
      return res.status(400).json({
        success: false,
        message: "Cart can contain items from one restaurant only",
        error: "DIFFERENT_RESTAURANT",
      });
    }

    const pricing = await calculateItemPricing({
      menuItem,
      quantity,
      customizationIds: normalizeIds(customizationIds),
      addonIds: normalizeIds(addonIds),
    });

    const existingItem = await prisma.cartItem.findUnique({
      where: {
        userId_menuItemId: {
          userId: req.user.id,
          menuItemId,
        },
      },
    });

    let cartItem;

    if (existingItem) {
      const newQuantity = Number(existingItem.quantity || 0) + pricing.safeQuantity;

      cartItem = await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQuantity,
          price: pricing.unitPrice,
          totalPrice: pricing.unitPrice * newQuantity,
          note: note ?? existingItem.note,
          customizationJson: pricing.customizationJson,
          addonJson: pricing.addonJson,
        },
        include: {
          menuItem: true,
          restaurant: true,
        },
      });
    } else {
      cartItem = await prisma.cartItem.create({
        data: {
          userId: req.user.id,
          menuItemId,
          restaurantId: menuItem.restaurantId,
          quantity: pricing.safeQuantity,
          price: pricing.unitPrice,
          totalPrice: pricing.totalPrice,
          note: note || null,
          customizationJson: pricing.customizationJson,
          addonJson: pricing.addonJson,
        },
        include: {
          menuItem: true,
          restaurant: true,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: "Item added to cart",
      data: cartItem,
      cartItem,
    });
  } catch (error) {
    console.error("Add Cart Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateCartItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, note, customizationIds, addonIds } = req.body;

    const safeQuantity = Number(quantity);

    if (!safeQuantity || safeQuantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be at least 1",
      });
    }

    const cartItem = await prisma.cartItem.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
      include: {
        menuItem: true,
      },
    });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    const oldCustomizationIds = Array.isArray(cartItem.customizationJson)
      ? cartItem.customizationJson.map(item => item.id).filter(Boolean)
      : [];

    const oldAddonIds = Array.isArray(cartItem.addonJson)
      ? cartItem.addonJson.map(item => item.id).filter(Boolean)
      : [];

    const pricing = await calculateItemPricing({
      menuItem: cartItem.menuItem,
      quantity: safeQuantity,
      customizationIds:
        customizationIds !== undefined
          ? normalizeIds(customizationIds)
          : oldCustomizationIds,
      addonIds:
        addonIds !== undefined ? normalizeIds(addonIds) : oldAddonIds,
    });

    const updatedCart = await prisma.cartItem.update({
      where: { id },
      data: {
        quantity: safeQuantity,
        price: pricing.unitPrice,
        totalPrice: pricing.totalPrice,
        note: note !== undefined ? note : cartItem.note,
        customizationJson: pricing.customizationJson,
        addonJson: pricing.addonJson,
      },
      include: {
        menuItem: true,
        restaurant: true,
      },
    });

    return res.json({
      success: true,
      message: "Cart updated",
      data: updatedCart,
      cartItem: updatedCart,
    });
  } catch (error) {
    console.error("Update Cart Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const removeCartItem = async (req, res) => {
  try {
    const { id } = req.params;

    const cartItem = await prisma.cartItem.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    await prisma.cartItem.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Item removed",
      data: { id },
    });
  } catch (error) {
    console.error("Remove Cart Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const clearCart = async (req, res) => {
  try {
    await prisma.cartItem.deleteMany({
      where: { userId: req.user.id },
    });

    return res.json({
      success: true,
      message: "Cart cleared",
      data: true,
    });
  } catch (error) {
    console.error("Clear Cart Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};