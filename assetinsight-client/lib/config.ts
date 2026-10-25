export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000/api";

// Server base URL (without /api suffix) for static files like uploads
export const SERVER_BASE = API_BASE.replace(/\/api$/, "");
