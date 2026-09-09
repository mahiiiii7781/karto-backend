import crypto from "crypto";
import prisma from "../prisma.js";

const toNumber = (value) => Number(value || 0);

const round2 = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeIds = (value) => {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map((item) => String(item).trim())
        .filter(Boolean)
    ),
  ];
};

const sortIds = (ids) => normalizeIds(ids).sort();

const PLATFORM_FEE = round2(
  process.env.KARTO_PLATFORM_FEE || 5
);

const FREE_DELIVERY_MIN_ORDER = round2(
  process.env.KARTO_FREE_DELIVERY_MIN_ORDER || 99
);

const CGST_RATE = round2(
  process.env.KARTO_CGST_RATE || 2.5
);

const SGST_RATE = round2(
  process.env.KARTO_SGST_RATE || 2.5
);

const MAX_CART_ITEM_QUANTITY = Math.max(
  1,
  Number(process.env.KARTO_MAX_CART_ITEM_QUANTITY || 50)
);

const MAX_CART_TOTAL_QUANTITY = Math.max(
  MAX_CART_ITEM_QUANTITY,
  Number(process.env.KARTO_MAX_CART_TOTAL_QUANTITY || 100)
);

const getSelectedIdsFromJson = (value) => {
  if (!Array.isArray(value)) return [];

  return sortIds(
    value
      .map((item) => item?.id)
      .filter(Boolean)
  );
};

const isSameIdSet = (a = [], b = []) => {
  const first = sortIds(a);
  const second = sortIds(b);

  if (first.length !== second.length) {
    return false;
  }

  return first.every(
    (id, index) => id === second[index]
  );
};

const buildVariantKey = ({
  customizationIds = [],
  addonIds = [],
}) => {
  const raw = JSON.stringify({
    customizations: sortIds(customizationIds),
    addons: sortIds(addonIds),
  });

  return crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, 40);
};

const getCartItemVariantKey = (cartItem) => {
  if (cartItem?.variantKey) {
    return String(cartItem.variantKey);
  }

  return buildVariantKey({
    customizationIds:
      getSelectedIdsFromJson(
        cartItem?.customizationJson
      ),
    addonIds:
      getSelectedIdsFromJson(
        cartItem?.addonJson
      ),
  });
};

const isSameCartConfiguration = ({
  cartItem,
  menuItemId,
  customizationIds = [],
  addonIds = [],
}) => {
  if (
    !cartItem ||
    cartItem.menuItemId !== menuItemId
  ) {
    return false;
  }

  const expectedVariantKey = buildVariantKey({
    customizationIds,
    addonIds,
  });

  if (cartItem.variantKey) {
    return (
      String(cartItem.variantKey) ===
      expectedVariantKey
    );
  }

  const existingCustomizationIds =
    getSelectedIdsFromJson(
      cartItem.customizationJson
    );

  const existingAddonIds =
    getSelectedIdsFromJson(
      cartItem.addonJson
    );

  return (
    isSameIdSet(
      existingCustomizationIds,
      customizationIds
    ) &&
    isSameIdSet(
      existingAddonIds,
      addonIds
    )
  );
};

const sanitizeQuantity = (
  value,
  fallback = 1
) => {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.trunc(number);
};

const restaurantAvailability = (
  restaurant
) => {
  if (!restaurant) {
    return {
      available: false,
      code: "RESTAURANT_NOT_FOUND",
      message: "Restaurant not found",
    };
  }

  if (restaurant.deletedAt) {
    return {
      available: false,
      code: "RESTAURANT_UNAVAILABLE",
      message:
        "Restaurant is no longer available",
    };
  }

  /*
    KYC / verificationStatus is intentionally NOT used as an
    ordering blocker here. Ordering availability is controlled
    by the vendor's actual operational restaurant flags.
  */

  if (!restaurant.isOpen) {
    return {
      available: false,
      code: "RESTAURANT_CLOSED",
      message:
        "Restaurant is currently closed",
    };
  }

  if (restaurant.isAcceptingOrders === false) {
    return {
      available: false,
      code: "NOT_ACCEPTING_ORDERS",
      message:
        "Restaurant is temporarily not accepting orders",
    };
  }

  if (
    restaurant.busyUntil &&
    new Date(restaurant.busyUntil) >
      new Date()
  ) {
    return {
      available: false,
      code: "RESTAURANT_BUSY",
      message:
        "Restaurant is temporarily busy",
      busyUntil: restaurant.busyUntil,
    };
  }

  return {
    available: true,
    code: null,
    message: null,
    busyUntil: null,
  };
};

const getCartSummary = (
  cartItems
) => {
  const itemCount = cartItems.reduce(
    (sum, item) =>
      sum +
      Number(item.quantity || 0),
    0
  );

  const totalAmount = cartItems.reduce(
    (sum, item) =>
      sum + toNumber(item.totalPrice),
    0
  );

  return {
    itemCount,
    totalAmount: round2(totalAmount),
    total: round2(totalAmount),
  };
};

