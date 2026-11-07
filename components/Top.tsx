export function Top({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <header className="top">
      <div className="ttl">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </header>
  );
}
