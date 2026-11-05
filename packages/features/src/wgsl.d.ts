declare module "*.wgsl" {
  const source: string;
  export default source;
}

declare module "*.jpg" {
  const path: string;
  export default path;
}