export const calculateCartPricingFromItems = (
  cartItems,
  options = {}
) => {
  const cartValue = round2(
    cartItems.reduce(
      (sum, item) =>
        sum +
        toNumber(item.totalPrice),
      0
    )
  );

  const restaurant =
    cartItems[0]?.restaurant || null;

  const deliveryFeeBeforeDiscount =
    cartItems.length
      ? cartValue >= FREE_DELIVERY_MIN_ORDER
        ? 0
        : round2(
            restaurant?.deliveryFee || 0
          )
      : 0;

  const platformFee =
    cartItems.length
      ? PLATFORM_FEE
      : 0;

  const requestedDiscount = Math.max(
    0,
    round2(options.discount || 0)
  );

  const itemDiscount = Math.min(
    requestedDiscount,
    cartValue
  );

  const freeDelivery =
    Boolean(options.freeDelivery);

  const deliveryDiscount =
    freeDelivery
      ? deliveryFeeBeforeDiscount
      : 0;

  const deliveryFee = round2(
    Math.max(
      deliveryFeeBeforeDiscount -
        deliveryDiscount,
      0
    )
  );

  const taxableAmount = round2(
    Math.max(
      cartValue - itemDiscount,
      0
    )
  );

  const cgstRate = CGST_RATE;
  const sgstRate = SGST_RATE;

  const cgst = round2(
    (taxableAmount * cgstRate) / 100
  );

  const sgst = round2(
    (taxableAmount * sgstRate) / 100
  );

  const taxAmount = round2(
    cgst + sgst
  );

  const totalDiscount = round2(
    itemDiscount + deliveryDiscount
  );

  const totalAmount = round2(
    taxableAmount +
      deliveryFee +
      platformFee +
      taxAmount
  );

  const minimumOrder = round2(
    restaurant?.minimumOrder || 0
  );

  const minimumOrderSatisfied =
    cartValue >= minimumOrder;

  const minimumOrderShortfall =
    minimumOrderSatisfied
      ? 0
      : round2(
          minimumOrder - cartValue
        );

  return {
    cartValue,
    subtotal: cartValue,

    discount: itemDiscount,
    deliveryDiscount,
    totalDiscount,

    taxableAmount,

    deliveryFeeBeforeDiscount,
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

    minimumOrder,
    minimumOrderSatisfied,
    minimumOrderShortfall,

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
  const safeQuantity = sanitizeQuantity(
    quantity,
    1
  );

  if (
    safeQuantity < 1 ||
    safeQuantity >
      MAX_CART_ITEM_QUANTITY
  ) {
    return {
      error: true,
      status: 400,
      message: `Quantity must be between 1 and ${MAX_CART_ITEM_QUANTITY}`,
    };
  }

  const safeCustomizationIds =
    normalizeIds(customizationIds);

  const safeAddonIds =
    normalizeIds(addonIds);

  const [customizations, addons] =
    await Promise.all([
      safeCustomizationIds.length
        ? prisma.menuItemCustomization.findMany({
            where: {
              id: {
                in: safeCustomizationIds,
              },
              menuItemId:
                menuItem.id,
              isActive: true,
            },
            orderBy: {
              createdAt: "asc",
            },
          })
        : [],

      safeAddonIds.length
        ? prisma.menuItemAddon.findMany({
            where: {
              id: {
                in: safeAddonIds,
              },
              menuItemId:
                menuItem.id,
              isActive: true,
            },
            orderBy: {
              createdAt: "asc",
            },
          })
        : [],
    ]);

  if (
    customizations.length !==
    safeCustomizationIds.length
  ) {
    const foundIds =
      customizations.map(
        (item) => item.id
      );

    return {
      error: true,
      status: 400,
      code:
        "INVALID_CUSTOMIZATION",
      message:
        "Invalid or inactive customization selected",
      invalidCustomizationIds:
        safeCustomizationIds.filter(
          (id) =>
            !foundIds.includes(id)
        ),
    };
  }

  if (
    addons.length !==
    safeAddonIds.length
  ) {
    const foundIds =
      addons.map(
        (item) => item.id
      );

    return {
      error: true,
      status: 400,
      code: "INVALID_ADDON",
      message:
        "Invalid or inactive addon selected",
      invalidAddonIds:
        safeAddonIds.filter(
          (id) =>
            !foundIds.includes(id)
        ),
    };
  }

  const basePrice = toNumber(
    menuItem.price
  );

  const customizationTotal =
    customizations.reduce(
      (sum, item) =>
        sum +
        toNumber(item.price),
      0
    );

  const addonTotal = addons.reduce(
    (sum, item) =>
      sum +
      toNumber(item.price),
    0
  );

  const unitPrice = round2(
    basePrice +
      customizationTotal +
      addonTotal
  );

  const totalPrice = round2(
    unitPrice * safeQuantity
  );

  const variantKey =
    buildVariantKey({
      customizationIds:
        safeCustomizationIds,
      addonIds: safeAddonIds,
    });

  return {
    error: false,

    safeQuantity,

    basePrice: round2(basePrice),
    customizationTotal:
      round2(customizationTotal),
    addonTotal: round2(addonTotal),

    unitPrice,
    totalPrice,
    variantKey,

    customizationJson:
      customizations.map(
        (item) => ({
          id: item.id,
          title: item.title,
          price: round2(
            item.price
          ),
        })
      ),

    addonJson: addons.map(
      (item) => ({
        id: item.id,
        title: item.title,
        price: round2(
          item.price
        ),
        imageUrl:
          item.imageUrl || null,
      })
    ),
  };
};

const cartItemInclude = {
  menuItem: {
    include: {
      restaurant: true,
    },
  },
  restaurant: true,
};

const getUserCartItems = async (
  userId
) => {
  return prisma.cartItem.findMany({
    where: {
      userId,
    },
    include: cartItemInclude,
    orderBy: {
      createdAt: "asc",
    },
  });
};

const revalidateCartItems = async (
  userId
) => {
  const cartItems =
    await getUserCartItems(userId);

  if (!cartItems.length) {
    return {
      cartItems: [],
      issues: [],
      pricesChanged: false,
    };
  }

  const issues = [];
  const updates = [];

  for (const cartItem of cartItems) {
    const menuItem =
      cartItem.menuItem;

    if (!menuItem) {
      issues.push({
        cartItemId:
          cartItem.id,
        code:
          "MENU_ITEM_REMOVED",
        message:
          "A cart item no longer exists",
      });
      continue;
    }

    if (!menuItem.isAvailable) {
      issues.push({
        cartItemId:
          cartItem.id,
        menuItemId:
          menuItem.id,
        code:
          "MENU_ITEM_UNAVAILABLE",
        message:
          `${menuItem.name} is no longer available`,
      });
      continue;
    }

    const availability =
      restaurantAvailability(
        menuItem.restaurant
      );

    if (!availability.available) {
      issues.push({
        cartItemId:
          cartItem.id,
        menuItemId:
          menuItem.id,
        restaurantId:
          menuItem.restaurantId,
        code:
          availability.code,
        message:
          availability.message,
        busyUntil:
          availability.busyUntil ||
          null,
      });
    }

    const customizationIds =
      getSelectedIdsFromJson(
        cartItem.customizationJson
      );

    const addonIds =
      getSelectedIdsFromJson(
        cartItem.addonJson
      );

    const pricing =
      await calculateItemPricing({
        menuItem,
        quantity:
          cartItem.quantity,
        customizationIds,
        addonIds,
      });

    if (pricing.error) {
      issues.push({
        cartItemId:
          cartItem.id,
        menuItemId:
          menuItem.id,
        code:
          pricing.code ||
          "INVALID_CONFIGURATION",
        message:
          pricing.message,
        invalidCustomizationIds:
          pricing.invalidCustomizationIds ||
          [],
        invalidAddonIds:
          pricing.invalidAddonIds ||
          [],
      });

      continue;
    }

    const currentVariantKey =
      getCartItemVariantKey(
        cartItem
      );

    const needsUpdate =
      round2(cartItem.price) !==
        pricing.unitPrice ||
      round2(
        cartItem.totalPrice
      ) !==
        pricing.totalPrice ||
      currentVariantKey !==
        pricing.variantKey ||
      !cartItem.variantKey;

    if (needsUpdate) {
      updates.push({
        id: cartItem.id,
        data: {
          price:
            pricing.unitPrice,
          totalPrice:
            pricing.totalPrice,
          variantKey:
            pricing.variantKey,
          customizationJson:
            pricing.customizationJson,
          addonJson:
            pricing.addonJson,
        },
      });
    }
  }

  if (updates.length) {
    try {
      await prisma.$transaction(
        updates.map((update) =>
          prisma.cartItem.update({
            where: {
              id: update.id,
            },
            data: update.data,
          })
        )
      );
    } catch (error) {
      /*
        A legacy cart may contain duplicate variants.
        Do not make GET /cart fail because of a
        migration-era unique collision.
      */
      console.warn(
        "Cart price refresh skipped:",
        error?.code ||
          error?.message
      );
    }
  }

  const refreshedItems =
    updates.length
      ? await getUserCartItems(
          userId
        )
      : cartItems;

  return {
    cartItems:
      refreshedItems,
    issues,
    pricesChanged:
      updates.length > 0,
  };
};

const getCartPayload = async (
  userId,
  pricingOptions = {}
) => {
  const {
    cartItems,
    issues,
    pricesChanged,
  } =
    await revalidateCartItems(
      userId
    );

  const summary =
    getCartSummary(cartItems);

  const pricing =
    calculateCartPricingFromItems(
      cartItems,
      pricingOptions
    );

  const restaurant =
    cartItems[0]?.restaurant ||
    null;

  const availability =
    cartItems.length
      ? restaurantAvailability(
          restaurant
        )
      : {
          available: true,
          code: null,
          message: null,
        };

  const quantityValid =
    summary.itemCount <=
    MAX_CART_TOTAL_QUANTITY;

  if (!quantityValid) {
    issues.push({
      code:
        "CART_QUANTITY_LIMIT",
      message: `Cart cannot contain more than ${MAX_CART_TOTAL_QUANTITY} total items`,
    });
  }

  const checkoutEligible =
    cartItems.length > 0 &&
    issues.length === 0 &&
    availability.available &&
    pricing.minimumOrderSatisfied &&
    quantityValid;

  return {
    cartItems,
    summary,
    pricing,
    issues,
    pricesChanged,
    restaurant,
    availability,
    checkoutEligible,
  };
};

const validateCouponForCart =
  async ({
    userId,
    code,
    cartItems,
    pricing,
  }) => {
    const normalizedCode =
      String(code || "")
        .trim()
        .toUpperCase();

    if (!normalizedCode) {
      return {
        valid: false,
        status: 400,
        message:
          "Coupon code is required",
      };
    }

    if (!cartItems.length) {
      return {
        valid: false,
        status: 400,
        message: "Cart is empty",
      };
    }

    const coupon =
      await prisma.coupon.findUnique({
        where: {
          code: normalizedCode,
        },
      });

    if (
      !coupon ||
      !coupon.isActive
    ) {
      return {
        valid: false,
        status: 404,
        message:
          "Coupon is invalid or inactive",
      };
    }

    const now = new Date();

    if (
      coupon.validFrom &&
      new Date(coupon.validFrom) >
        now
    ) {
      return {
        valid: false,
        status: 400,
        message:
          "Coupon is not active yet",
      };
    }

    if (
      coupon.validUntil &&
      new Date(coupon.validUntil) <
        now
    ) {
      return {
        valid: false,
        status: 400,
        message:
          "Coupon has expired",
      };
    }

    if (
      coupon.usageLimit !== null &&
      coupon.usageLimit !==
        undefined &&
      coupon.usedCount >=
        coupon.usageLimit
    ) {
      return {
        valid: false,
        status: 400,
        message:
          "Coupon usage limit reached",
      };
    }

    const restaurant =
      cartItems[0]?.restaurant;

    if (
      coupon.scope ===
        "RESTAURANT" &&
      coupon.restaurantId !==
        restaurant?.id
    ) {
      return {
        valid: false,
        status: 400,
        message:
          "Coupon is not valid for this restaurant",
      };
    }

    if (
      coupon.scope === "CITY" &&
      coupon.cityId !==
        restaurant?.cityId
    ) {
      return {
        valid: false,
        status: 400,
        message:
          "Coupon is not valid in this city",
      };
    }

    if (
      coupon.scope ===
      "FIRST_ORDER"
    ) {
      const previousOrders =
        await prisma.order.count({
          where: {
            userId,
            status: {
              not: "CANCELLED",
            },
          },
        });

      if (previousOrders > 0) {
        return {
          valid: false,
          status: 400,
          message:
            "Coupon is valid only on your first order",
        };
      }
    }

    if (
      coupon.minOrder !== null &&
      coupon.minOrder !==
        undefined &&
      pricing.cartValue <
        toNumber(coupon.minOrder)
    ) {
      return {
        valid: false,
        status: 400,
        message: `Minimum order value ₹${round2(
          coupon.minOrder
        )} required for this coupon`,
      };
    }

    if (
      coupon.perUserUsageLimit !==
        null &&
      coupon.perUserUsageLimit !==
        undefined
    ) {
      const userUsage =
        await prisma.couponRedemption.count({
          where: {
            couponId:
              coupon.id,
            userId,
          },
        });

      if (
        userUsage >=
        coupon.perUserUsageLimit
      ) {
        return {
          valid: false,
          status: 400,
          message:
            "You have already used this coupon the maximum allowed times",
        };
      }
    }

    let discount = 0;
    let freeDelivery = false;

    if (coupon.type === "FLAT") {
      discount = Math.min(
        toNumber(coupon.value),
        pricing.cartValue
      );
    }

    if (
      coupon.type === "PERCENT"
    ) {
      discount =
        (pricing.cartValue *
          toNumber(
            coupon.value
          )) /
        100;

      if (
        coupon.maxDiscount !==
          null &&
        coupon.maxDiscount !==
          undefined
      ) {
        discount = Math.min(
          discount,
          toNumber(
            coupon.maxDiscount
          )
        );
      }

      discount = Math.min(
        discount,
        pricing.cartValue
      );
    }

    if (
      coupon.type ===
      "FREE_DELIVERY"
    ) {
      freeDelivery = true;
    }

    return {
      valid: true,
      coupon,
      discount:
        round2(discount),
      freeDelivery,
    };
  };

export const getCart = async (
  req,
  res
) => {
  try {
    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.json({
      success: true,
      data: payload.cartItems,
      cartItems:
        payload.cartItems,
      pricing:
        payload.pricing,
      issues:
        payload.issues,
      pricesChanged:
        payload.pricesChanged,
      availability:
        payload.availability,
      checkoutEligible:
        payload.checkoutEligible,
      restaurant:
        payload.restaurant,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Get Cart Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load cart",
      error: error.message,
    });
  }
};

export const getCartPricing = async (
  req,
  res
) => {
  try {
    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.json({
      success: true,
      data: {
        pricing:
          payload.pricing,
        itemCount:
          payload.summary
            .itemCount,
        totalAmount:
          payload.summary
            .totalAmount,
        total:
          payload.summary.total,
        issues:
          payload.issues,
        checkoutEligible:
          payload.checkoutEligible,
        availability:
          payload.availability,
      },
      pricing:
        payload.pricing,
      issues:
        payload.issues,
      checkoutEligible:
        payload.checkoutEligible,
      availability:
        payload.availability,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Get Cart Pricing Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to calculate cart pricing",
      error: error.message,
    });
  }
};

export const getCartTotal = async (
  req,
  res
) => {
  try {
    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.json({
      success: true,
      data: payload.summary,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Get Cart Total Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to calculate cart total",
      error: error.message,
    });
  }
};

export const validateCart = async (
  req,
  res
) => {
  try {
    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.json({
      success: true,
      valid:
        payload.checkoutEligible,
      checkoutEligible:
        payload.checkoutEligible,
      issues:
        payload.issues,
      pricing:
        payload.pricing,
      availability:
        payload.availability,
      restaurant:
        payload.restaurant,
      cartItems:
        payload.cartItems,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Validate Cart Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to validate cart",
      error: error.message,
    });
  }
};

export const previewCartCoupon = async (
  req,
  res
) => {
  try {
    const code =
      req.body?.code ||
      req.query?.code;

    const payload =
      await getCartPayload(
        req.user.id
      );

    if (
      !payload.cartItems.length
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Cart is empty",
      });
    }

    const validation =
      await validateCouponForCart({
        userId:
          req.user.id,
        code,
        cartItems:
          payload.cartItems,
        pricing:
          payload.pricing,
      });

    if (!validation.valid) {
      return res
        .status(
          validation.status ||
            400
        )
        .json({
          success: false,
          message:
            validation.message,
        });
    }

    const pricing =
      calculateCartPricingFromItems(
        payload.cartItems,
        {
          discount:
            validation.discount,
          freeDelivery:
            validation.freeDelivery,
        }
      );

    return res.json({
      success: true,
      message:
        "Coupon applied successfully",
      coupon: {
        id:
          validation.coupon.id,
        code:
          validation.coupon.code,
        title:
          validation.coupon.title,
        type:
          validation.coupon.type,
        scope:
          validation.coupon.scope,
        value: round2(
          validation.coupon.value
        ),
        discount:
          validation.discount,
        freeDelivery:
          validation.freeDelivery,
      },
      pricing,
      checkoutEligible:
        payload.issues.length ===
          0 &&
        payload.availability
          .available &&
        pricing.minimumOrderSatisfied,
    });
  } catch (error) {
    console.error(
      "Preview Coupon Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to validate coupon",
      error: error.message,
    });
  }
};

