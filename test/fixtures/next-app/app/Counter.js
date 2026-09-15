"use client";

import { useState } from "react";

// Client state: works offline only if React hydrated.
export default function Counter() {
  const [n, setN] = useState(0);
  return (
    <button id="count" onClick={() => setN(n + 1)}>
      count: {n}
    </button>
  );
}
