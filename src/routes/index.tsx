import { createFileRoute } from "@tanstack/react-router";
import { CasillegoApp } from "@/components/casillego-app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <CasillegoApp />;
}
