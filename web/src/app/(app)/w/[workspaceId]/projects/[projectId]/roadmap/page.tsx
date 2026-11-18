import type { Metadata } from "next";
import View from "./view";

export const metadata: Metadata = { title: "Roadmap" };

/** Server component for the page metadata; everything interactive lives in the client view. */
export default function Page() {
  return <View />;
}