export const addToCart = async (
  req,
  res
) => {
  try {
    const {
      menuItemId,
      vendorId,
      vendor_id,
      restaurantId,
      quantity = 1,
      note,
      customizationIds = [],
      addonIds = [],
    } = req.body;

    const requestedVendorId =
      vendorId || vendor_id || null;

    if (!menuItemId) {
      return res.status(400).json({
        success: false,
        message:
          "Menu item id is required",
      });
    }

    const safeQuantity =
      sanitizeQuantity(
        quantity,
        1
      );

    if (
      safeQuantity < 1 ||
      safeQuantity >
        MAX_CART_ITEM_QUANTITY
    ) {
      return res.status(400).json({
        success: false,
        message: `Quantity must be between 1 and ${MAX_CART_ITEM_QUANTITY}`,
      });
    }

    const safeCustomizationIds =
      normalizeIds(
        customizationIds
      );

    const safeAddonIds =
      normalizeIds(addonIds);

    const menuItem =
      await prisma.menuItem.findUnique({
        where: {
          id: menuItemId,
        },
        include: {
          restaurant: true,
        },
      });

    if (
      !menuItem ||
      !menuItem.isAvailable
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Menu item is not available",
      });
    }

    if (!menuItem.restaurant) {
      return res.status(404).json({
        success: false,
        message:
          "Restaurant not found",
      });
    }

    if (
      restaurantId &&
      String(restaurantId) !==
        String(menuItem.restaurantId)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid restaurant for this menu item",
        code: "RESTAURANT_MISMATCH",
      });
    }

    if (
      requestedVendorId &&
      String(requestedVendorId) !==
        String(menuItem.restaurant.vendorId)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Menu item does not belong to this vendor",
        code: "VENDOR_MISMATCH",
      });
    }

    const availability =
      restaurantAvailability(
        menuItem.restaurant
      );

    if (!availability.available) {
      return res
        .status(409)
        .json({
          success: false,
          message:
            availability.message,
          code:
            availability.code,
          busyUntil:
            availability.busyUntil ||
            null,
        });
    }

    const pricing =
      await calculateItemPricing({
        menuItem,
        quantity:
          safeQuantity,
        customizationIds:
          safeCustomizationIds,
        addonIds:
          safeAddonIds,
      });

    if (pricing.error) {
      return res
        .status(
          pricing.status ||
            400
        )
        .json({
          success: false,
          message:
            pricing.message,
          code: pricing.code,
          invalidCustomizationIds:
            pricing.invalidCustomizationIds ||
            [],
          invalidAddonIds:
            pricing.invalidAddonIds ||
            [],
        });
    }

    const existingCart =
      await prisma.cartItem.findMany({
        where: {
          userId:
            req.user.id,
        },
      });

    const otherRestaurantItem =
      existingCart.find(
        (item) =>
          item.restaurantId !==
          menuItem.restaurantId
      );

    if (otherRestaurantItem) {
      return res.status(409).json({
        success: false,
        message:
          "Cart can contain items from one restaurant only",
        error:
          "DIFFERENT_RESTAURANT",
        code:
          "DIFFERENT_RESTAURANT",
        currentRestaurantId:
          otherRestaurantItem.restaurantId,
        requestedRestaurantId:
          menuItem.restaurantId,
      });
    }

    const currentTotalQuantity =
      existingCart.reduce(
        (sum, item) =>
          sum +
          Number(
            item.quantity || 0
          ),
        0
      );

    if (
      currentTotalQuantity +
        safeQuantity >
      MAX_CART_TOTAL_QUANTITY
    ) {
      return res.status(400).json({
        success: false,
        message: `Cart cannot contain more than ${MAX_CART_TOTAL_QUANTITY} total items`,
        code:
          "CART_QUANTITY_LIMIT",
      });
    }

    const variantKey =
      pricing.variantKey;

    let cartItem;

    try {
      cartItem =
        await prisma.$transaction(
          async (tx) => {
            const existingItem =
              await tx.cartItem.findUnique({
                where: {
                  userId_menuItemId_variantKey:
                    {
                      userId:
                        req.user.id,
                      menuItemId,
                      variantKey,
                    },
                },
              });

            if (existingItem) {
              const newQuantity =
                Number(
                  existingItem.quantity ||
                    0
                ) +
                safeQuantity;

              if (
                newQuantity >
                MAX_CART_ITEM_QUANTITY
              ) {
                const error =
                  new Error(
                    `Maximum quantity for one cart item is ${MAX_CART_ITEM_QUANTITY}`
                  );

                error.statusCode =
                  400;
                error.code =
                  "ITEM_QUANTITY_LIMIT";
                throw error;
              }

              return tx.cartItem.update({
                where: {
                  id:
                    existingItem.id,
                },
                data: {
                  quantity:
                    newQuantity,
                  price:
                    pricing.unitPrice,
                  totalPrice:
                    round2(
                      pricing.unitPrice *
                        newQuantity
                    ),
                  note:
                    note !==
                    undefined
                      ? note ||
                        null
                      : existingItem.note,
                  customizationJson:
                    pricing.customizationJson,
                  addonJson:
                    pricing.addonJson,
                  variantKey,
                },
                include:
                  cartItemInclude,
              });
            }

            return tx.cartItem.create({
              data: {
                userId:
                  req.user.id,
                menuItemId,
                restaurantId:
                  menuItem.restaurantId,
                quantity:
                  safeQuantity,
                price:
                  pricing.unitPrice,
                totalPrice:
                  pricing.totalPrice,
                note:
                  note || null,
                customizationJson:
                  pricing.customizationJson,
                addonJson:
                  pricing.addonJson,
                variantKey,
              },
              include:
                cartItemInclude,
            });
          }
        );
    } catch (error) {
      if (
        error?.statusCode
      ) {
        return res
          .status(
            error.statusCode
          )
          .json({
            success: false,
            message:
              error.message,
            code:
              error.code ||
              null,
          });
      }

      /*
        Concurrent double tap can make two
        requests race on the unique variant.
        Retry as an increment instead of
        exposing a Prisma P2002 error.
      */
      if (
        error?.code === "P2002"
      ) {
        const existingItem =
          await prisma.cartItem.findUnique({
            where: {
              userId_menuItemId_variantKey:
                {
                  userId:
                    req.user.id,
                  menuItemId,
                  variantKey,
                },
            },
          });

        if (!existingItem) {
          throw error;
        }

        const newQuantity =
          Number(
            existingItem.quantity ||
              0
          ) + safeQuantity;

        if (
          newQuantity >
          MAX_CART_ITEM_QUANTITY
        ) {
          return res.status(400).json({
            success: false,
            message: `Maximum quantity for one cart item is ${MAX_CART_ITEM_QUANTITY}`,
            code:
              "ITEM_QUANTITY_LIMIT",
          });
        }

        cartItem =
          await prisma.cartItem.update({
            where: {
              id:
                existingItem.id,
            },
            data: {
              quantity:
                newQuantity,
              price:
                pricing.unitPrice,
              totalPrice:
                round2(
                  pricing.unitPrice *
                    newQuantity
                ),
              note:
                note !== undefined
                  ? note || null
                  : existingItem.note,
              customizationJson:
                pricing.customizationJson,
              addonJson:
                pricing.addonJson,
              variantKey,
            },
            include:
              cartItemInclude,
          });
      } else {
        throw error;
      }
    }

    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.status(201).json({
      success: true,
      message:
        "Item added to cart",
      data: cartItem,
      cartItem,
      cartItems:
        payload.cartItems,
      pricing:
        payload.pricing,
      issues:
        payload.issues,
      checkoutEligible:
        payload.checkoutEligible,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Add Cart Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to add item to cart",
      error: error.message,
    });
  }
};

