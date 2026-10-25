import dotenv from "dotenv";
import { startApiServer } from "./bootstrap/apiServer.js";

dotenv.config();

void startApiServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
