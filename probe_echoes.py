#!/usr/bin/env python3
"""
probe_echoes.py  --  inspect how a Bruker multiframe DICOM interleaves
slices and echoes, so the T2 MSME volume can be de-interleaved correctly.

Run this on the scan that looks striped, e.g.:
    python probe_echoes.py '/path/.../1/pdata/1/dicom/SCAN6.dcm'
    python probe_echoes.py '/path/.../<study>/6'      # finds the dicom for you

It prints, per frame: the EffectiveEchoTime and the slice position, then
reports how many distinct echoes and slices it found and which dimension
varies fastest (the interleave order).
"""

import sys
import glob
import os

import numpy as np
import pydicom


def find_dicom(path):
    if os.path.isfile(path):
        return path
    hits = glob.glob(os.path.join(path, "**", "dicom", "*.dcm"), recursive=True)
    if not hits:
        hits = glob.glob(os.path.join(path, "**", "*.dcm"), recursive=True)
    if not hits:
        raise SystemExit(f"No .dcm found under {path}")
    return sorted(hits)[0]


def frame_echo_time(frame):
    """EffectiveEchoTime from a PerFrameFunctionalGroups item."""
    try:
        return float(frame.MREchoSequence[0].EffectiveEchoTime)
    except Exception:
        pass
    try:                                  # some exports use plain EchoTime
        return float(frame.MREchoSequence[0].EchoTime)
    except Exception:
        return None


def frame_slice_pos(frame):
    """Through-plane position from PlanePositionSequence (z of ImagePosition)."""
    try:
        ipp = frame.PlanePositionSequence[0].ImagePositionPatient
        return float(ipp[2])
    except Exception:
        return None


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python probe_echoes.py <dcm file or scan folder>")
    path = find_dicom(sys.argv[1])
    print(f"Reading: {path}\n")

    ds = pydicom.dcmread(path, stop_before_pixels=True)
    n_frames = int(getattr(ds, "NumberOfFrames", 0))
    pfg = getattr(ds, "PerFrameFunctionalGroupsSequence", None)
    if not pfg:
        raise SystemExit("No PerFrameFunctionalGroupsSequence -- not multiframe "
                         "enhanced DICOM, so slices/echoes aren't interleaved here.")

    print(f"NumberOfFrames = {n_frames}\n")
    echoes, positions = [], []
    for fr in pfg:
        echoes.append(frame_echo_time(fr))
        positions.append(frame_slice_pos(fr))

    uniq_te = sorted({round(e, 3) for e in echoes if e is not None})
    uniq_pos = sorted({round(p, 3) for p in positions if p is not None})
    n_te, n_pos = len(uniq_te), len(uniq_pos)

    print(f"distinct echo times : {n_te}  -> {uniq_te}")
    print(f"distinct slice posns: {n_pos}")
    if n_te and n_pos:
        print(f"product {n_te} x {n_pos} = {n_te * n_pos}  (frames = {n_frames})")

    # Show the first 14 frames so the interleave pattern is visible by eye
    print("\nframe :   echoTE   slicePos")
    for idx in range(min(14, len(echoes))):
        te = echoes[idx]
        pos = positions[idx]
        te_s = f"{te:7.2f}" if te is not None else "   None"
        pos_s = f"{pos:8.3f}" if pos is not None else "    None"
        print(f"  {idx:>3} : {te_s}  {pos_s}")

    # Decide which dimension varies fastest between consecutive frames
    if n_te > 1 and n_pos > 1:
        te_changes = sum(1 for a, b in zip(echoes, echoes[1:]) if a != b)
        pos_changes = sum(1 for a, b in zip(positions, positions[1:]) if a != b)
        faster = "ECHO varies fastest (slice outer, echo inner)" \
            if te_changes > pos_changes else \
            "SLICE varies fastest (echo outer, slice inner)"
        print(f"\nInterleave order: {faster}")
        print("  -> reshape with this order before de-interleaving.")
    else:
        print("\nCould not read both echo and slice metadata; "
              "fall back to assuming the smaller count is echoes.")


if __name__ == "__main__":
    main()
