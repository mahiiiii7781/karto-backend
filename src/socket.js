import { Server } from "socket.io";

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
    },
  });

  io.on("connection", (socket) => {
    socket.on("rider-online", (riderId) => {
      socket.join(`rider-${riderId}`);
      socket.join("riders");
    });

    socket.on("disconnect", () => {});
  });

  return io;
};

export const getIO = () => io;