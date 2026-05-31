let ioInstance = null;

export const setSocketInstance = (io) => {
  ioInstance = io;
};

export const getSocketInstance = () => ioInstance;

/* =========================
   ORDER STATUS
========================= */

export const emitOrderStatus = (
  orderId,
  status,
  data = {}
) => {
  if (!ioInstance) return;

  ioInstance.to(`order:${orderId}`).emit(
    "orderStatusUpdated",
    {
      orderId,
      status,
      ...data,
    }
  );
};

/* =========================
   RIDER LOCATION
========================= */

export const emitRiderLocation = (
  orderId,
  location
) => {
  if (!ioInstance) return;

  ioInstance.to(`order:${orderId}`).emit(
    "riderLocationUpdated",
    {
      orderId,
      location,
    }
  );
};

/* =========================
   NEW ORDER ALERT
========================= */

export const emitNewOrder = (
  vendorId,
  order
) => {
  if (!ioInstance) return;

  ioInstance
    .to(`vendor:${vendorId}`)
    .emit("NEW_ORDER", {
      id: order.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      status: order.status,
      customer: order.user,
      items: order.items,
      restaurant: order.restaurant,
      createdAt: order.createdAt,
    });
};

/* =========================
   VENDOR DASHBOARD
========================= */

export const emitVendorDashboardUpdate = (
  vendorId
) => {
  if (!ioInstance) return;

  ioInstance
    .to(`vendor:${vendorId}`)
    .emit("VENDOR_DASHBOARD_REFRESH");
};

/* =========================
   NEW RIDER ASSIGNMENT
========================= */

export const emitRiderAssignment = (
  riderId,
  order
) => {
  if (!ioInstance) return;

  ioInstance
    .to(`rider:${riderId}`)
    .emit("NEW_RIDER_ORDER", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      restaurant: order.restaurant,
      customerAddress: order.address,
    });
};

/* =========================
   GLOBAL ANNOUNCEMENT
========================= */

export const emitAnnouncement = (
  message
) => {
  if (!ioInstance) return;

  ioInstance.emit(
    "GLOBAL_ANNOUNCEMENT",
    {
      message,
      createdAt: new Date(),
    }
  );
};