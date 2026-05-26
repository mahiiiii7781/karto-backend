import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    env.JWT_SECRET,
    {
      expiresIn: "15m",
    }
  );
};

export const generateRefreshToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
    },
    env.JWT_REFRESH_SECRET,
    {
      expiresIn: "7d",
    }
  );
};