// Vite `?raw` imports: acceptance.test.ts reads the committed parity .snap files as text.
// Kept in its own file (no imports/exports) so the declaration is ambient, not an augmentation.
declare module "*?raw" {
  const content: string;
  export default content;
}
