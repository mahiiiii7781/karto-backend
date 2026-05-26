import prisma from "../prisma.js";

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

    const totalAmount = cartItems.reduce(
      (sum, item) => sum + Number(item.totalPrice),
      0
    );

    res.json({
      success: true,
      data: cartItems,
      totalAmount,
    });
  } catch (error) {
    console.error("Get Cart Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const addToCart = async (req, res) => {
  try {
    const { menuItemId, quantity = 1, note } = req.body;

    if (!menuItemId) {
      return res.status(400).json({
        success: false,
        message: "Menu item id is required",
      });
    }

    const menuItem = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      include: { restaurant: true },
    });

    if (!menuItem || !menuItem.isAvailable) {
      return res.status(404).json({
        success: false,
        message: "Menu item not available",
      });
    }

    const existingCart = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
    });

    const otherRestaurantItem = existingCart.find(
      (item) => item.restaurantId !== menuItem.restaurantId
    );

    if (otherRestaurantItem) {
      return res.status(400).json({
        success: false,
        message: "Cart can contain items from one restaurant only",
      });
    }

    const safeQuantity = Number(quantity) || 1;
    const price = Number(menuItem.price);
    const totalPrice = price * safeQuantity;

    const cartItem = await prisma.cartItem.upsert({
      where: {
        userId_menuItemId: {
          userId: req.user.id,
          menuItemId,
        },
      },
      update: {
        quantity: { increment: safeQuantity },
        totalPrice: { increment: totalPrice },
        note,
      },
      create: {
        userId: req.user.id,
        menuItemId,
        restaurantId: menuItem.restaurantId,
        quantity: safeQuantity,
        price,
        totalPrice,
        note,
      },
      include: {
        menuItem: true,
        restaurant: true,
      },
    });

    res.status(201).json({
      success: true,
      message: "Item added to cart",
      data: cartItem,
    });
  } catch (error) {
    console.error("Add Cart Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const updateCartItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

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
    });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    const updatedCart = await prisma.cartItem.update({
      where: { id },
      data: {
        quantity: safeQuantity,
        totalPrice: Number(cartItem.price) * safeQuantity,
      },
      include: {
        menuItem: true,
        restaurant: true,
      },
    });

    res.json({
      success: true,
      message: "Cart updated",
      data: updatedCart,
    });
  } catch (error) {
    console.error("Update Cart Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
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

    res.json({
      success: true,
      message: "Item removed",
      data: { id },
    });
  } catch (error) {
    console.error("Remove Cart Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const clearCart = async (req, res) => {
  try {
    await prisma.cartItem.deleteMany({
      where: { userId: req.user.id },
    });

    res.json({
      success: true,
      message: "Cart cleared",
      data: true,
    });
  } catch (error) {
    console.error("Clear Cart Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};