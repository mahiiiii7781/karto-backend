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
import { Resend } from "resend";

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

const normalizeEmail = (email) =>
  email ? String(email).trim().toLowerCase() : null;

const normalizePhone = (phone) => (phone ? String(phone).trim() : null);

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/* =========================================================
   OLD GMAIL SMTP SETUP - COMMENTED, KEPT FOR FALLBACK ONLY
   Railway par Gmail SMTP timeout de raha tha, isliye Resend active hai.
   ========================================================= */

/*
const mailTransporter = nodemailer.createTransport({
  host: "74.125.130.109",
  port: 587,
  secure: false,
  requireTLS: true,
  family: 4,
  name: "gmail.com",
  tls: {
    servername: "smtp.gmail.com",
    rejectUnauthorized: true,
  },
  connectionTimeout: 60000,
  greetingTimeout: 60000,
  socketTimeout: 60000,
  auth: {
    user: env.SMTP_USER || process.env.SMTP_USER,
    pass: env.SMTP_PASS || process.env.SMTP_PASS,
  },
});
*/

/* =========================================================
   RESEND EMAIL SETUP - ACTIVE
   Required Railway/Render env:
   RESEND_API_KEY=re_xxxxx
   EMAIL_FROM=onboarding@resend.dev or verified domain email
   ========================================================= */

const resend = new Resend(env.RESEND_API_KEY || process.env.RESEND_API_KEY);

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
console.log("RESEND_API_KEY EXISTS:", Boolean(process.env.RESEND_API_KEY));
console.log("EMAIL_FROM:", process.env.EMAIL_FROM);
console.log("TWILIO_CONFIGURED:", Boolean(twilioClient));

/* =========================================================
   OLD GMAIL OTP SENDER - COMMENTED, KEPT FOR FALLBACK ONLY
   ========================================================= */

/*
const sendEmailOtp = async (email, code) => {
  try {
    console.log("BEFORE SEND MAIL");

    // await mailTransporter.verify();

    // console.log("AFTER SMTP VERIFY");

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
*/

/* =========================================================
   ACTIVE RESEND OTP SENDER
   Same Karto theme: black + green + yellow
   ========================================================= */

const sendEmailOtp = async (email, code) => {
  try {
    console.log("BEFORE RESEND SEND MAIL");

    if (!(env.RESEND_API_KEY || process.env.RESEND_API_KEY)) {
      throw new Error("RESEND_API_KEY is missing");
    }

    const { data, error } = await resend.emails.send({
      from: `Karto Support Team <${
        env.EMAIL_FROM || process.env.EMAIL_FROM || "security@karto.online"
      }>`,
      to: [email],
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

    if (error) {
      console.error("RESEND ERROR:", error);
      throw new Error(error.message || "Resend email send failed");
    }

    console.log("MAIL SENT SUCCESSFULLY VIA RESEND");
    console.log("RESEND MESSAGE:", data);

    return true;
  } catch (error) {
    console.error("EMAIL SEND ERROR:", error);
    throw error;
  }
};

const deleteExpiredOtps = async () => {
  try {
    await prisma.otp.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { verified: true }],
      },
    });
  } catch (error) {
    console.warn("OTP cleanup skipped:", error.message);
  }
};

export const register = async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);

    if (!fullName || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Full name, email and password are required",
      });
    }

    if (String(fullName).trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Full name must be at least 2 characters",
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    if (normalizedPhone && !/^[6-9]\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 10 digit phone number",
      });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          normalizedPhone ? { phone: normalizedPhone } : undefined,
        ].filter(Boolean),
      },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);

    const user = await prisma.user.create({
      data: {
        fullName: String(fullName).trim(),
        email: normalizedEmail,
        phone: normalizedPhone,
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

    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

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

    const isPasswordMatch = await bcrypt.compare(String(password), user.password);

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
    user: safeUser(req.user),
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
    console.error("Logout Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const sendOtp = async (req, res) => {
  try {
    const { email, phone } = req.body;

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedEmail && !normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: "Email or phone is required",
      });
    }

    await deleteExpiredOtps();

    const code = generateOtp();

    await prisma.otp.create({
      data: {
        email: normalizedEmail || null,
        phone: normalizedPhone || null,
        code,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    if (normalizedEmail) {
      await sendEmailOtp(normalizedEmail, code);
    }

    if (normalizedPhone) {
      if (!twilioClient) {
        return res.status(500).json({
          success: false,
          message: "Twilio is not configured",
        });
      }

      await twilioClient.messages.create({
        body: `Your Karto OTP is ${code}. It is valid for 5 minutes. Do not share it with anyone.`,
        from: env.TWILIO_PHONE_NUMBER || process.env.TWILIO_PHONE_NUMBER,
        to: normalizedPhone,
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (error) {
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

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const finalCode = code || otp;

    if ((!normalizedEmail && !normalizedPhone) || !finalCode) {
      return res.status(400).json({
        success: false,
        message: "Email/phone and OTP are required",
      });
    }

    const otpRecord = await prisma.otp.findFirst({
      where: {
        code: String(finalCode).trim(),
        verified: false,
        expiresAt: { gt: new Date() },
        OR: [
          normalizedEmail ? { email: normalizedEmail } : undefined,
          normalizedPhone ? { phone: normalizedPhone } : undefined,
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
          normalizedEmail ? { email: normalizedEmail } : undefined,
          normalizedPhone ? { phone: normalizedPhone } : undefined,
        ].filter(Boolean),
      },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          fullName:
            fullName && String(fullName).trim().length >= 2
              ? String(fullName).trim()
              : "Karto User",
          email:
            normalizedEmail ||
            `${String(normalizedPhone).replace("+", "")}@phone.karto.local`,
          phone: normalizedPhone || null,
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
    user: safeUser(req.user),
  });
};

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { fullName, phone, avatarUrl } = req.body;

    const errors = {};

    if (fullName !== undefined) {
      const name = String(fullName).trim();

      if (!name) {
        errors.fullName = "Full name is required";
      } else if (name.length < 2) {
        errors.fullName = "Full name must be at least 2 characters";
      } else if (name.length > 60) {
        errors.fullName = "Full name must be under 60 characters";
      }
    }

    if (phone !== undefined && phone !== null && phone !== "") {
      const normalizedPhone = normalizePhone(phone);

      if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
        errors.phone = "Enter valid 10 digit phone number";
      }
    }

    if (avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== "") {
      if (!/^https?:\/\/.+/i.test(String(avatarUrl).trim())) {
        errors.avatarUrl = "Avatar must be valid URL";
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    const updateData = {};

    if (fullName !== undefined) {
      updateData.fullName = String(fullName).trim();
    }

    if (phone !== undefined) {
      updateData.phone = phone ? normalizePhone(phone) : null;
    }

    if (avatarUrl !== undefined) {
      updateData.avatarUrl = avatarUrl ? String(avatarUrl).trim() : null;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return res.json({
      success: true,
      message: "Profile updated",
      user: safeUser(updatedUser),
    });
  } catch (error) {
    console.error("Update Profile Error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Phone number already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};