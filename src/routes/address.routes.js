import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// GET all addresses
router.get("/", protect, async (req, res) => {
  try {
    const addresses = await prisma.userAddress.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      data: addresses,
    });
  } catch (error) {
    console.error("Get Address Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// ADD address
router.post("/", protect, async (req, res) => {
  try {
    const { label, address, landmark } = req.body;

    if (!label || !String(label).trim()) {
      return res.status(400).json({
        success: false,
        message: "Address label is required",
      });
    }

    if (!address || !String(address).trim()) {
      return res.status(400).json({
        success: false,
        message: "Address is required",
      });
    }

    if (String(address).trim().length < 8) {
      return res.status(400).json({
        success: false,
        message: "Please enter a complete address",
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

    const newAddress = await prisma.userAddress.create({
      data: {
        userId: req.user.id,
        label: String(label).trim(),
        address: String(address).trim(),
        landmark: landmark ? String(landmark).trim() : null,
      },
    });

    res.status(201).json({
      success: true,
      message: "Address added successfully",
      data: newAddress,
    });
  } catch (error) {
    console.error("Add Address Error:", error);
    res.status(500).json({
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

    await prisma.userAddress.delete({
      where: {
        id,
      },
    });

    res.json({
      success: true,
      message: "Address deleted successfully",
      data: { id },
    });
  } catch (error) {
    console.error("Delete Address Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;