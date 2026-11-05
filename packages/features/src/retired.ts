import { defineFeature, eachRawClip, type Feature } from "@beacon/model";

/**
 * A feature taken out of Beacon, kept only so projects saved with it still open: its last version's migration takes
 * its effects off every clip (projects record each feature's data version, and an effect no feature knows fails
 * validation).
 */
export function retired(id: string, version: number, effects: string[]): Feature {
  return defineFeature({
    id,
    version,
    migrations: [
      {
        version,
        migrate(doc) {
          eachRawClip(doc, (o) => {
            if (Array.isArray(o.effects)) o.effects = (o.effects as { type: string }[]).filter((fx) => !effects.includes(fx.type));
          });
          return doc;
        },
      },
    ],
  });
}
