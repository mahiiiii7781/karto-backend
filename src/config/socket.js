let ioInstance = null;

export const setSocketInstance = (io) => {
  ioInstance = io;
};

export const getSocketInstance = () => ioInstance;

export const emitOrderStatus = (orderId, status, data = {}) => {
  if (!ioInstance) return;

  ioInstance.to(`order:${orderId}`).emit("orderStatusUpdated", {
    orderId,
    status,
    ...data,
  });
};

export const emitRiderLocation = (orderId, location) => {
  if (!ioInstance) return;

  ioInstance.to(`order:${orderId}`).emit("riderLocationUpdated", {
    orderId,
    location,
  });
};