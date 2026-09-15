"use client";

import { useRouter } from "next/navigation";

// router.replace: a soft navigation live, a full one offline.
export default function YearFilter({ year }) {
  const router = useRouter();
  return (
    <select id="year-select" value={year} onChange={(e) => router.replace(`/?year=${e.target.value}`)}>
      <option value="2025">2025</option>
      <option value="2026">2026</option>
    </select>
  );
}
