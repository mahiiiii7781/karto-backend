import express from "express";
import streamifier from "streamifier";

import cloudinary from "../config/cloudinary.js";
import { uploadImage } from "../middleware/upload.middleware.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

const safeFolder = (folder = "misc") => {
  const cleanFolder = String(folder || "misc")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_/]/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");

  return cleanFolder || "misc";
};

const isAllowedImage = (file) => {
  if (!file) return false;

  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ];

  return allowedMimeTypes.includes(file.mimetype);
};

const uploadToCloudinary = (fileBuffer, folder = "misc") => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `karto/${safeFolder(folder)}`,
        resource_type: "image",
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        transformation: [
          {
            quality: "auto",
            fetch_format: "auto",
          },
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    streamifier.createReadStream(fileBuffer).pipe(stream);
  });
};

router.post(
  "/image",
  protect,
  allowRoles("ADMIN", "VENDOR", "RIDER", "CUSTOMER", "USER"),
  uploadImage.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image is required",
        });
      }

      if (!isAllowedImage(req.file)) {
        return res.status(400).json({
          success: false,
          message: "Only JPG, PNG, WEBP, HEIC and HEIF images are allowed",
        });
      }

      if (req.file.size > MAX_IMAGE_SIZE) {
        return res.status(400).json({
          success: false,
          message: "Image size must be less than 8MB",
        });
      }

      const folder = safeFolder(req.body.folder || "misc");
      const result = await uploadToCloudinary(req.file.buffer, folder);

      const payload = {
        imageUrl: result.secure_url,
        url: result.secure_url,
        publicId: result.public_id,
        folder,
        cloudinaryFolder: `karto/${folder}`,
        width: result.width || null,
        height: result.height || null,
        format: result.format || null,
        bytes: result.bytes || null,
        resourceType: result.resource_type || "image",
      };

      return res.status(200).json({
        success: true,
        message: "Image uploaded successfully",
        data: payload,
        ...payload,
      });
    } catch (error) {
      console.error("Upload image error:", error);

      return res.status(500).json({
        success: false,
        message: "Image upload failed",
        error: error.message,
      });
    }
  }
);

export default router;