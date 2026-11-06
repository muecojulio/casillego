import { createFileRoute, Link } from "@tanstack/react-router";
import { Mark } from "@/components/casillego-app";
import { PrivacyCopy } from "@/components/privacy-copy";

export const Route = createFileRoute("/privacidad")({
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-lg px-5 py-8">
      <Link to="/" className="text-sm text-muted">
        Volver
      </Link>
      <div className="mt-6 flex items-center gap-3">
        <Mark />
        <h1 className="font-display text-4xl">Privacidad</h1>
      </div>
      <div className="mt-6">
        <PrivacyCopy />
      </div>
    </main>
  );
}
