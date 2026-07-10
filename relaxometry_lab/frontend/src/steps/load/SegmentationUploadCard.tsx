import { Card } from "../../components/Card";
import { DropZone } from "../../components/DropZone";
import { FileList } from "../../components/FileList";
import { useAppStore } from "../../store/appStore";
import { clearSegmentation, uploadSegmentation } from "../../actions/loadActions";

export function SegmentationUploadCard() {
  const segFiles = useAppStore((s) => s.segFiles);

  return (
    <Card
      title={
        <>
          Segmentation Mask <span className="font-normal text-muted">(Optional)</span>
        </>
      }
      subtitle="NIfTI segmentation mask in the same voxel grid as your scan"
      onClear={clearSegmentation}
      clearDisabled={segFiles.length === 0}
      clearTitle="Clear uploaded segmentation"
    >
      <DropZone
        icon="🎭"
        label="Drop Segmentation Mask"
        hint=".nii / .nii.gz"
        accept=".nii,.nii.gz"
        onFiles={(files) => files[0] && uploadSegmentation(files[0])}
      />
      <FileList items={segFiles} />
    </Card>
  );
}