export const updateCartItem = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const {
      quantity,
      note,
      customizationIds,
      addonIds,
    } = req.body;

    const cartItem =
      await prisma.cartItem.findFirst({
        where: {
          id,
          userId:
            req.user.id,
        },
        include:
          cartItemInclude,
      });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message:
          "Cart item not found",
      });
    }

    const safeQuantity =
      quantity === undefined
        ? Number(
            cartItem.quantity
          )
        : sanitizeQuantity(
            quantity,
            0
          );

    if (
      safeQuantity < 1 ||
      safeQuantity >
        MAX_CART_ITEM_QUANTITY
    ) {
      return res.status(400).json({
        success: false,
        message: `Quantity must be between 1 and ${MAX_CART_ITEM_QUANTITY}`,
      });
    }

    if (
      !cartItem.menuItem ||
      !cartItem.menuItem
        .isAvailable
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Menu item is no longer available",
        code:
          "MENU_ITEM_UNAVAILABLE",
      });
    }

    const availability =
      restaurantAvailability(
        cartItem.menuItem
          .restaurant
      );

    if (!availability.available) {
      return res
        .status(409)
        .json({
          success: false,
          message:
            availability.message,
          code:
            availability.code,
        });
    }

    const oldCustomizationIds =
      getSelectedIdsFromJson(
        cartItem.customizationJson
      );

    const oldAddonIds =
      getSelectedIdsFromJson(
        cartItem.addonJson
      );

    const finalCustomizationIds =
      customizationIds !== undefined
        ? normalizeIds(
            customizationIds
          )
        : oldCustomizationIds;

    const finalAddonIds =
      addonIds !== undefined
        ? normalizeIds(addonIds)
        : oldAddonIds;

    const pricing =
      await calculateItemPricing({
        menuItem:
          cartItem.menuItem,
        quantity:
          safeQuantity,
        customizationIds:
          finalCustomizationIds,
        addonIds:
          finalAddonIds,
      });

    if (pricing.error) {
      return res
        .status(
          pricing.status ||
            400
        )
        .json({
          success: false,
          message:
            pricing.message,
          code: pricing.code,
          invalidCustomizationIds:
            pricing.invalidCustomizationIds ||
            [],
          invalidAddonIds:
            pricing.invalidAddonIds ||
            [],
        });
    }

    const otherItems =
      await prisma.cartItem.findMany({
        where: {
          userId:
            req.user.id,
          id: {
            not: id,
          },
        },
      });

    const otherTotalQuantity =
      otherItems.reduce(
        (sum, item) =>
          sum +
          Number(
            item.quantity || 0
          ),
        0
      );

    if (
      otherTotalQuantity +
        safeQuantity >
      MAX_CART_TOTAL_QUANTITY
    ) {
      return res.status(400).json({
        success: false,
        message: `Cart cannot contain more than ${MAX_CART_TOTAL_QUANTITY} total items`,
        code:
          "CART_QUANTITY_LIMIT",
      });
    }

    const duplicate =
      otherItems.find(
        (item) =>
          item.menuItemId ===
            cartItem.menuItemId &&
          getCartItemVariantKey(
            item
          ) ===
            pricing.variantKey
      );

    let updatedCart;

    if (duplicate) {
      const mergedQuantity =
        Number(
          duplicate.quantity || 0
        ) + safeQuantity;

      if (
        mergedQuantity >
        MAX_CART_ITEM_QUANTITY
      ) {
        return res.status(400).json({
          success: false,
          message: `Maximum quantity for one cart variant is ${MAX_CART_ITEM_QUANTITY}`,
          code:
            "ITEM_QUANTITY_LIMIT",
        });
      }

      updatedCart =
        await prisma.$transaction(
          async (tx) => {
            const merged =
              await tx.cartItem.update({
                where: {
                  id:
                    duplicate.id,
                },
                data: {
                  quantity:
                    mergedQuantity,
                  price:
                    pricing.unitPrice,
                  totalPrice:
                    round2(
                      pricing.unitPrice *
                        mergedQuantity
                    ),
                  note:
                    note !==
                    undefined
                      ? note ||
                        null
                      : duplicate.note,
                  customizationJson:
                    pricing.customizationJson,
                  addonJson:
                    pricing.addonJson,
                  variantKey:
                    pricing.variantKey,
                },
                include:
                  cartItemInclude,
              });

            await tx.cartItem.delete({
              where: { id },
            });

            return merged;
          }
        );
    } else {
      updatedCart =
        await prisma.cartItem.update({
          where: { id },
          data: {
            quantity:
              safeQuantity,
            price:
              pricing.unitPrice,
            totalPrice:
              pricing.totalPrice,
            note:
              note !== undefined
                ? note || null
                : cartItem.note,
            customizationJson:
              pricing.customizationJson,
            addonJson:
              pricing.addonJson,
            variantKey:
              pricing.variantKey,
          },
          include:
            cartItemInclude,
        });
    }

    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.json({
      success: true,
      message: duplicate
        ? "Cart variants merged"
        : "Cart updated",
      data: updatedCart,
      cartItem:
        updatedCart,
      cartItems:
        payload.cartItems,
      pricing:
        payload.pricing,
      issues:
        payload.issues,
      checkoutEligible:
        payload.checkoutEligible,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Update Cart Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to update cart",
      error: error.message,
    });
  }
};

