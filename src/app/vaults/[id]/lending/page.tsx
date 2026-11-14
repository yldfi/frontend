import { permanentRedirect } from "next/navigation";

// The lending market was retired; old lending URLs go to the vault page.
export default async function LendingRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/vaults/${encodeURIComponent(id)}`);
}
