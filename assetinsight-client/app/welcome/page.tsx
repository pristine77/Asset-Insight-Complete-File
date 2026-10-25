import CallToAction from "./components/CallToAction";
import CredibilitySection from "./components/CredibilitySection";
import FeatureGrid from "./components/FeatureGrid";
import HeroSection from "./components/HeroSection";
import OperationsCockpit from "./components/OperationsCockpit";
import WelcomeHeader from "./components/WelcomeHeader";

export default function WelcomePage() {
  return (
    <main className="min-h-screen overflow-x-hidden bg-[var(--app-bg)] text-[var(--app-text)]">
      <WelcomeHeader />
      <HeroSection />
      <FeatureGrid />
      <OperationsCockpit />
      <CredibilitySection />
      <CallToAction />
    </main>
  );
}
