import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { setSocketInstance } from "./config/socket.js";

let io;

const now = () => new Date();

const safeJoin = (socket, room) => {
  if (!socket || !room) return;
  socket.join(room);
};

const safeLeave = (socket, room) => {
  if (!socket || !room) return;
  socket.leave(room);
};

const emitRoom = (room, event, payload = {}) => {
  if (!io || !room || !event) return;

  io.to(room).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

const getRawSocketToken = (socket) =>
  socket.handshake.auth?.token ||
  socket.handshake.query?.token ||
  socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "") ||
  null;

const normalizeSocketUser = (decoded) => {
  if (!decoded || typeof decoded !== "object") return null;

  const id =
    decoded.id ||
    decoded.userId ||
    decoded.sub ||
    null;

  if (!id) return null;

  return {
    ...decoded,
    id: String(id),
    role: decoded.role
      ? String(decoded.role).trim().toUpperCase()
      : null,
    cityId:
      decoded.cityId ||
      decoded.city_id ||
      null,
  };
};

const getUserFromToken = (socket) => {
  try {
    const token = getRawSocketToken(socket);

    if (!token) return null;

    const decoded = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET ||
        process.env.JWT_SECRET
    );

    return normalizeSocketUser(decoded);
  } catch (error) {
    console.error(
      "[Socket] token verification failed:",
      error?.message || error
    );

    return null;
  }
};

const sameId = (a, b) =>
  Boolean(a && b) &&
  String(a) === String(b);

const canJoinUserRoom = (socket, userId) =>
  sameId(socket.user?.id, userId) ||
  socket.user?.role === "ADMIN";

const canJoinVendorRoom = (socket, vendorId) =>
  sameId(socket.user?.id, vendorId) ||
  socket.user?.role === "ADMIN";

const canJoinRiderRoom = (socket, riderId) =>
  sameId(socket.user?.id, riderId) ||
  socket.user?.role === "ADMIN";

const canJoinAdminRoom = (socket) => socket.user?.role === "ADMIN";

const joinWithAck = (socket, room, ackEvent, extra = {}) => {
  safeJoin(socket, room);

  socket.emit(ackEvent, {
    success: true,
    room,
    ...extra,
    joinedAt: now(),
  });
};

