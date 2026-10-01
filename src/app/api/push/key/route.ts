// Publieke VAPID-sleutel voor de browser (publiek van aard). Zo hoeft hij geen NEXT_PUBLIC_-variabele te zijn.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
}
