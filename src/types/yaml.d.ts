// wrangler's "Text" module rule (see wrangler.jsonc) makes *.yaml imports
// resolve to their raw file contents as a string at build time.
declare module "*.yaml" {
  const content: string;
  export default content;
}
