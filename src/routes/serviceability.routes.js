import express from "express";
import {
  checkServiceability,
} from "../controllers/serviceability.controller.js";

const router = express.Router();

router.get("/", checkServiceability);

export default router;