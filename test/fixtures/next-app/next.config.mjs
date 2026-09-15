import path from "node:path";
import { fileURLToPath } from "node:url";

// This app lives inside another package (next-snapshot) that has its own
// lockfile; without an explicit root, Next guesses the outer one.
/** @type {import('next').NextConfig} */
export default {
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};
