/**
 * All editable copy for the landing page, in one place. LandingPage.tsx
 * renders straight from this — edit the strings here (or in the mirrored
 * plain-text file at relaxometry_lab/LANDING_PAGE_COPY.txt, then copy the
 * changes back in) and they show up on the page with no other changes.
 */

export interface CardTag {
  label: string;
  gray?: boolean;
}

export interface FeatureCard {
  icon: string;
  iconBg: string;
  title: string;
  desc: string;
  tags: CardTag[];
  linkToTool?: boolean; // true = clicking the card opens the tool
  comingSoon?: boolean;
}

export interface ResourceCardContent {
  icon: string;
  title: string;
  desc: string;
  href: string;
  external?: boolean;
  isDemoLink?: boolean; // true = sets the "load sample data" flag before navigating
}

export const landingContent = {
  nav: {
    brand: "Relaxometry Lab",
    openTool: "Open Tool",
  },

  hero: {
    badge: "Open Source · Browser-Based · No Install Required",
    title: "Relaxometry Lab",
    subtitlePrefix: "MRI T",
    subtitleMid: " and T",
    subtitleSuffix:
      " relaxometry fitting for preclinical data — directly in your browser.",
    primaryCta: "Open T₂ / T₁ Tool →",
    secondaryCta: "Try with Sample Data",
  },

  tools: {
    eyebrow: "Tools",
    title: "What can you fit?",
    subtitle: "Upload DICOM, NIfTI, or a Bruker study ZIP — the tool handles the rest.",
    cards: [
      {
        icon: "🔵",
        iconBg: "#dbeeff",
        title: "T₂ Relaxometry",
        desc: "Mono-exponential T₂ mapping from multi-echo spin-echo data. Voxel-by-voxel curve fitting with quality-filtered output maps.",
        tags: [{ label: "MSME" }, { label: "CPMG" }, { label: "Multi-Echo" }],
        linkToTool: true,
      },
      {
        icon: "🟠",
        iconBg: "#fde8d0",
        title: "T₁ Relaxometry",
        desc: "Variable flip angle T₁ mapping from spoiled gradient echo data. Supports single-TR VFA with Ernst angle fitting.",
        tags: [{ label: "VFA" }, { label: "FLASH" }, { label: "SPGR" }],
        linkToTool: true,
      },
      {
        icon: "🟢",
        iconBg: "#e8f5e9",
        title: "T₂* / R₂* Mapping",
        desc: "Multi-echo gradient echo T₂* fitting with optional B₀ field correction and fat/water separation.",
        tags: [{ label: "MGE", gray: true }, { label: "GRE", gray: true }, { label: "mGRE", gray: true }],
        comingSoon: true,
      },
    ] satisfies FeatureCard[],
  },

  workflow: {
    eyebrow: "Workflow",
    title: "Four steps from data to result",
    subtitle: "No scripts. No command line. Works with DICOM, NIfTI, and raw Bruker exports.",
    steps: [
      { title: "Load Data", desc: "Upload DICOM, NIfTI, or a Bruker study ZIP. Optionally add a segmentation mask." },
      { title: "Preview", desc: "Browse your scan in 3-plane orthographic view, scroll slices, zoom, and verify alignment." },
      { title: "Fit", desc: "Run voxel-wise curve fitting. Explore individual decay curves and ROI statistics." },
      { title: "Export", desc: "Download NIfTI maps, CSV statistics, a multi-page PDF report, or raw NumPy arrays." },
    ],
  },

  dataFormats: {
    eyebrow: "Data Formats",
    title: "Supported inputs",
    subtitle: "Bring your data in any of these formats — no preprocessing needed.",
    cards: [
      {
        icon: "📁",
        iconBg: "#f3e8ff",
        title: "DICOM",
        desc: "Single enhanced multi-frame DICOM or a stack of per-slice single-frame files. Echo time read from standard tags.",
        tags: [{ label: ".dcm" }],
      },
      {
        icon: "🧊",
        iconBg: "#e8f5e9",
        title: "NIfTI",
        desc: "One file per echo (3D) or a single 4D volume. Echo times read from BIDS sidecar JSON when present.",
        tags: [{ label: ".nii" }, { label: ".nii.gz" }],
      },
      {
        icon: "🗜️",
        iconBg: "#fff8e1",
        title: "Bruker Study ZIP",
        desc: "Zip a Bruker ParaVision study folder and upload it directly. Browse all scans, pick one, and load with a click.",
        tags: [{ label: ".zip" }, { label: "ParaVision" }],
      },
    ] satisfies FeatureCard[],
  },

  resources: {
    eyebrow: "Resources",
    title: "Get started quickly",
    subtitle: "Sample data, documentation, and source code.",
    cards: [
      {
        icon: "🧪",
        title: "Sample Dataset",
        desc: "Load a synthetic multi-echo T₂ dataset directly in the tool — no file needed.",
        href: "/tool",
        isDemoLink: true,
      },
      {
        icon: "🐙",
        title: "GitHub",
        desc: "Source code, issue tracker, and contribution guide.",
        href: "https://github.com",
        external: true,
      },
      {
        icon: "📄",
        title: "Documentation",
        desc: "File format requirements, fitting model details, and export format descriptions.",
        href: "#",
      },
      {
        icon: "📬",
        title: "Report an Issue",
        desc: "Found a bug or have a feature request? Open an issue on GitHub.",
        href: "#",
      },
    ] satisfies ResourceCardContent[],
  },

  footer: "Relaxometry Lab · Open source MRI analysis · Built with FastAPI + React",
};
