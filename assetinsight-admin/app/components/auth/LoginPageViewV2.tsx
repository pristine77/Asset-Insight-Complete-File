"use client";

import LoginFormV2 from "@/app/components/auth/LoginFormV2";
import ThemeModeToggle from "@/app/components/common/ThemeModeToggle";

export default function LoginPageViewV2() {
  return (
    <>
      <div className="fixed right-5 top-5 z-[60] sm:right-8 sm:top-8">
        <ThemeModeToggle />
      </div>
      <LoginFormV2 />
    </>
  );
}
