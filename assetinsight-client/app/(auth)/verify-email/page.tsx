import { Suspense } from "react";
import VerifyEmailForm from "@/components/auth/VerifyEmailForm";

// Force dynamic rendering to avoid static generation issues with useSearchParams
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailForm />
    </Suspense>
  );
}
