import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import { env } from "../config/env.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/token.js";
import nodemailer from "nodemailer";
import dns from "dns";
import { Resend } from "resend";
import axios from "axios"; // Ensure you run: npm install axios

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


const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 45 * 1000;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

/*
  Prevents duplicate OTP requests from the same Node process.
  DB invalidation below remains the source of truth.
*/
const otpRequestLocks = new Map();

const otpIdentityKey = ({ email, phone }) =>
  email ? `email:${email}` : `phone:${phone}`;

const withOtpLock = async (key, task) => {
  while (otpRequestLocks.has(key)) {
    await otpRequestLocks.get(key);
  }

  let release;
  const lock = new Promise((resolve) => {
    release = resolve;
  });

  otpRequestLocks.set(key, lock);

  try {
    return await task();
  } finally {
    otpRequestLocks.delete(key);
    release?.();
  }
};

const getOtpIdentity = ({ email, phone, channel }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const normalizedChannel = channel
    ? String(channel).trim().toLowerCase()
    : null;

  if (
    normalizedChannel &&
    !["email", "phone", "sms"].includes(normalizedChannel)
  ) {
    return {
      error: "channel must be email or phone",
    };
  }

  if (normalizedChannel === "email") {
    if (!normalizedEmail) {
      return { error: "Email is required" };
    }

    return {
      email: normalizedEmail,
      phone: null,
      channel: "email",
    };
  }

  if (normalizedChannel === "phone" || normalizedChannel === "sms") {
    if (!normalizedPhone) {
      return { error: "Phone is required" };
    }

    return {
      email: null,
      phone: normalizedPhone,
      channel: "phone",
    };
  }

  /*
    Backward-compatible behavior:
    exactly one destination must be supplied.
    This intentionally blocks sending email + SMS from one request.
  */
  if (normalizedEmail && normalizedPhone) {
    return {
      error:
        "Send OTP to only one channel at a time. Pass either email or phone.",
    };
  }

  if (normalizedEmail) {
    return {
      email: normalizedEmail,
      phone: null,
      channel: "email",
    };
  }

  if (normalizedPhone) {
    return {
      email: null,
      phone: normalizedPhone,
      channel: "phone",
    };
  }

  return {
    error: "Email or phone is required",
  };
};

const getOtpWhere = ({ email, phone }) => ({
  ...(email ? { email } : {}),
  ...(phone ? { phone } : {}),
});

const maskOtpDestination = ({ email, phone }) => {
  if (email) {
    const [name = "", domain = ""] = email.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }

  if (phone) {
    return `******${String(phone).slice(-4)}`;
  }

  return "";
};

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
   ========================================================= */

