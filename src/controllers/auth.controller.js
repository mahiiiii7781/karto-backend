import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import { env } from "../config/env.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/token.js";
import nodemailer from "nodemailer";
import twilio from "twilio";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
const safeUser = (user) => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  phone: user.phone,
  avatarUrl: user.avatarUrl,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
});

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const mailTransporter = nodemailer.createTransport({
  host: env.SMTP_HOST || process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(env.SMTP_PORT || process.env.SMTP_PORT || 465),
  secure: true,
  pool: false,
  family: 4,
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
  auth: {
    user: env.SMTP_USER || process.env.SMTP_USER,
    pass: env.SMTP_PASS || process.env.SMTP_PASS,
  },
});

const twilioClient =
  (env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID) &&
  (env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN)
    ? twilio(
        env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
        env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN
      )
    : null;
console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("SMTP_HOST:", process.env.SMTP_HOST);
console.log("SMTP_PORT:", process.env.SMTP_PORT);
const sendEmailOtp = async (email, code) => {
  try {
    console.log("BEFORE SMTP VERIFY");

    await mailTransporter.verify();

    console.log("AFTER SMTP VERIFY");

    const info = await mailTransporter.sendMail({
      from: `"Karto Security" <${env.SMTP_USER || process.env.SMTP_USER}>`,
      to: email,
      subject: "Your Karto Login OTP",
      html: `
        <div style="margin:0;padding:0;background:#050807;font-family:Arial,sans-serif;color:#ffffff;">
          <div style="max-width:560px;margin:0 auto;padding:28px;">
            <div style="background:#101510;border:1px solid #2C382E;border-radius:24px;padding:28px;">
              <div style="font-size:34px;font-weight:900;color:#22C55E;margin-bottom:8px;">
                Karto
              </div>

              <h2 style="margin:0;color:#ffffff;font-size:24px;">
                Verify your login
              </h2>

              <p style="color:#A7B0AA;font-size:15px;line-height:22px;">
                Use the OTP below to continue securely. This code is valid for
                <b style="color:#FACC15;">5 minutes</b>.
              </p>

              <div style="margin:26px 0;padding:20px;border-radius:18px;background:#0B0F0A;border:1px solid #FACC15;text-align:center;">
                <div style="font-size:38px;letter-spacing:8px;font-weight:900;color:#FACC15;">
                  ${code}
                </div>
              </div>

              <p style="color:#A7B0AA;font-size:13px;line-height:20px;">
                If you did not request this OTP, you can safely ignore this email.
                Your Karto account remains protected.
              </p>

              <div style="margin-top:22px;padding-top:16px;border-top:1px solid #2C382E;color:#22C55E;font-size:13px;">
                Fast delivery. Secure login. Premium Karto experience.
              </div>
            </div>
          </div>
        </div>
      `,
    });

    console.log("MAIL SENT SUCCESSFULLY");
    console.log("MESSAGE ID:", info.messageId);

    return true;
  } catch (error) {
    console.error("EMAIL SEND ERROR:", error);
    throw error;
  }
};

export const register = async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, phone ? { phone } : undefined].filter(Boolean),
      },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        fullName,
        email,
        phone,
        password: hashedPassword,
        role: "CUSTOMER",
      },
    });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      accessToken,
      refreshToken,
      user: safeUser(updatedUser),
    });
  } catch (error) {
    console.error("Register Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.password) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account is blocked",
      });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      accessToken,
      refreshToken,
      user: safeUser(updatedUser),
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const getMe = async (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user,
  });
};

export const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: "Refresh token is required",
      });
    }

    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account is blocked",
      });
    }

    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });

    return res.status(200).json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired refresh token",
    });
  }
};

export const logout = async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { refreshToken: null },
    });

    return res.status(200).json({
      success: true,
      message: "Logout successful",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const sendOtp = async (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: "Email or phone is required",
      });
    }

    const code = generateOtp();

    await prisma.otp.create({
      data: {
        email: email || null,
        phone: phone || null,
        code,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    if (email) {
      await sendEmailOtp(email, code);
    }

    if (phone) {
      if (!twilioClient) {
        return res.status(500).json({
          success: false,
          message: "Twilio is not configured",
        });
      }

      await twilioClient.messages.create({
        body: `Your Karto OTP is ${code}. It is valid for 5 minutes. Do not share it with anyone.`,
        from: env.TWILIO_PHONE_NUMBER || process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully",
    });
  } 
  catch (error) {
  console.error("Send OTP Error FULL:", error);

  return res.status(500).json({
    success: false,
    message: "Something went wrong while sending OTP",
    error: error.message,
    code: error.code || null,
  });
}
};

export const verifyOtp = async (req, res) => {
  try {
    const { email, phone, code, otp, fullName } = req.body;
    const finalCode = code || otp;

    if ((!email && !phone) || !finalCode) {
      return res.status(400).json({
        success: false,
        message: "Email/phone and OTP are required",
      });
    }

    const otpRecord = await prisma.otp.findFirst({
      where: {
        code: finalCode,
        verified: false,
        expiresAt: { gt: new Date() },
        OR: [
          email ? { email } : undefined,
          phone ? { phone } : undefined,
        ].filter(Boolean),
      },
      orderBy: { createdAt: "desc" },
    });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP",
      });
    }

    await prisma.otp.update({
      where: { id: otpRecord.id },
      data: { verified: true },
    });

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          email ? { email } : undefined,
          phone ? { phone } : undefined,
        ].filter(Boolean),
      },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          fullName: fullName || "Karto User",
          email: email || `${phone.replace("+", "")}@phone.karto.local`,
          phone: phone || null,
          password: "",
          role: "CUSTOMER",
        },
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account is blocked",
      });
    }

    const accessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      accessToken,
      refreshToken: newRefreshToken,
      user: safeUser(updatedUser),
    });
  } catch (error) {
    console.error("Verify OTP Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const adminOnlyTest = async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Welcome Admin",
    user: req.user,
  });
};

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { fullName, phone, avatarUrl } = req.body;

    const errors = {};

    if (fullName !== undefined) {
      if (!fullName.trim()) {
        errors.fullName = "Full name is required";
      } else if (fullName.trim().length < 2) {
        errors.fullName = "Full name must be at least 2 characters";
      } else if (fullName.trim().length > 60) {
        errors.fullName = "Full name must be under 60 characters";
      }
    }

    if (phone !== undefined && phone !== null && phone !== "") {
      if (!/^[6-9]\d{9}$/.test(phone)) {
        errors.phone = "Enter valid 10 digit phone number";
      }
    }

    if (avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== "") {
      if (!/^https?:\/\/.+/i.test(avatarUrl)) {
        errors.avatarUrl = "Avatar must be valid URL";
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        errors,
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(fullName !== undefined && { fullName }),
        ...(phone !== undefined && { phone: phone || null }),
        ...(avatarUrl !== undefined && { avatarUrl: avatarUrl || null }),
      },
    });

    res.json({
      success: true,
      message: "Profile updated",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update Profile Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};