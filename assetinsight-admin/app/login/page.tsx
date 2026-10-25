import { Suspense } from "react";
import LoginPageViewV2 from "@/app/components/auth/LoginPageViewV2";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginPageViewV2 />
    </Suspense>
  );
}
