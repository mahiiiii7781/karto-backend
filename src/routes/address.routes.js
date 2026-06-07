import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

const cleanString = (value) =>
  value === undefined || value === null ? undefined : String(value).trim();

const parseLatLng = (value) => {
  if (value === undefined || value === null || value === "") return null;

  const num = Number(value);

  if (Number.isNaN(num)) return null;

  return num;
};

const boolValue = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  const normalized = String(value).trim().toLowerCase();

  return ["true", "1", "yes", "y", "on", "default"].includes(normalized);
};

const validateLatLng = ({ latitude, longitude }) => {
  const lat = parseLatLng(latitude);
  const lng = parseLatLng(longitude);

  if (latitude !== undefined && latitude !== null && latitude !== "" && lat === null) {
    return "Invalid latitude";
  }

  if (longitude !== undefined && longitude !== null && longitude !== "" && lng === null) {
    return "Invalid longitude";
  }

  if (lat !== null && (lat < -90 || lat > 90)) {
    return "Latitude must be between -90 and 90";
  }

  if (lng !== null && (lng < -180 || lng > 180)) {
    return "Longitude must be between -180 and 180";
  }

  return null;
};

const validateAddressPayload = ({ label, address, latitude, longitude }) => {
  if (!label || !String(label).trim()) {
    return "Address label is required";
  }

  if (!address || !String(address).trim()) {
    return "Address is required";
  }

  if (String(address).trim().length < 8) {
    return "Please enter a complete address";
  }

  return validateLatLng({ latitude, longitude });
};

