import prisma from "../prisma.js";

const toNumber = value => Number(value || 0);

const round2 = value =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeIds = value => {
  if (!Array.isArray(value)) return [];

  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
};

const sortIds = ids => normalizeIds(ids).sort();

const PLATFORM_FEE = round2(process.env.KARTO_PLATFORM_FEE || 5);
const CGST_RATE = round2(process.env.KARTO_CGST_RATE || 2.5);
const SGST_RATE = round2(process.env.KARTO_SGST_RATE || 2.5);

const getSelectedIdsFromJson = value => {
  if (!Array.isArray(value)) return [];

  return sortIds(value.map(item => item?.id).filter(Boolean));
};

const isSameIdSet = (a = [], b = []) => {
  const first = sortIds(a);
  const second = sortIds(b);

  if (first.length !== second.length) return false;

  return first.every((id, index) => id === second[index]);
};

const isSameCartConfiguration = ({
  cartItem,
  menuItemId,
  customizationIds = [],
  addonIds = [],
}) => {
  if (!cartItem || cartItem.menuItemId !== menuItemId) return false;

  const existingCustomizationIds = getSelectedIdsFromJson(
    cartItem.customizationJson
  );

  const existingAddonIds = getSelectedIdsFromJson(cartItem.addonJson);

  return (
    isSameIdSet(existingCustomizationIds, customizationIds) &&
    isSameIdSet(existingAddonIds, addonIds)
  );
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
    totalAmount: round2(totalAmount),
    total: round2(totalAmount),
  };
};

export const calculateCartPricingFromItems = cartItems => {
  const cartValue = round2(
    cartItems.reduce((sum, item) => sum + toNumber(item.totalPrice), 0)
  );

  const restaurant = cartItems[0]?.restaurant || null;

  const deliveryFee = cartItems.length
    ? round2(restaurant?.deliveryFee || 0)
    : 0;

  const platformFee = cartItems.length ? PLATFORM_FEE : 0;

  const cgstRate = CGST_RATE;
  const sgstRate = SGST_RATE;

  const cgst = round2((cartValue * cgstRate) / 100);
  const sgst = round2((cartValue * sgstRate) / 100);
  const taxAmount = round2(cgst + sgst);

  const totalAmount = round2(cartValue + deliveryFee + platformFee + taxAmount);

  return {
    cartValue,
    subtotal: cartValue,
    deliveryFee,
    platformFee,
    tax: {
      cgstRate,
      sgstRate,
      cgst,
      sgst,
      total: taxAmount,
    },
    taxAmount,
    totalAmount,
    grandTotal: totalAmount,
  };
};

const calculateItemPricing = async ({
  menuItem,
  quantity,
  customizationIds = [],
  addonIds = [],
}) => {
  const safeQuantity = Math.max(1, Number(quantity) || 1);
  const safeCustomizationIds = normalizeIds(customizationIds);
  const safeAddonIds = normalizeIds(addonIds);

  const customizations = safeCustomizationIds.length
    ? await prisma.menuItemCustomization.findMany({
        where: {
          id: { in: safeCustomizationIds },
          menuItemId: menuItem.id,
          isActive: true,
        },
      })
    : [];

  const addons = safeAddonIds.length
    ? await prisma.menuItemAddon.findMany({
        where: {
          id: { in: safeAddonIds },
          menuItemId: menuItem.id,
          isActive: true,
        },
      })
    : [];

  if (customizations.length !== safeCustomizationIds.length) {
    const foundIds = customizations.map(item => item.id);

    return {
      error: true,
      status: 400,
      message: "Invalid or inactive customization selected",
      invalidCustomizationIds: safeCustomizationIds.filter(
        id => !foundIds.includes(id)
      ),
    };
  }

  if (addons.length !== safeAddonIds.length) {
    const foundIds = addons.map(item => item.id);

    return {
      error: true,
      status: 400,
      message: "Invalid or inactive addon selected",
      invalidAddonIds: safeAddonIds.filter(id => !foundIds.includes(id)),
    };
  }

  const basePrice = toNumber(menuItem.price);

  const customizationTotal = customizations.reduce(
    (sum, item) => sum + toNumber(item.price),
    0
  );

  const addonTotal = addons.reduce(
    (sum, item) => sum + toNumber(item.price),
    0
  );

  const unitPrice = round2(basePrice + customizationTotal + addonTotal);
  const totalPrice = round2(unitPrice * safeQuantity);

  return {
    error: false,
    safeQuantity,
    unitPrice,
    totalPrice,
    customizationJson: customizations.map(item => ({
      id: item.id,
      title: item.title,
      price: round2(item.price),
    })),
    addonJson: addons.map(item => ({
      id: item.id,
      title: item.title,
      price: round2(item.price),
      imageUrl: item.imageUrl || null,
    })),
  };
};

