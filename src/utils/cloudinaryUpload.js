import streamifier from "streamifier";
import cloudinary from "../config/cloudinary.js";

export const uploadToCloudinary = (file, folder = "misc") => {
  return new Promise((resolve, reject) => {
    if (!file?.buffer) {
      return resolve(null);
    }

    let settled = false;

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const timer = setTimeout(() => {
      done(
        reject,
        new Error("Cloudinary upload timed out after 60 seconds")
      );
    }, 60000);

    try {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `karto/${folder}`,
          resource_type: "image",
          timeout: 60000,
        },
        (error, result) => {
          clearTimeout(timer);

          if (error) {
            console.error("Cloudinary upload error:", error);
            return done(reject, error);
          }

          if (!result?.secure_url) {
            return done(
              reject,
              new Error("Cloudinary did not return secure_url")
            );
          }

          return done(resolve, result.secure_url);
        }
      );

      uploadStream.on("error", (error) => {
        clearTimeout(timer);
        console.error("Cloudinary stream error:", error);
        done(reject, error);
      });

      const inputStream = streamifier.createReadStream(file.buffer);

      inputStream.on("error", (error) => {
        clearTimeout(timer);
        console.error("Image stream error:", error);
        done(reject, error);
      });

      inputStream.pipe(uploadStream);
    } catch (error) {
      clearTimeout(timer);
      console.error("Cloudinary upload exception:", error);
      done(reject, error);
    }
  });
};