const resend = new Resend(env.RESEND_API_KEY || process.env.RESEND_API_KEY);


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
    const identity = getOtpIdentity(req.body || {});

    if (identity.error) {
      return res.status(400).json({
        success: false,
        message: identity.error,
      });
    }

    const { email, phone, channel } = identity;
    const lockKey = otpIdentityKey(identity);

    return await withOtpLock(lockKey, async () => {
      await deleteExpiredOtps();

      const latestOtp = await prisma.otp.findFirst({
        where: getOtpWhere(identity),
        orderBy: { createdAt: "desc" },
      });

      if (latestOtp) {
        const elapsed =
          Date.now() - new Date(latestOtp.createdAt).getTime();

        if (
          !latestOtp.verified &&
          new Date(latestOtp.expiresAt) > new Date() &&
          elapsed < OTP_RESEND_COOLDOWN_MS
        ) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil(
              (OTP_RESEND_COOLDOWN_MS - elapsed) / 1000
            )
          );

          res.setHeader(
            "Retry-After",
            String(retryAfterSeconds)
          );

          return res.status(429).json({
            success: false,
            message: `Please wait ${retryAfterSeconds} seconds before requesting another OTP.`,
            retryAfterSeconds,
          });
        }
      }

      /*
        Only one active OTP for this destination.
        Old records are invalidated before a new code is created.
      */
      await prisma.otp.updateMany({
        where: {
          ...getOtpWhere(identity),
          verified: false,
        },
        data: {
          verified: true,
        },
      });

      const code = generateOtp();

      const otpRecord = await prisma.otp.create({
        data: {
          email: email || null,
          phone: phone || null,
          code,
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          verified: false,
        },
      });

      try {
        if (channel === "email") {
          await sendEmailOtp(email, code);
        } else {
          const apiKey =
            env.TWO_FACTOR_API_KEY ||
            process.env.TWO_FACTOR_API_KEY;

          if (!apiKey) {
            throw new Error(
              "SMS service is not configured properly"
            );
          }

          const digits = String(phone).replace(/\D/g, "");

          if (!/^[6-9]\d{9}$/.test(digits.slice(-10))) {
            return res.status(400).json({
              success: false,
              message: "Enter valid 10 digit phone number",
            });
          }

          const phoneFor2FA = `91${digits.slice(-10)}`;
          const url =
            `https://2factor.in/API/V1/${apiKey}/SMS/` +
            `${phoneFor2FA}/${code}`;

          const response = await axios.get(url, {
            timeout: 15000,
          });

          if (response.data?.Status !== "Success") {
            throw new Error(
              response.data?.Details ||
                "2Factor response failed"
            );
          }
        }
      } catch (dispatchError) {
        /*
          Do not leave an OTP active when delivery itself failed.
        */
        await prisma.otp.updateMany({
          where: {
            id: otpRecord.id,
            verified: false,
          },
          data: {
            verified: true,
          },
        });

        console.error(
          "OTP Dispatch Error:",
          dispatchError?.response?.data ||
            dispatchError?.message ||
            dispatchError
        );

        return res.status(502).json({
          success: false,
          message:
            channel === "email"
              ? "Failed to send email OTP"
              : "Failed to send SMS OTP",
        });
      }

      return res.status(200).json({
        success: true,
        message: "OTP sent successfully",
        channel,
        destination: maskOtpDestination(identity),
        expiresInSeconds: OTP_TTL_MS / 1000,
        resendAfterSeconds:
          OTP_RESEND_COOLDOWN_MS / 1000,
      });
    });
  } catch (error) {
    console.error("Send OTP Error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while sending OTP",
    });
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const {
      code,
      otp,
      fullName,
    } = req.body;

    const identity = getOtpIdentity(req.body || {});
    const finalCode = String(code || otp || "").trim();

    if (identity.error || !finalCode) {
      return res.status(400).json({
        success: false,
        message:
          identity.error ||
          "Email/phone and OTP are required",
      });
    }

    if (!/^\d{6}$/.test(finalCode)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 6 digit OTP",
      });
    }

    const lockKey = otpIdentityKey(identity);

    return await withOtpLock(lockKey, async () => {
      const now = new Date();

      /*
        Read only the latest active local OTP for this exact channel.
        This ensures an older OTP cannot become valid after resend.
      */
      const otpRecord = await prisma.otp.findFirst({
        where: {
          ...getOtpWhere(identity),
          verified: false,
          expiresAt: { gt: now },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (
        !otpRecord ||
        String(otpRecord.code).trim() !== finalCode
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired OTP",
        });
      }

      /*
        Phone OTP is additionally verified by 2Factor.
        Email OTP relies only on the local record.
        We never execute both verification channels for one request.
      */
      if (identity.channel === "phone") {
        const apiKey =
          env.TWO_FACTOR_API_KEY ||
          process.env.TWO_FACTOR_API_KEY;

        if (!apiKey) {
          return res.status(503).json({
            success: false,
            message: "SMS verification service is unavailable",
          });
        }

        const phoneFor2FA =
          `91${String(identity.phone)
            .replace(/\D/g, "")
            .slice(-10)}`;

        const verifyUrl =
          `https://2factor.in/API/V1/${apiKey}/SMS/VERIFY3/` +
          `${phoneFor2FA}/${finalCode}`;

        try {
          const response = await axios.get(verifyUrl, {
            timeout: 15000,
          });

          const matched =
            response.data?.Status === "Success" &&
            response.data?.Details === "OTP Matched";

          if (!matched) {
            return res.status(400).json({
              success: false,
              message: "Invalid OTP",
            });
          }
        } catch (verifyError) {
          console.error(
            "2Factor Verify Error:",
            verifyError?.response?.data ||
              verifyError?.message
          );

          return res.status(400).json({
            success: false,
            message: "Invalid or expired OTP",
          });
        }
      }

      /*
        Atomic consume:
        if a second verify request arrives at the same time,
        only one request can change verified=false -> true.
      */
      const consumed = await prisma.otp.updateMany({
        where: {
          id: otpRecord.id,
          verified: false,
          expiresAt: { gt: now },
        },
        data: {
          verified: true,
        },
      });

      if (consumed.count !== 1) {
        return res.status(409).json({
          success: false,
          message:
            "OTP was already used. Please request a new OTP.",
        });
      }

      /*
        Invalidate any older active OTPs for this same destination.
      */
      await prisma.otp.updateMany({
        where: {
          ...getOtpWhere(identity),
          id: { not: otpRecord.id },
          verified: false,
        },
        data: {
          verified: true,
        },
      });

      const userWhere = identity.email
        ? { email: identity.email }
        : { phone: identity.phone };

      let user = await prisma.user.findFirst({
        where: userWhere,
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            fullName:
              fullName &&
              String(fullName).trim().length >= 2
                ? String(fullName).trim()
                : "Karto User",

            email:
              identity.email ||
              `${String(identity.phone)
                .replace(/\D/g, "")
                .slice(-10)}@phone.karto.local`,

            phone:
              identity.phone || null,

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
      const newRefreshToken =
        generateRefreshToken(user);

      const updatedUser = await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          refreshToken: newRefreshToken,
        },
      });

      return res.status(200).json({
        success: true,
        message: "OTP verified successfully",
        accessToken,
        refreshToken: newRefreshToken,
        user: safeUser(updatedUser),
      });
    });
  } catch (error) {
    console.error("Verify OTP Error:", error);

    if (error?.code === "P2002") {
      return res.status(409).json({
        success: false,
        message:
          "An account already exists with this email or phone.",
      });
    }

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