const getUserCartItems = async userId => {
  return prisma.cartItem.findMany({
    where: { userId },
    include: {
      menuItem: true,
      restaurant: true,
    },
    orderBy: { createdAt: "asc" },
  });
};

const getCartPayload = async userId => {
  const cartItems = await getUserCartItems(userId);
  const summary = getCartSummary(cartItems);
  const pricing = calculateCartPricingFromItems(cartItems);

  return {
    cartItems,
    summary,
    pricing,
  };
};

export const getCart = async (req, res) => {
  try {
    const { cartItems, summary, pricing } = await getCartPayload(req.user.id);

    return res.json({
      success: true,
      data: cartItems,
      cartItems,
      pricing,
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

export const getCartPricing = async (req, res) => {
  try {
    const { summary, pricing } = await getCartPayload(req.user.id);

    return res.json({
      success: true,
      data: {
        pricing,
        itemCount: summary.itemCount,
        totalAmount: summary.totalAmount,
        total: summary.total,
      },
      pricing,
      itemCount: summary.itemCount,
      totalAmount: summary.totalAmount,
      total: summary.total,
    });
  } catch (error) {
    console.error("Get Cart Pricing Error:", error);
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

    const safeCustomizationIds = normalizeIds(customizationIds);
    const safeAddonIds = normalizeIds(addonIds);

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

    if (!menuItem.restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
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
      customizationIds: safeCustomizationIds,
      addonIds: safeAddonIds,
    });

    if (pricing.error) {
      return res.status(pricing.status || 400).json({
        success: false,
        message: pricing.message,
        invalidCustomizationIds: pricing.invalidCustomizationIds || [],
        invalidAddonIds: pricing.invalidAddonIds || [],
      });
    }

    const existingItem = existingCart.find(item =>
      isSameCartConfiguration({
        cartItem: item,
        menuItemId,
        customizationIds: safeCustomizationIds,
        addonIds: safeAddonIds,
      })
    );

    let cartItem;

    if (existingItem) {
      const newQuantity =
        Number(existingItem.quantity || 0) + pricing.safeQuantity;

      cartItem = await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQuantity,
          price: pricing.unitPrice,
          totalPrice: round2(pricing.unitPrice * newQuantity),
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

    const { cartItems, summary, pricing: cartPricing } = await getCartPayload(
      req.user.id
    );

    return res.status(201).json({
      success: true,
      message: "Item added to cart",
      data: cartItem,
      cartItem,
      cartItems,
      pricing: cartPricing,
      ...summary,
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
        menuItem: {
          include: {
            restaurant: true,
          },
        },
        restaurant: true,
      },
    });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    if (!cartItem.menuItem || !cartItem.menuItem.isAvailable) {
      return res.status(400).json({
        success: false,
        message: "Menu item is no longer available",
      });
    }

    if (!cartItem.menuItem.restaurant?.isOpen) {
      return res.status(400).json({
        success: false,
        message: "Store is currently closed",
      });
    }

    const oldCustomizationIds = Array.isArray(cartItem.customizationJson)
      ? cartItem.customizationJson.map(item => item.id).filter(Boolean)
      : [];

    const oldAddonIds = Array.isArray(cartItem.addonJson)
      ? cartItem.addonJson.map(item => item.id).filter(Boolean)
      : [];

    const finalCustomizationIds =
      customizationIds !== undefined
        ? normalizeIds(customizationIds)
        : normalizeIds(oldCustomizationIds);

    const finalAddonIds =
      addonIds !== undefined ? normalizeIds(addonIds) : normalizeIds(oldAddonIds);

    const pricing = await calculateItemPricing({
      menuItem: cartItem.menuItem,
      quantity: safeQuantity,
      customizationIds: finalCustomizationIds,
      addonIds: finalAddonIds,
    });

    if (pricing.error) {
      return res.status(pricing.status || 400).json({
        success: false,
        message: pricing.message,
        invalidCustomizationIds: pricing.invalidCustomizationIds || [],
        invalidAddonIds: pricing.invalidAddonIds || [],
      });
    }

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

    const { cartItems, summary, pricing: cartPricing } = await getCartPayload(
      req.user.id
    );

    return res.json({
      success: true,
      message: "Cart updated",
      data: updatedCart,
      cartItem: updatedCart,
      cartItems,
      pricing: cartPricing,
      ...summary,
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

    const { cartItems, summary, pricing } = await getCartPayload(req.user.id);

    return res.json({
      success: true,
      message: "Item removed",
      data: { id },
      removedId: id,
      cartItems,
      pricing,
      ...summary,
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

    const pricing = calculateCartPricingFromItems([]);
    const summary = getCartSummary([]);

    return res.json({
      success: true,
      message: "Cart cleared",
      data: true,
      cartItems: [],
      pricing,
      ...summary,
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