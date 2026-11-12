// The repository files the harness reads, embedded by typescript/scripts/conformance-browser.mjs: path suffix -> text.
declare module 'caitlyn:files' {
  const files: Record<string, string>;
  export default files;
}
