import express from "express";
import streamifier from "streamifier";
import cloudinary from "../config/cloudinary.js";
import { uploadImage } from "../middleware/upload.middleware.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

const uploadToCloudinary = (fileBuffer, folder = "misc") => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `karto/${folder}`,
        resource_type: "image",
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
  allowRoles("ADMIN", "VENDOR"),
  uploadImage.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image is required",
        });
      }

      const folder = req.body.folder || "misc";
      const result = await uploadToCloudinary(req.file.buffer, folder);

      return res.status(200).json({
        success: true,
        message: "Image uploaded successfully",
        imageUrl: result.secure_url,
        publicId: result.public_id,
      });
    } catch (error) {
      console.error("Upload image error:", error);

      return res.status(500).json({
        success: false,
        message: "Image upload failed",
      });
    }
  }
);

export default router;