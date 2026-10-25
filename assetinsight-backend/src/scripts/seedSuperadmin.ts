import "dotenv/config";
import connectDB from "../config/database.js";
import { seedSuperAdmin } from "../service/adminService.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out as {
    email?: string;
    password?: string;
    username?: string;
    companyName?: string;
  };
}

async function main() {
  try {
    await connectDB();
    const argv = parseArgs();

    const email =
      argv.email || process.env.SUPERADMIN_EMAIL || "superadmin@clearvalue.com";
    const password =
      argv.password || process.env.SUPERADMIN_PASSWORD || "superadmin";
    const username =
      argv.username || process.env.SUPERADMIN_USERNAME || "superadmin";
    const companyName =
      argv.companyName || process.env.SUPERADMIN_COMPANY || "Asset Insight";

    if (!email || !password) {
      console.error(
        "Missing SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD (or pass --email/--password)."
      );
      process.exit(1);
    }

    const result = await seedSuperAdmin({
      email,
      password,
      username,
      companyName,
    });
    console.log(
      result.created
        ? `✅ Superadmin created: ${result.email}`
        : `✅ Superadmin ensured: ${result.email}`
    );
    process.exit(0);
  } catch (err: any) {
    console.error("❌ Failed to seed superadmin:", err?.message || err);
    process.exit(1);
  }
}

main();
