"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; count?: number; group?: string };

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="주 메뉴">
      {items.map((it, i) => {
        const showGroup = it.group && it.group !== items[i - 1]?.group;
        const active = it.href === "/" ? path === "/" : path === it.href || path.startsWith(it.href + "/");
        return (
          <span key={it.href} style={{ display: "contents" }}>
            {showGroup && <div className="nav-group" aria-hidden="true">{it.group}</div>}
            <Link href={it.href} aria-current={active ? "page" : undefined}>
              <span>{it.label}</span>
              {it.count ? <span className="count" aria-label={`${it.count}건`}>{it.count}</span> : null}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
