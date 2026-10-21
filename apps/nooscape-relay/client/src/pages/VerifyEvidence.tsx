import { useRef, useState } from "react";
import { Check, ChevronLeft, FileJson2, Fingerprint, KeyRound, Loader2, ShieldAlert, ShieldCheck, Upload, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type EvidenceEntry = {
  id: string;
  observedAt: string;
  event: string;
  detail: string;
  source: string;
  proofReference: string;
};

/** What the verifier says about the key that signed the packet (keyStatus in the verifier's answer). */
const KEY_STATUS_LABEL = {
  active: "Active Nooscape relay key",
  retired: "Retired Nooscape relay key",
  revoked: "Revoked Nooscape relay key",
  unknown: "Unpinned external or demo key",
} as const;

type EvidencePacket = {
  format: "Nooscape Signed Evidence Envelope v1";
  exportedAt: string;
  verification: {
    signatureAlgorithm: string;
    signedField: string;
    publicKeyPem: string;
    instructions: string;
  };
  envelope: {
    agentId: string;
    observedAt: string;
    sequence: number;
    algorithm: string;
    integrityHash: string;
    signatureAlgorithm: string;
    signature: string;
    relayPublicKeyPem: string;
    canonicalPayload: string;
    relayMode: string;
    entries: EvidenceEntry[];
  };
};

export default function VerifyEvidence() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [packet, setPacket] = useState<EvidencePacket | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const verifyEvidence = trpc.atlas.verifyEvidence.useMutation();

  const selectFile = () => inputRef.current?.click();
  const handleFile = async (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    setParseError(null);
    verifyEvidence.reset();
    try {
      if (file.size > 256_000) throw new Error("Packet exceeds the 256 KB review limit.");
      const parsed = JSON.parse(await file.text()) as EvidencePacket;
      setPacket(parsed);
      verifyEvidence.mutate({ packet: parsed });
    } catch (error) {
      setPacket(null);
      setParseError(error instanceof Error ? error.message : "The selected file is not a valid JSON evidence packet.");
    }
  };

  const result = verifyEvidence.data;
  const isValid = result?.valid === true;
  const statusLabel = verifyEvidence.isPending ? "Validating packet" : isValid ? "Evidence integrity confirmed" : result ? "Evidence validation failed" : "Awaiting packet";

  return <main className="verification-page min-h-screen overflow-hidden bg-[#06070B] text-[#EAF7EE]">
    <div className="verification-grid" />
    <header className="verification-header"><a href="/" className="verification-home"><span className="verification-mark"><Fingerprint size={17} /></span><span><strong>NOOSCAPE</strong><em>Evidence verifier</em></span></a><a href="/" className="verification-back"><ChevronLeft size={15} /> Atlas</a></header>
    <section className="verification-shell">
      <div className="verification-intro"><p className="verification-kicker"><span /> PUBLIC CRYPTOGRAPHIC REVIEW</p><h1>Verify an<br /><span>evidence packet.</span></h1><p>Upload a JSON file exported from a Nooscape signal record. The verifier recomputes the payload digest, validates the Ed25519 signature, and requires the signing key to be listed in Nooscape’s published relay-key manifest, and refuses a key marked revoked.</p><div className="verification-steps"><span><b>01</b> Upload JSON</span><i /><span><b>02</b> Check digest</span><i /><span><b>03</b> Check pinned relay key</span></div></div>
      <div className="verification-workspace">
        <input ref={inputRef} type="file" accept="application/json,.json" className="verification-file-input" onChange={event => handleFile(event.target.files?.[0])} />
        <button type="button" onClick={selectFile} className={cn("verification-dropzone", (verifyEvidence.isPending || result) && "verification-dropzone-occupied")}>
          <span className="verification-drop-icon">{verifyEvidence.isPending ? <Loader2 className="animate-spin" size={25} /> : result ? (isValid ? <ShieldCheck size={26} /> : <ShieldAlert size={26} />) : <Upload size={25} />}</span>
          <span><strong>{statusLabel}</strong><em>{fileName ?? "Choose a .json export from the Nooscape record drawer"}</em></span>
          <span className="verification-upload-action">{packet ? "Replace file" : "Choose file"}</span>
        </button>
        {parseError && <div className="verification-error"><X size={15} />{parseError}</div>}
        {result && <section className={cn("verification-result", isValid ? "verification-result-valid" : "verification-result-invalid")}><div className="verification-result-head"><span>{isValid ? <ShieldCheck size={19} /> : <ShieldAlert size={19} />}</span><div><p>{isValid ? "Packet verified by Nooscape" : "Packet rejected"}</p><h2>{result.agentId || "Unknown signal"}</h2></div><em>seq {result.sequence}</em></div><div className="verification-checks"><VerificationCheck label="SHA-256 digest" valid={result.hashValid} /><VerificationCheck label="Ed25519 signature" valid={result.signatureValid} /><VerificationCheck label="Embedded keys agree" valid={result.keyMatchesEnvelope} /><VerificationCheck label="Pinned Nooscape relay key" valid={result.verifiedByNooscape} /></div><div className="verification-record"><span><FileJson2 size={14} /> {result.entryCount} evidence entries</span><span><KeyRound size={14} /> {result.signatureAlgorithm}</span><span><Fingerprint size={14} /> {KEY_STATUS_LABEL[result.keyStatus]}</span></div>{result.issues.length > 0 && <ul className="verification-issues">{result.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}<p className="verification-boundary">A verified packet proves that it was signed by a Nooscape relay key listed in the published manifest and has not been altered since signing. A key that has been replaced is shown as retired: it signed the packet before the change, and the packet still verifies. It does not independently establish the real-world truth, safety, or ownership of the claimed agent; review the source labels and provenance separately.</p></section>}
      </div>
    </section>
    <footer className="verification-footer">Nooscape / public verifier · No file bytes are retained by this prototype review flow.</footer>
  </main>;
}

function VerificationCheck({ label, valid }: { label: string; valid: boolean }) {
  return <div className={cn("verification-check", valid && "verification-check-valid")}><span>{valid ? <Check size={13} /> : <X size={13} />}</span><strong>{label}</strong><em>{valid ? "pass" : "fail"}</em></div>;
}
