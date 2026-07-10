import { ModalityToggle } from "../components/Navbar";
import { ScanUploadCard } from "./load/ScanUploadCard";
import { SegmentationUploadCard } from "./load/SegmentationUploadCard";
import { AlignmentCard } from "./load/AlignmentCard";

export function LoadStep() {
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[940px]">
        <ModalityToggle variant="card" />
        <div className="flex flex-wrap gap-5">
          <div className="flex min-w-80 flex-1 flex-col gap-5">
            <ScanUploadCard />
            <SegmentationUploadCard />
          </div>
          <div className="flex w-70 flex-shrink-0 flex-col">
            <AlignmentCard />
          </div>
        </div>
      </div>
    </div>
  );
}
