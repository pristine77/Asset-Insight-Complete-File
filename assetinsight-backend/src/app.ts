import dotenv from "dotenv";
import express from "express";
import { configureApplication } from "./bootstrap/configureApplication.js";

dotenv.config();

// This stable module is imported by production and integration tests. Socket,
// database, scheduler, and process lifecycle concerns remain outside Express.
export const app = configureApplication(express());

export default app;
