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

    /* ===================================
       ORDER ROOM
    =================================== */

    socket.on("joinOrderRoom", (orderId) => {
      if (!orderId) return;

      socket.join(`order-${orderId}`);

      console.log(
        `Socket ${socket.id} joined order-${orderId}`
      );
    });

    socket.on("leaveOrderRoom", (orderId) => {
      if (!orderId) return;

      socket.leave(`order-${orderId}`);
    });

    /* ===================================
       VENDOR ROOM
    =================================== */

    socket.on("joinVendorRoom", (vendorId) => {
      if (!vendorId) return;

      socket.join(`vendor-${vendorId}`);

      console.log(
        `Socket ${socket.id} joined vendor-${vendorId}`
      );
    });

    socket.on("leaveVendorRoom", (vendorId) => {
      if (!vendorId) return;

      socket.leave(`vendor-${vendorId}`);
    });

    /* ===================================
       RIDER ROOM
    =================================== */

    socket.on("joinRiderRoom", (riderId) => {
      if (!riderId) return;

      socket.join(`rider-${riderId}`);

      console.log(
        `Socket ${socket.id} joined rider-${riderId}`
      );
    });

    socket.on("leaveRiderRoom", (riderId) => {
      if (!riderId) return;

      socket.leave(`rider-${riderId}`);
    });

    /* ===================================
       CITY RIDER ROOM
       Used for order assignment popup
    =================================== */

    socket.on("joinRiderCity", (cityId) => {
      if (!cityId) return;

      socket.join(`rider-city-${cityId}`);

      console.log(
        `Socket ${socket.id} joined rider-city-${cityId}`
      );
    });

    socket.on("leaveRiderCity", (cityId) => {
      if (!cityId) return;

      socket.leave(`rider-city-${cityId}`);
    });

    /* ===================================
       LIVE LOCATION
    =================================== */

    socket.on("rider-location", (payload) => {
      if (!payload?.orderId) return;

      io.to(`order-${payload.orderId}`).emit(
        "rider-location-updated",
        payload
      );
    });

    /* ===================================
       ADMIN ROOM
    =================================== */

    socket.on("joinAdminRoom", () => {
      socket.join("admin");
    });

    /* ===================================
       RIDER ONLINE
    =================================== */

    socket.on("rider-online", (riderId) => {
      if (!riderId) return;

      io.emit("rider-online", {
        riderId,
        online: true,
      });
    });

    socket.on("rider-offline", (riderId) => {
      if (!riderId) return;

      io.emit("rider-offline", {
        riderId,
        online: false,
      });
    });

    /* ===================================
       NEW ORDER ASSIGNMENT
    =================================== */

    socket.on("assign-order-to-rider", (payload) => {
      if (!payload?.riderId) return;

      io.to(`rider-${payload.riderId}`).emit(
        "new-rider-order",
        payload
      );
    });

    /* ===================================
       DISCONNECT
    =================================== */

    socket.on("disconnect", () => {
      console.log(
        "Socket disconnected:",
        socket.id
      );
    });
  });

  return io;
};

export const getIO = () => io;