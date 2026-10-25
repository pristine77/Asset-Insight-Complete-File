import { redirect } from "next/navigation";

export default function Page() {
  // Redirect to reports - accessible to all roles
  redirect("/reports");
}
