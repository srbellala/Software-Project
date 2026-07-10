import { Card } from "../../components/Card";
import { DropZone } from "../../components/DropZone";
import { FileList } from "../../components/FileList";
import { Button } from "../../components/Button";
import { useAppStore } from "../../store/appStore";
import { clearScan, loadDemo, reopenBrukerBrowser, uploadScan } from "../../actions/loadActions";

export function ScanUploadCard() {
  const modality = useAppStore((s) => s.modality);
  const scanFiles = useAppStore((s) => s.scanFiles);
  const scanReady = useAppStore((s) => s.scanReady);
  const brukerStudyLoaded = useAppStore((s) => s.brukerStudyLoaded);
  const brukerZipTitle = useAppStore((s) => s.brukerZipTitle);

  const hint =
    modality === "T2"
      ? "Upload a 4D DICOM (.dcm), a folder of per-echo NIfTI files, or a Bruker Study ZIP"
      : "Upload one NIfTI volume per flip angle (.nii / .nii.gz), or a Bruker Study ZIP";

  return (
    <Card title="Scan Files" subtitle={hint} onClear={clearScan} clearDisabled={!scanReady} clearTitle="Clear uploaded scan">
      <DropZone
        icon="📂"
        label="Drop Files here or Click to Browse"
        hint="DICOM (.dcm) · NIfTI (.nii / .nii.gz) · Bruker Study (.zip)"
        accept=".dcm,.nii,.nii.gz,.zip,application/zip,application/x-zip-compressed,application/octet-stream"
        multiple
        onFiles={uploadScan}
      />

      <FileList items={scanFiles} />

      {brukerStudyLoaded && (
        <Button variant="ghost" small className="mt-2 w-full justify-center" onClick={reopenBrukerBrowser}>
          ↩ Reopen {brukerZipTitle}
        </Button>
      )}

      <a
        onClick={loadDemo}
        className="mt-1.5 inline-block cursor-pointer text-xs text-accent hover:underline"
      >
        ↳ Load Sample Dataset
      </a>
    </Card>
  );
}