const getAddressList = async (userId) => {
  return prisma.userAddress.findMany({
    where: {
      userId,
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
};

// GET all addresses
router.get("/", protect, async (req, res) => {
  try {
    const addresses = await getAddressList(req.user.id);

    return res.json({
      success: true,
      data: addresses,
      addresses,
      count: addresses.length,
    });
  } catch (error) {
    console.error("Get Address Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// GET default address
router.get("/default", protect, async (req, res) => {
  try {
    let address = await prisma.userAddress.findFirst({
      where: {
        userId: req.user.id,
        isDefault: true,
      },
    });

    if (!address) {
      address = await prisma.userAddress.findFirst({
        where: {
          userId: req.user.id,
        },
        orderBy: {
          createdAt: "desc",
        },
      });
    }

    return res.json({
      success: true,
      data: address,
      address,
    });
  } catch (error) {
    console.error("Get Default Address Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// ADD address
router.post("/", protect, async (req, res) => {
  try {
    const {
      label,
      address,
      landmark,
      city,
      state,
      pincode,
      country = "India",
      latitude,
      longitude,
      isDefault,
    } = req.body;

    const validationMessage = validateAddressPayload({
      label,
      address,
      latitude,
      longitude,
    });

    if (validationMessage) {
      return res.status(400).json({
        success: false,
        message: validationMessage,
      });
    }

    const count = await prisma.userAddress.count({
      where: {
        userId: req.user.id,
      },
    });

    if (count >= 10) {
      return res.status(400).json({
        success: false,
        message: "You can save maximum 10 addresses",
      });
    }

    const shouldSetDefault = count === 0 || boolValue(isDefault);

    const newAddress = await prisma.$transaction(async (tx) => {
      if (shouldSetDefault) {
        await tx.userAddress.updateMany({
          where: {
            userId: req.user.id,
          },
          data: {
            isDefault: false,
          },
        });
      }

      return tx.userAddress.create({
        data: {
          userId: req.user.id,
          label: cleanString(label),
          address: cleanString(address),
          landmark: landmark ? cleanString(landmark) : null,
          city: city ? cleanString(city) : null,
          ...(state !== undefined && { state: state ? cleanString(state) : null }),
          ...(pincode !== undefined && {
            pincode: pincode ? cleanString(pincode) : null,
          }),
          country: cleanString(country) || "India",
          latitude: parseLatLng(latitude),
          longitude: parseLatLng(longitude),
          isDefault: shouldSetDefault,
        },
      });
    });

    const addresses = await getAddressList(req.user.id);

    return res.status(201).json({
      success: true,
      message: "Address added successfully",
      data: newAddress,
      address: newAddress,
      addresses,
    });
  } catch (error) {
    console.error("Add Address Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// UPDATE address
router.patch("/:id", protect, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.userAddress.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    const {
      label,
      address,
      landmark,
      city,
      state,
      pincode,
      country,
      latitude,
      longitude,
      isDefault,
    } = req.body;

    const nextLabel = label !== undefined ? cleanString(label) : existing.label;
    const nextAddress =
      address !== undefined ? cleanString(address) : existing.address;

    const validationMessage = validateAddressPayload({
      label: nextLabel,
      address: nextAddress,
      latitude,
      longitude,
    });

    if (validationMessage) {
      return res.status(400).json({
        success: false,
        message: validationMessage,
      });
    }

    const shouldSetDefault = boolValue(isDefault, existing.isDefault);

    const updatedAddress = await prisma.$transaction(async (tx) => {
      if (shouldSetDefault) {
        await tx.userAddress.updateMany({
          where: {
            userId: req.user.id,
            NOT: {
              id,
            },
          },
          data: {
            isDefault: false,
          },
        });
      }

      return tx.userAddress.update({
        where: {
          id,
        },
        data: {
          ...(label !== undefined && { label: nextLabel }),
          ...(address !== undefined && { address: nextAddress }),
          ...(landmark !== undefined && {
            landmark: landmark ? cleanString(landmark) : null,
          }),
          ...(city !== undefined && {
            city: city ? cleanString(city) : null,
          }),
          ...(state !== undefined && {
            state: state ? cleanString(state) : null,
          }),
          ...(pincode !== undefined && {
            pincode: pincode ? cleanString(pincode) : null,
          }),
          ...(country !== undefined && {
            country: cleanString(country) || "India",
          }),
          ...(latitude !== undefined && {
            latitude: parseLatLng(latitude),
          }),
          ...(longitude !== undefined && {
            longitude: parseLatLng(longitude),
          }),
          ...(isDefault !== undefined && {
            isDefault: shouldSetDefault,
          }),
        },
      });
    });

    const addresses = await getAddressList(req.user.id);

    return res.json({
      success: true,
      message: "Address updated successfully",
      data: updatedAddress,
      address: updatedAddress,
      addresses,
    });
  } catch (error) {
    console.error("Update Address Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// SET default address
router.patch("/:id/default", protect, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.userAddress.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    const address = await prisma.$transaction(async (tx) => {
      await tx.userAddress.updateMany({
        where: {
          userId: req.user.id,
        },
        data: {
          isDefault: false,
        },
      });

      return tx.userAddress.update({
        where: {
          id,
        },
        data: {
          isDefault: true,
        },
      });
    });

    const addresses = await getAddressList(req.user.id);

    return res.json({
      success: true,
      message: "Default address updated successfully",
      data: address,
      address,
      addresses,
    });
  } catch (error) {
    console.error("Set Default Address Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// DELETE address
router.delete("/:id", protect, async (req, res) => {
  try {
    const { id } = req.params;

    const address = await prisma.userAddress.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userAddress.delete({
        where: {
          id,
        },
      });

      if (address.isDefault) {
        const latestAddress = await tx.userAddress.findFirst({
          where: {
            userId: req.user.id,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        if (latestAddress) {
          await tx.userAddress.update({
            where: {
              id: latestAddress.id,
            },
            data: {
              isDefault: true,
            },
          });
        }
      }
    });

    const addresses = await getAddressList(req.user.id);

    return res.json({
      success: true,
      message: "Address deleted successfully",
      data: { id },
      deletedId: id,
      addresses,
    });
  } catch (error) {
    console.error("Delete Address Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;