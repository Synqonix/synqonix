import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

// The public front page: an absolute title and a social preview, since it is what search engines and links show.
export const metadata: Metadata = {
  title: { absolute: "Synqonix — project management built for developers" },
  description: "Tasks, sprints and team chat that come to your editor: plan and track work without leaving VS Code. Self-hostable.",
  openGraph: {
    title: "Synqonix — project management built for developers",
    description: "Tasks, sprints and team chat that come to your editor: plan and track work without leaving VS Code.",
    type: "website",
  },
};

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Synqonix</h1>
        <ThemeToggle />
      </div>
      <p className="text-muted-foreground">
        Project management built for developers — tasks, boards, sprints and a VS Code extension.
      </p>
      <div className="flex gap-3">
        <Button asChild><Link href="/register">Get started</Link></Button>
        <Button asChild variant="outline"><Link href="/login">Sign in</Link></Button>
      </div>
    </main>
  );
}
