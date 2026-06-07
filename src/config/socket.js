let ioInstance = null;

export const setSocketInstance = (io) => {
  ioInstance = io;
};

export const getSocketInstance = () => ioInstance;

const now = () => new Date();

const safeEmit = (room, event, payload = {}) => {
  if (!ioInstance || !room || !event) return;

  ioInstance.to(room).emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

const safeBroadcast = (event, payload = {}) => {
  if (!ioInstance || !event) return;

  ioInstance.emit(event, {
    ...payload,
    updatedAt: now(),
  });
};

/* =========================
   ORDER STATUS
========================= */

export const emitOrderStatus = (orderId, status, data = {}) => {
  if (!orderId) return;

  const order = data?.order || null;

  const payload = {
    orderId,
    status,
    ...data,
    updatedAt: now(),
  };

  safeEmit(`order-${orderId}`, "orderStatusUpdated", payload);
  safeEmit(`order-${orderId}`, "order-updated", payload);
  safeEmit(`order-${orderId}`, "ORDER_STATUS_UPDATED", payload);

  if (order?.userId) {
    safeEmit(`user-${order.userId}`, "ORDER_STATUS_UPDATED", payload);
    safeEmit(`user-${order.userId}`, "orderStatusUpdated", payload);
    safeEmit(`user-${order.userId}`, "order-updated", payload);
  }

  if (order?.vendorId) {
    safeEmit(`vendor-${order.vendorId}`, "ORDER_STATUS_UPDATED", payload);
    safeEmit(`vendor-${order.vendorId}`, "vendor:orderStatusUpdated", payload);
    safeEmit(`vendor-${order.vendorId}`, "VENDOR_DASHBOARD_REFRESH", {
      reason: "ORDER_STATUS_UPDATED",
      orderId,
      status,
      order,
    });
  }

  if (order?.riderId) {
    safeEmit(`rider-${order.riderId}`, "ORDER_STATUS_UPDATED", payload);
    safeEmit(`rider-${order.riderId}`, "order-updated", payload);
    safeEmit(`rider-${order.riderId}`, "rider:orderStatusUpdated", payload);
  }

  safeEmit("admin", "ORDER_STATUS_UPDATED", payload);
  safeEmit("admin", "order-status-updated", payload);
};

/* =========================
   RIDER LOCATION
========================= */

export const emitRiderLocation = (orderId, location, extra = {}) => {
  if (!orderId) return;

  const payload = {
    orderId,
    location,
    ...extra,
  };

  safeEmit(`order-${orderId}`, "rider-location-updated", payload);
  safeEmit(`order-${orderId}`, "RIDER_LOCATION_UPDATED", payload);

  if (extra?.userId) {
    safeEmit(`user-${extra.userId}`, "rider-location-updated", payload);
  }

  if (extra?.vendorId) {
    safeEmit(`vendor-${extra.vendorId}`, "rider-location-updated", payload);
  }
};

/* =========================
   NEW ORDER ALERT TO VENDOR
========================= */

export const emitNewOrder = (vendorId, order) => {
  if (!vendorId || !order) return;

  const payload = {
    id: order.id,
    orderId: order.id,
    orderNumber: order.orderNumber,
    totalAmount: order.totalAmount,
    status: order.status,
    customer: order.user || order.customer,
    user: order.user || order.customer,
    items: order.items,
    restaurant: order.restaurant,
    order,
    createdAt: order.createdAt,
  };

  safeEmit(`vendor-${vendorId}`, "NEW_ORDER", payload);
  safeEmit(`vendor-${vendorId}`, "vendor:newOrder", payload);
  safeEmit(`vendor-${vendorId}`, "new-order", payload);

  safeEmit(`vendor-${vendorId}`, "VENDOR_DASHBOARD_REFRESH", {
    reason: "NEW_ORDER",
    order,
  });

  safeEmit("admin", "NEW_ORDER", payload);
  safeEmit("admin", "new-order-created", payload);
};

/* =========================
   USER ORDER EVENTS
========================= */

export const emitUserOrderCreated = (userId, order) => {
  if (!userId || !order) return;

  const payload = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    order,
    createdAt: order.createdAt,
  };

  safeEmit(`user-${userId}`, "ORDER_CREATED", payload);
  safeEmit(`user-${userId}`, "order-created", payload);
  safeEmit(`user-${userId}`, "order-updated", payload);
};

/* =========================
   VENDOR DASHBOARD
========================= */

export const emitVendorDashboardUpdate = (vendorId, payload = {}) => {
  if (!vendorId) return;

  safeEmit(`vendor-${vendorId}`, "VENDOR_DASHBOARD_REFRESH", payload);
  safeEmit(`vendor-${vendorId}`, "vendor:dashboardRefresh", payload);
};

export const emitVendorDashboardRefresh = (vendorId, payload = {}) => {
  emitVendorDashboardUpdate(vendorId, payload);
};

export const emitVendorOrderStatus = (vendorId, payload = {}) => {
  if (!vendorId) return;

  safeEmit(`vendor-${vendorId}`, "ORDER_STATUS_UPDATED", payload);
  safeEmit(`vendor-${vendorId}`, "vendor:orderStatusUpdated", payload);
  safeEmit(`vendor-${vendorId}`, "VENDOR_DASHBOARD_REFRESH", {
    reason: "ORDER_STATUS_UPDATED",
    ...payload,
  });
};

export const emitVendorRiderAssigned = (vendorId, payload = {}) => {
  if (!vendorId) return;

  safeEmit(`vendor-${vendorId}`, "RIDER_ASSIGNED", payload);
  safeEmit(`vendor-${vendorId}`, "vendor:riderAssigned", payload);
  safeEmit(`vendor-${vendorId}`, "VENDOR_DASHBOARD_REFRESH", {
    reason: "RIDER_ASSIGNED",
    ...payload,
  });
};

