import { useEffect } from "react";
import { Navbar } from "./components/Navbar";
import { WizardHeader } from "./components/WizardHeader";
import { ToastArea } from "./components/ToastArea";
import { BrukerModal } from "./components/BrukerModal";
import { LoadStep } from "./steps/LoadStep";
import { PreviewStep } from "./steps/PreviewStep";
import { FitStep } from "./steps/FitStep";
import { OutputStep } from "./steps/OutputStep";
import { useAppStore } from "./store/appStore";
import { loadDemo } from "./actions/loadActions";

function App() {
  const step = useAppStore((s) => s.step);

  // Landing page's "Try with Sample Data" sets this before navigating here.
  useEffect(() => {
    if (sessionStorage.getItem("rl_demo") === "1") {
      sessionStorage.removeItem("rl_demo");
      loadDemo();
    }
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Navbar />
      <div className="flex-1 overflow-y-auto px-8 pt-7 pb-12">
        <WizardHeader />
        {step === 1 && <LoadStep />}
        {step === 2 && <PreviewStep />}
        {step === 3 && <FitStep />}
        {step === 4 && <OutputStep />}
      </div>
      <ToastArea />
      <BrukerModal />
    </div>
  );
}

export default App;
