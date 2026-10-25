import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // No timeout field - allows unlimited processing time for long-running AI analysis
  maxRetries: 3, // Retry on network errors
});

export default openai;
