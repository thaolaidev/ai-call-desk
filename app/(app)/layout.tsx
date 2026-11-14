import { SideShell } from "@/components/SideShell";
import { Toaster } from "@/components/Toast";
import { signOut } from "../login/actions";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return (
    <div className="app">
      <SideShell email={data.user?.email ?? null} signOut={signOut} />
      <main className="main">{children}</main>
      <Toaster />
    </div>
  );
}
