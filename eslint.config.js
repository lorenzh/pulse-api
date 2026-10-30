import base from "@lorenzh/pulse-config/eslint.config.js";

// ESLint 10 picks the nearest config per file; keep the read-only clones in `.repos/` and the bench workspace in `.bench/` out.
export default [{ ignores: [".repos/**", ".bench/**", "bench-out/**"] }, ...base];
