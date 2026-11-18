import type { Metadata } from "next";
import View from "./view";

// The key in the URL (e.g. SYN-12) is a good tab title and needs no data: tasks load in the browser.
export async function generateMetadata({ params }: PageProps<"/w/[workspaceId]/tasks/[taskRef]">): Promise<Metadata> {
  return { title: decodeURIComponent((await params).taskRef).toUpperCase() };
}

export default function Page() {
  return <View />;
}
