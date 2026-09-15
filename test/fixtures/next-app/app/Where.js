"use client";

import { usePathname } from "next/navigation";

// Next derives this from window.location: offline, it must come out as the
// page's real path, not the file's.
export default function Where() {
  return <span id="path">{usePathname()}</span>;
}