export const removeCartItem = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const cartItem =
      await prisma.cartItem.findFirst({
        where: {
          id,
          userId:
            req.user.id,
        },
      });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message:
          "Cart item not found",
      });
    }

    await prisma.cartItem.delete({
      where: { id },
    });

    const payload =
      await getCartPayload(
        req.user.id
      );

    return res.json({
      success: true,
      message:
        "Item removed",
      data: { id },
      removedId: id,
      cartItems:
        payload.cartItems,
      pricing:
        payload.pricing,
      issues:
        payload.issues,
      checkoutEligible:
        payload.checkoutEligible,
      ...payload.summary,
    });
  } catch (error) {
    console.error(
      "Remove Cart Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to remove cart item",
      error: error.message,
    });
  }
};

export const clearCart = async (
  req,
  res
) => {
  try {
    const result =
      await prisma.cartItem.deleteMany({
        where: {
          userId:
            req.user.id,
        },
      });

    const pricing =
      calculateCartPricingFromItems(
        []
      );

    const summary =
      getCartSummary([]);

    return res.json({
      success: true,
      message:
        "Cart cleared",
      data: true,
      removedCount:
        result.count,
      cartItems: [],
      pricing,
      issues: [],
      checkoutEligible:
        false,
      ...summary,
    });
  } catch (error) {
    console.error(
      "Clear Cart Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to clear cart",
      error: error.message,
    });
  }
};

export const replaceCartRestaurant = async (
  req,
  res
) => {
  try {
    const {
      menuItemId,
      vendorId,
      vendor_id,
      restaurantId,
      quantity = 1,
      note,
      customizationIds = [],
      addonIds = [],
    } = req.body;

    if (!menuItemId) {
      return res.status(400).json({
        success: false,
        message:
          "menuItemId is required",
      });
    }

    /*
      This endpoint is explicit so the frontend
      can show "Replace cart?" confirmation first.
      It never silently clears another restaurant.
    */
    await prisma.cartItem.deleteMany({
      where: {
        userId:
          req.user.id,
      },
    });

    req.body = {
      menuItemId,
      vendorId: vendorId || vendor_id || null,
      restaurantId,
      quantity,
      note,
      customizationIds,
      addonIds,
    };

    return addToCart(req, res);
  } catch (error) {
    console.error(
      "Replace Cart Restaurant Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to replace cart",
      error: error.message,
    });
  }
};
