import { Nav } from "@/components/Nav";
import { signOut } from "../login/actions";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo-light" src="/logo.png" alt="Thaolai.com" width={156} height={30} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo-dark" src="/logo-yellow.png" alt="Thaolai.com" width={156} height={30} />
          <b>ห้องโทร AI</b>
        </div>
        <Nav />
        <div className="side-foot">
          <span>{data.user?.email}</span>
          <form action={signOut}>
            <button type="submit">ออกจากระบบ</button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
