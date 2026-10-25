import { Suspense } from "react";
import LoginForm from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
