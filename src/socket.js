import { Server } from "socket.io";
import { setSocketInstance } from "./config/socket.js";

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PATCH", "DELETE"],
    },
  });

  setSocketInstance(io);

  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    /* =========================
       ORDER ROOM
    ========================= */

    socket.on("joinOrderRoom", (orderId) => {
      if (!orderId) return;

      socket.join(`order:${orderId}`);
      console.log(`Socket ${socket.id} joined order:${orderId}`);
    });

    socket.on("leaveOrderRoom", (orderId) => {
      if (!orderId) return;

      socket.leave(`order:${orderId}`);
      console.log(`Socket ${socket.id} left order:${orderId}`);
    });

    /* =========================
       VENDOR ROOM
    ========================= */

    socket.on("joinVendorRoom", (vendorId) => {
      if (!vendorId) return;

      socket.join(`vendor:${vendorId}`);
      console.log(`Socket ${socket.id} joined vendor:${vendorId}`);
    });

    socket.on("leaveVendorRoom", (vendorId) => {
      if (!vendorId) return;

      socket.leave(`vendor:${vendorId}`);
      console.log(`Socket ${socket.id} left vendor:${vendorId}`);
    });

    /* =========================
       RIDER ROOM
    ========================= */

    socket.on("joinRiderRoom", (riderId) => {
      if (!riderId) return;

      socket.join(`rider:${riderId}`);
      socket.join("riders");

      console.log(`Socket ${socket.id} joined rider:${riderId}`);
    });

    socket.on("rider-online", (riderId) => {
      if (!riderId) return;

      socket.join(`rider:${riderId}`);
      socket.join("riders");

      console.log(`Rider online: ${riderId}`);
    });

    socket.on("leaveRiderRoom", (riderId) => {
      if (!riderId) return;

      socket.leave(`rider:${riderId}`);
      console.log(`Socket ${socket.id} left rider:${riderId}`);
    });

    /* =========================
       ADMIN ROOM
    ========================= */

    socket.on("joinAdminRoom", () => {
      socket.join("admin");
      console.log(`Socket ${socket.id} joined admin room`);
    });

    /* =========================
       DISCONNECT
    ========================= */

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", socket.id);
    });
  });

  return io;
};

export const getIO = () => io;