/* =========================
   SINGLE RIDER ASSIGNMENT
========================= */

export const emitRiderAssignment = (riderId, order) => {
  if (!riderId || !order) return;

  const payload = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    totalAmount: order.totalAmount,
    deliveryFee: order.deliveryFee,
    distanceKm: order.distanceKm,

    customer: order.customer || order.user,
    user: order.user || order.customer,
    vendor: order.vendor || order.restaurant,
    restaurant: order.restaurant || order.vendor,

    pickupAddress: order.pickupAddress,
    deliveryAddress: order.deliveryAddress || order.address,
    address: order.address || order.deliveryAddress,

    items: order.items,
    order,
    createdAt: order.createdAt,
  };

  safeEmit(`rider-${riderId}`, "NEW_RIDER_ORDER", payload);
  safeEmit(`rider-${riderId}`, "rider:newOrder", payload);
  safeEmit(`rider-${riderId}`, "RIDER_ORDER_ASSIGNED", payload);
  safeEmit(`rider-${riderId}`, "new-order-assignment", payload);
};

/* =========================
   CITY RIDER BROADCAST
========================= */

export const broadcastToCityRiders = (cityId, event, payload = {}) => {
  if (!cityId || !event) return;

  safeEmit(`rider-city-${cityId}`, event, payload);
};

/* =========================
   ADMIN
========================= */

export const emitToAdmin = (event, payload = {}) => {
  safeEmit("admin", event, payload);
};

/* =========================
   RIDER ACCEPTED
========================= */

export const emitRiderAccepted = (riderId, order) => {
  if (!riderId || !order) return;

  const payload = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    order,
  };

  safeEmit(`rider-${riderId}`, "ORDER_ACCEPTED", payload);
  safeEmit(`rider-${riderId}`, "rider:orderAccepted", payload);

  if (order.vendorId) {
    emitVendorRiderAssigned(order.vendorId, payload);
  }

  if (order.userId) {
    safeEmit(`user-${order.userId}`, "RIDER_ASSIGNED", payload);
    safeEmit(`user-${order.userId}`, "order-updated", payload);
  }

  safeEmit("admin", "RIDER_ACCEPTED_ORDER", payload);
};

/* =========================
   RIDER REJECTED
========================= */

export const emitRiderRejected = (riderId, orderId) => {
  if (!riderId || !orderId) return;

  const payload = {
    orderId,
    rejectedAt: now(),
  };

  safeEmit(`rider-${riderId}`, "ORDER_REJECTED", payload);
  safeEmit(`rider-${riderId}`, "rider:orderRejected", payload);
  safeEmit("admin", "RIDER_REJECTED_ORDER", payload);
};

/* =========================
   ROOM HELPERS
========================= */

export const joinUserRoom = (socket, userId) => {
  if (!socket || !userId) return;
  socket.join(`user-${userId}`);
};

export const leaveUserRoom = (socket, userId) => {
  if (!socket || !userId) return;
  socket.leave(`user-${userId}`);
};

export const joinVendorRoom = (socket, vendorId) => {
  if (!socket || !vendorId) return;
  socket.join(`vendor-${vendorId}`);
};

export const leaveVendorRoom = (socket, vendorId) => {
  if (!socket || !vendorId) return;
  socket.leave(`vendor-${vendorId}`);
};

export const joinRiderRoom = (socket, riderId) => {
  if (!socket || !riderId) return;
  socket.join(`rider-${riderId}`);
};

export const leaveRiderRoom = (socket, riderId) => {
  if (!socket || !riderId) return;
  socket.leave(`rider-${riderId}`);
};

export const joinOrderRoom = (socket, orderId) => {
  if (!socket || !orderId) return;
  socket.join(`order-${orderId}`);
};

export const leaveOrderRoom = (socket, orderId) => {
  if (!socket || !orderId) return;
  socket.leave(`order-${orderId}`);
};

export const joinAdminRoom = (socket) => {
  if (!socket) return;
  socket.join("admin");
};

export const leaveAdminRoom = (socket) => {
  if (!socket) return;
  socket.leave("admin");
};

export const joinRiderCityRoom = (socket, cityId) => {
  if (!socket || !cityId) return;
  socket.join(`rider-city-${cityId}`);
};

export const leaveRiderCityRoom = (socket, cityId) => {
  if (!socket || !cityId) return;
  socket.leave(`rider-city-${cityId}`);
};

/* =========================
   GLOBAL ANNOUNCEMENT
========================= */

export const emitAnnouncement = (message) => {
  safeBroadcast("GLOBAL_ANNOUNCEMENT", {
    message,
    createdAt: now(),
  });
};

export default {
  setSocketInstance,
  getSocketInstance,

  emitOrderStatus,
  emitRiderLocation,
  emitNewOrder,
  emitUserOrderCreated,

  emitVendorDashboardUpdate,
  emitVendorDashboardRefresh,
  emitVendorOrderStatus,
  emitVendorRiderAssigned,

  emitRiderAssignment,
  broadcastToCityRiders,

  emitToAdmin,
  emitRiderAccepted,
  emitRiderRejected,

  joinUserRoom,
  leaveUserRoom,
  joinVendorRoom,
  leaveVendorRoom,
  joinRiderRoom,
  leaveRiderRoom,
  joinOrderRoom,
  leaveOrderRoom,
  joinAdminRoom,
  leaveAdminRoom,
  joinRiderCityRoom,
  leaveRiderCityRoom,

  emitAnnouncement,
};