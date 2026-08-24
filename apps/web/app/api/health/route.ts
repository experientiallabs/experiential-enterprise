import { jsonOk } from "@/lib/http";

export async function GET(): Promise<Response> {
  return jsonOk({ status: "healthy" });
}
