import {
  derivedR1,
  derivedR2,
  type T1ParamState,
  type T2ParamState,
} from "./paramConfig";

function NumInput({ value, onChange, step }: { value: number; onChange: (v: number) => void; step: number }) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(e.target.valueAsNumber)}
      className="mx-auto block w-24 rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text focus:border-accent focus:outline-none"
    />
  );
}

function Dash() {
  return <span className="block text-center text-base text-muted">—</span>;
}

function Th({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return (
    <th className={`border-b-2 border-border px-3 py-2 text-[11px] font-bold tracking-[.06em] text-muted uppercase ${first ? "text-left" : "text-center"}`}>
      {children}
    </th>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <tr className="[&>td]:border-b [&>td]:border-[#eeede8] [&>td]:px-3 [&>td]:py-2.5">{children}</tr>;
}

function NameCell({ children, unit }: { children: React.ReactNode; unit?: string }) {
  return (
    <td className="min-w-40 text-[13px] text-text">
      {children}
      {unit && <span className="ml-0.5 text-[11px] font-normal text-muted">{unit}</span>}
    </td>
  );
}

interface ParamTableProps {
  modality: "T2" | "T1";
  t2: T2ParamState;
  onT2Change: (patch: Partial<T2ParamState>) => void;
  t1: T1ParamState;
  onT1Change: (patch: Partial<T1ParamState>) => void;
}

export function ParamTable({ modality, t2, onT2Change, t1, onT1Change }: ParamTableProps) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <Th first>Parameter</Th>
          <Th>Init</Th>
          <Th>Lower</Th>
          <Th>Upper</Th>
        </tr>
      </thead>
      <tbody>
        {modality === "T2" ? (
          <>
            <Row>
              <NameCell>
                S<sub>0</sub> ratio
              </NameCell>
              <td>
                <NumInput value={t2.s0RatioInit} step={0.01} onChange={(v) => onT2Change({ s0RatioInit: v })} />
              </td>
              <td>
                <NumInput value={t2.s0RatioLo} step={0.01} onChange={(v) => onT2Change({ s0RatioLo: v })} />
              </td>
              <td>
                <NumInput value={t2.s0RatioHi} step={0.1} onChange={(v) => onT2Change({ s0RatioHi: v })} />
              </td>
            </Row>
            <Row>
              <NameCell unit="(ms)">T2</NameCell>
              <td>
                <NumInput value={t2.t2Init} step={1} onChange={(v) => onT2Change({ t2Init: v })} />
              </td>
              <td>
                <NumInput value={t2.t2Lo} step={0.00001} onChange={(v) => onT2Change({ t2Lo: v })} />
              </td>
              <td>
                <NumInput value={t2.t2Hi} step={10} onChange={(v) => onT2Change({ t2Hi: v })} />
              </td>
            </Row>
            <tr className="bg-[#f5f4f0] [&>td]:border-b [&>td]:border-[#eeede8] [&>td]:px-3 [&>td]:py-2.5 [&>td]:text-muted">
              <NameCell unit="(s⁻¹)">R2</NameCell>
              {(() => {
                const d = derivedR2(t2);
                return (
                  <>
                    <td className="text-center font-mono text-xs text-muted">{d.init}</td>
                    <td className="text-center font-mono text-xs text-muted">{d.lo}</td>
                    <td className="text-center font-mono text-xs text-muted">{d.hi}</td>
                  </>
                );
              })()}
            </tr>
            <Row>
              <NameCell>Noise (C)</NameCell>
              <td>
                <NumInput value={t2.noiseInit} step={1} onChange={(v) => onT2Change({ noiseInit: v })} />
              </td>
              <td>
                <Dash />
              </td>
              <td>
                <Dash />
              </td>
            </Row>
            <Row>
              <NameCell unit="(ms)">T2 value filter</NameCell>
              <td>
                <Dash />
              </td>
              <td>
                <NumInput value={t2.threshLo} step={1} onChange={(v) => onT2Change({ threshLo: v })} />
              </td>
              <td>
                <NumInput value={t2.threshHi} step={10} onChange={(v) => onT2Change({ threshHi: v })} />
              </td>
            </Row>
            <Row>
              <NameCell>Min fit quality (R²)</NameCell>
              <td>
                <NumInput value={t2.r2Thresh} step={0.01} onChange={(v) => onT2Change({ r2Thresh: v })} />
              </td>
              <td>
                <Dash />
              </td>
              <td>
                <Dash />
              </td>
            </Row>
          </>
        ) : (
          <>
            <Row>
              <NameCell>
                S<sub>0</sub>
              </NameCell>
              <td>
                <NumInput value={t1.s0Init} step={100} onChange={(v) => onT1Change({ s0Init: v })} />
              </td>
              <td>
                <Dash />
              </td>
              <td>
                <Dash />
              </td>
            </Row>
            <Row>
              <NameCell unit="(ms)">T1</NameCell>
              <td>
                <NumInput value={t1.t1Init} step={10} onChange={(v) => onT1Change({ t1Init: v })} />
              </td>
              <td>
                <NumInput value={t1.t1Lo} step={1} onChange={(v) => onT1Change({ t1Lo: v })} />
              </td>
              <td>
                <NumInput value={t1.t1Hi} step={10} onChange={(v) => onT1Change({ t1Hi: v })} />
              </td>
            </Row>
            <tr className="bg-[#f5f4f0] [&>td]:border-b [&>td]:border-[#eeede8] [&>td]:px-3 [&>td]:py-2.5 [&>td]:text-muted">
              <NameCell unit="(s⁻¹)">R1</NameCell>
              {(() => {
                const d = derivedR1(t1);
                return (
                  <>
                    <td className="text-center font-mono text-xs text-muted">{d.init}</td>
                    <td className="text-center font-mono text-xs text-muted">{d.lo}</td>
                    <td className="text-center font-mono text-xs text-muted">{d.hi}</td>
                  </>
                );
              })()}
            </tr>
            <Row>
              <NameCell>Min fit quality (R²)</NameCell>
              <td>
                <NumInput value={t1.r2Thresh} step={0.01} onChange={(v) => onT1Change({ r2Thresh: v })} />
              </td>
              <td>
                <Dash />
              </td>
              <td>
                <Dash />
              </td>
            </Row>
          </>
        )}
      </tbody>
    </table>
  );
}
