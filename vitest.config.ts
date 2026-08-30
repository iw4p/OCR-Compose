import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The Studio's components are tested too, so JSX has to be transformed. Those
// files ask for a DOM with a `@vitest-environment jsdom` docblock; everything
// else stays on the default node environment.
export default defineConfig({
  plugins: [react()],
});