const rejectJoin = (socket, event, message = "Unauthorized room access") => {
  socket.emit(event, {
    success: false,
    message,
    rejectedAt: now(),
  });
};

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || "*",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  setSocketInstance(io);

  io.use((socket, next) => {
    const rawToken = getRawSocketToken(socket);
    const user = getUserFromToken(socket);

    /*
     * If a client sends a token and it is invalid, do not silently
     * connect it as a guest. Previously this could make the Vendor
     * dashboard show "Realtime connected" while the socket was not
     * actually inside vendor-{vendorId}, so new-order audio never fired.
     */
    if (rawToken && !user) {
      return next(
        new Error("Socket authentication failed")
      );
    }

    if (user) {
      socket.user = user;

      safeJoin(
        socket,
        `user-${user.id}`
      );

      if (user.role) {
        safeJoin(
          socket,
          `role-${user.role}`
        );
      }

      if (user.role === "VENDOR") {
        safeJoin(
          socket,
          `vendor-${user.id}`
        );
      }

      if (user.role === "RIDER") {
        safeJoin(
          socket,
          `rider-${user.id}`
        );

        if (user.cityId) {
          safeJoin(
            socket,
            `rider-city-${user.cityId}`
          );
        }
      }

      if (user.role === "ADMIN") {
        safeJoin(
          socket,
          "admin"
        );
      }

      console.log(
        `[Socket] authenticated ${user.role || "USER"} ${user.id}`
      );
    } else {
      console.log(
        `[Socket] guest connection ${socket.id}`
      );
    }

    next();
  });

  io.on("connection", (socket) => {
    console.log(
      "Socket connected:",
      socket.id,
      socket.user?.id || "guest",
      socket.user?.role || ""
    );

    socket.emit("SOCKET_CONNECTED", {
      success: true,
      socketId: socket.id,
      userId: socket.user?.id || null,
      role: socket.user?.role || null,
      rooms: Array.from(socket.rooms || []),
      connectedAt: now(),
    });

    /* USER ROOM */
    socket.on("joinUserRoom", (userId) => {
      const finalUserId = userId || socket.user?.id;

      if (!finalUserId || !canJoinUserRoom(socket, finalUserId)) {
        return rejectJoin(socket, "USER_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, `user-${finalUserId}`, "USER_ROOM_JOINED", {
        userId: finalUserId,
      });
    });

    socket.on("leaveUserRoom", (userId) => {
      const finalUserId = userId || socket.user?.id;
      if (!finalUserId) return;

      safeLeave(socket, `user-${finalUserId}`);
    });

    socket.on("join-user-room", (userId) => {
      const finalUserId = userId || socket.user?.id;

      if (!finalUserId || !canJoinUserRoom(socket, finalUserId)) {
        return rejectJoin(socket, "USER_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, `user-${finalUserId}`, "USER_ROOM_JOINED", {
        userId: finalUserId,
      });
    });

    socket.on("leave-user-room", (userId) => {
      const finalUserId = userId || socket.user?.id;
      if (!finalUserId) return;

      safeLeave(socket, `user-${finalUserId}`);
    });

    /* ORDER ROOM */
    socket.on("joinOrderRoom", (orderId) => {
      if (!orderId) return;

      joinWithAck(socket, `order-${orderId}`, "ORDER_ROOM_JOINED", {
        orderId,
      });
    });

    socket.on("leaveOrderRoom", (orderId) => {
      safeLeave(socket, `order-${orderId}`);
    });

    socket.on("join-order-room", (orderId) => {
      if (!orderId) return;

      joinWithAck(socket, `order-${orderId}`, "ORDER_ROOM_JOINED", {
        orderId,
      });
    });

    socket.on("leave-order-room", (orderId) => {
      safeLeave(socket, `order-${orderId}`);
    });

    /* VENDOR ROOM */
    socket.on("joinVendorRoom", (vendorId) => {
      const finalVendorId = vendorId || socket.user?.id;

      if (!finalVendorId || !canJoinVendorRoom(socket, finalVendorId)) {
        return rejectJoin(socket, "VENDOR_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, `vendor-${finalVendorId}`, "VENDOR_ROOM_JOINED", {
        vendorId: finalVendorId,
      });

      console.log(
        `[Socket] ${socket.id} joined vendor-${finalVendorId}`
      );
    });

    socket.on("leaveVendorRoom", (vendorId) => {
      const finalVendorId = vendorId || socket.user?.id;
      if (!finalVendorId) return;

      safeLeave(socket, `vendor-${finalVendorId}`);
    });

    socket.on("join-vendor-room", (vendorId) => {
      const finalVendorId = vendorId || socket.user?.id;

      if (!finalVendorId || !canJoinVendorRoom(socket, finalVendorId)) {
        return rejectJoin(socket, "VENDOR_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, `vendor-${finalVendorId}`, "VENDOR_ROOM_JOINED", {
        vendorId: finalVendorId,
      });

      console.log(
        `[Socket] ${socket.id} joined vendor-${finalVendorId}`
      );
    });

    socket.on("leave-vendor-room", (vendorId) => {
      const finalVendorId = vendorId || socket.user?.id;
      if (!finalVendorId) return;

      safeLeave(socket, `vendor-${finalVendorId}`);
    });

    socket.on("vendor-online", (payload = {}) => {
      const vendorId =
        typeof payload === "string"
          ? payload
          : payload.vendorId || socket.user?.id;

      if (!vendorId || !canJoinVendorRoom(socket, vendorId)) {
        return rejectJoin(socket, "VENDOR_ONLINE_REJECTED");
      }

      safeJoin(socket, `vendor-${vendorId}`);

      console.log(
        `[Socket] vendor online ${vendorId}; room vendor-${vendorId}`
      );

      emitRoom("admin", "vendor-online-status-changed", {
        vendorId,
        isOnline: true,
        socketId: socket.id,
      });

      socket.emit("VENDOR_ONLINE_ACK", {
        vendorId,
        isOnline: true,
      });
    });

    socket.on("vendor-offline", (payload = {}) => {
      const vendorId =
        typeof payload === "string"
          ? payload
          : payload.vendorId || socket.user?.id;

      if (!vendorId || !canJoinVendorRoom(socket, vendorId)) return;

      safeLeave(socket, `vendor-${vendorId}`);

      emitRoom("admin", "vendor-online-status-changed", {
        vendorId,
        isOnline: false,
        socketId: socket.id,
      });
    });

    socket.on("vendor-dashboard-refresh-request", (payload = {}) => {
      const vendorId = payload.vendorId || socket.user?.id;

      if (!vendorId || !canJoinVendorRoom(socket, vendorId)) return;

      emitRoom(`vendor-${vendorId}`, "VENDOR_DASHBOARD_REFRESH", {
        reason: "MANUAL_REFRESH_REQUEST",
        vendorId,
      });
    });

    /* RIDER ROOM */
    socket.on("joinRiderRoom", (riderId) => {
      const finalRiderId = riderId || socket.user?.id;

      if (!finalRiderId || !canJoinRiderRoom(socket, finalRiderId)) {
        return rejectJoin(socket, "RIDER_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, `rider-${finalRiderId}`, "RIDER_ROOM_JOINED", {
        riderId: finalRiderId,
      });
    });

    socket.on("leaveRiderRoom", (riderId) => {
      const finalRiderId = riderId || socket.user?.id;
      if (!finalRiderId) return;

      safeLeave(socket, `rider-${finalRiderId}`);
    });

    socket.on("join-rider-room", (riderId) => {
      const finalRiderId = riderId || socket.user?.id;

      if (!finalRiderId || !canJoinRiderRoom(socket, finalRiderId)) {
        return rejectJoin(socket, "RIDER_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, `rider-${finalRiderId}`, "RIDER_ROOM_JOINED", {
        riderId: finalRiderId,
      });
    });

    socket.on("leave-rider-room", (riderId) => {
      const finalRiderId = riderId || socket.user?.id;
      if (!finalRiderId) return;

      safeLeave(socket, `rider-${finalRiderId}`);
    });

    socket.on("joinRiderCity", (cityId) => {
      if (!cityId) return;

      if (!["RIDER", "ADMIN"].includes(socket.user?.role)) {
        return rejectJoin(socket, "RIDER_CITY_JOIN_REJECTED");
      }

      joinWithAck(socket, `rider-city-${cityId}`, "RIDER_CITY_JOINED", {
        cityId,
      });
    });

    socket.on("leaveRiderCity", (cityId) => {
      safeLeave(socket, `rider-city-${cityId}`);
    });

    socket.on("join-rider-city", (cityId) => {
      if (!cityId) return;

      if (!["RIDER", "ADMIN"].includes(socket.user?.role)) {
        return rejectJoin(socket, "RIDER_CITY_JOIN_REJECTED");
      }

      joinWithAck(socket, `rider-city-${cityId}`, "RIDER_CITY_JOINED", {
        cityId,
      });
    });

    socket.on("leave-rider-city", (cityId) => {
      safeLeave(socket, `rider-city-${cityId}`);
    });

    /* ADMIN ROOM */
    socket.on("joinAdminRoom", () => {
      if (!canJoinAdminRoom(socket)) {
        return rejectJoin(socket, "ADMIN_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, "admin", "ADMIN_ROOM_JOINED");
    });

    socket.on("join-admin-room", () => {
      if (!canJoinAdminRoom(socket)) {
        return rejectJoin(socket, "ADMIN_ROOM_JOIN_REJECTED");
      }

      joinWithAck(socket, "admin", "ADMIN_ROOM_JOINED");
    });

    socket.on("leaveAdminRoom", () => {
      safeLeave(socket, "admin");
    });

    socket.on("leave-admin-room", () => {
      safeLeave(socket, "admin");
    });

    /* RIDER ONLINE/OFFLINE */
    socket.on("rider-online", (payload = {}) => {
      const riderId =
        typeof payload === "string"
          ? payload
          : payload.riderId || socket.user?.id;

      const cityId = typeof payload === "object" ? payload?.cityId : null;

      if (!riderId || !canJoinRiderRoom(socket, riderId)) {
        return rejectJoin(socket, "RIDER_ONLINE_REJECTED");
      }

      safeJoin(socket, `rider-${riderId}`);
      if (cityId) safeJoin(socket, `rider-city-${cityId}`);

      emitRoom("admin", "rider-online-status-changed", {
        riderId,
        cityId,
        isOnline: true,
        socketId: socket.id,
      });

      socket.emit("RIDER_ONLINE_ACK", {
        riderId,
        cityId,
        isOnline: true,
      });
    });

    socket.on("rider-offline", (payload = {}) => {
      const riderId =
        typeof payload === "string"
          ? payload
          : payload.riderId || socket.user?.id;

      const cityId = typeof payload === "object" ? payload?.cityId : null;

      if (!riderId || !canJoinRiderRoom(socket, riderId)) return;

      safeLeave(socket, `rider-${riderId}`);
      if (cityId) safeLeave(socket, `rider-city-${cityId}`);

      emitRoom("admin", "rider-online-status-changed", {
        riderId,
        cityId,
        isOnline: false,
        socketId: socket.id,
      });
    });

    /* RIDER LOCATION */
    socket.on("rider-location", (payload = {}) => {
      if (!payload?.orderId) return;

      const riderId = payload.riderId || socket.user?.id;

      if (socket.user?.role === "RIDER" && payload.riderId && payload.riderId !== socket.user.id) {
        return;
      }

      const data = {
        ...payload,
        riderId,
        updatedAt: now(),
      };

      io.to(`order-${payload.orderId}`).emit("rider-location-updated", data);
      io.to(`order-${payload.orderId}`).emit("RIDER_LOCATION_UPDATED", data);
      io.to("admin").emit("rider-location-updated", data);

      if (payload.vendorId) {
        io.to(`vendor-${payload.vendorId}`).emit("rider-location-updated", data);
      }

      if (payload.userId) {
        io.to(`user-${payload.userId}`).emit("rider-location-updated", data);
      }
    });

    /* RIDER ASSIGNMENT */
    socket.on("assign-order-to-rider", (payload = {}) => {
      if (!payload?.riderId || !payload?.order) return;

      if (!["VENDOR", "ADMIN"].includes(socket.user?.role)) {
        return rejectJoin(socket, "ASSIGN_ORDER_REJECTED");
      }

      const data = {
        ...payload,
        orderId: payload.order?.id,
        assignedAt: now(),
      };

      io.to(`rider-${payload.riderId}`).emit("NEW_RIDER_ORDER", data);
      io.to(`rider-${payload.riderId}`).emit("new-rider-order", data);
      io.to(`rider-${payload.riderId}`).emit("new-order-assignment", data);
      io.to(`rider-${payload.riderId}`).emit("rider:newOrder", data);

      io.to("admin").emit("rider-assignment-sent", {
        riderId: payload.riderId,
        orderId: payload.order?.id,
        sentAt: now(),
      });

      if (payload.vendorId) {
        io.to(`vendor-${payload.vendorId}`).emit("RIDER_ASSIGNED", data);
        io.to(`vendor-${payload.vendorId}`).emit("vendor:riderAssigned", data);
        io.to(`vendor-${payload.vendorId}`).emit("VENDOR_DASHBOARD_REFRESH", {
          reason: "RIDER_ASSIGNED",
          order: payload.order,
        });
      }

      if (payload.order?.userId) {
        io.to(`user-${payload.order.userId}`).emit("RIDER_ASSIGNED", data);
        io.to(`user-${payload.order.userId}`).emit("order-updated", data);
      }
    });

    socket.on("broadcast-order-to-city-riders", (payload = {}) => {
      if (!payload?.cityId || !payload?.order) return;

      if (!["VENDOR", "ADMIN"].includes(socket.user?.role)) {
        return rejectJoin(socket, "CITY_BROADCAST_REJECTED");
      }

      const data = {
        ...payload,
        orderId: payload.order?.id,
        broadcastAt: now(),
      };

      io.to(`rider-city-${payload.cityId}`).emit("NEW_RIDER_ORDER", data);
      io.to(`rider-city-${payload.cityId}`).emit("new-rider-order", data);
      io.to(`rider-city-${payload.cityId}`).emit("new-order-assignment", data);
      io.to(`rider-city-${payload.cityId}`).emit("rider:newOrder", data);

      io.to("admin").emit("city-rider-assignment-broadcast", {
        cityId: payload.cityId,
        orderId: payload.order?.id,
        sentAt: now(),
      });
    });

    /* RIDER POPUP TRACKING */
    socket.on("rider-order-popup-opened", (payload = {}) => {
      if (!payload?.orderId) return;

      emitRoom("admin", "rider-order-popup-opened", {
        ...payload,
        riderId: payload.riderId || socket.user?.id,
        openedAt: now(),
      });
    });

    socket.on("rider-order-popup-timeout", (payload = {}) => {
      if (!payload?.orderId) return;

      emitRoom("admin", "rider-order-popup-timeout", {
        ...payload,
        riderId: payload.riderId || socket.user?.id,
        timeoutAt: now(),
      });
    });

    socket.on("rider-accepted-order", (payload = {}) => {
      if (!payload?.orderId) return;

      const data = {
        ...payload,
        riderId: payload.riderId || socket.user?.id,
        acceptedAt: now(),
      };

      io.to(`order-${payload.orderId}`).emit("order-accepted-by-rider", data);
      io.to("admin").emit("order-accepted-by-rider", data);

      if (payload.vendorId) {
        io.to(`vendor-${payload.vendorId}`).emit("ORDER_ACCEPTED_BY_RIDER", data);
        io.to(`vendor-${payload.vendorId}`).emit("VENDOR_DASHBOARD_REFRESH", {
          reason: "ORDER_ACCEPTED_BY_RIDER",
          orderId: payload.orderId,
        });
      }

      if (payload.userId) {
        io.to(`user-${payload.userId}`).emit("ORDER_ACCEPTED_BY_RIDER", data);
        io.to(`user-${payload.userId}`).emit("order-updated", data);
      }
    });

    socket.on("rider-rejected-order", (payload = {}) => {
      if (!payload?.orderId) return;

      const data = {
        ...payload,
        riderId: payload.riderId || socket.user?.id,
        rejectedAt: now(),
      };

      io.to("admin").emit("order-rejected-by-rider", data);

      if (payload.vendorId) {
        io.to(`vendor-${payload.vendorId}`).emit("ORDER_REJECTED_BY_RIDER", data);
      }
    });

    socket.on("disconnect", (reason) => {
      console.log("Socket disconnected:", socket.id, reason);

      if (socket.user?.role === "VENDOR") {
        emitRoom("admin", "vendor-online-status-changed", {
          vendorId: socket.user.id,
          isOnline: false,
          socketId: socket.id,
          reason,
        });
      }

      if (socket.user?.role === "RIDER") {
        emitRoom("admin", "rider-online-status-changed", {
          riderId: socket.user.id,
          isOnline: false,
          socketId: socket.id,
          reason,
        });
      }
    });
  });

  return io;
};

export const getIO = () => io;

export const emitToUser = (userId, event, payload = {}) => {
  if (!io || !userId || !event) return;
  io.to(`user-${userId}`).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

export const emitToRider = (riderId, event, payload = {}) => {
  if (!io || !riderId || !event) return;
  io.to(`rider-${riderId}`).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

export const emitToOrder = (orderId, event, payload = {}) => {
  if (!io || !orderId || !event) return;
  io.to(`order-${orderId}`).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

export const emitToVendor = (vendorId, event, payload = {}) => {
  if (!io || !vendorId || !event) return;
  io.to(`vendor-${vendorId}`).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

export const emitToAdmin = (event, payload = {}) => {
  if (!io || !event) return;
  io.to("admin").emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

export const broadcastToCityRiders = (cityId, event, payload = {}) => {
  if (!io || !cityId || !event) return;
  io.to(`rider-city-${cityId}`).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};