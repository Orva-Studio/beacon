import { useEffect, useState } from "react";

/** The result of a read-only query of the open project, rerun when `args` or `again` change; undefined until it answers, if it fails or with no `name`. */
export function useQuery<T>(host: { query(name: string, args?: unknown): Promise<unknown> }, name: string, args: unknown = {}, again?: unknown): T | undefined {
  const [value, setValue] = useState<T>();
  const key = JSON.stringify(args);
  useEffect(() => {
    if (!name) return setValue(undefined);
    let live = true;
    host.query(name, args).then(
      (v) => live && setValue(v as T),
      () => live && setValue(undefined),
    );
    return () => void (live = false);
    // `args` is compared by value through `key`.
  }, [host, name, key, again]);
  return value;
}
