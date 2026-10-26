// BeaconMap: the world's countries (Natural Earth 1:50m, from world-atlas) as SVG paths in a projection the page picks,
// for motion graphics' maps. Loaded into a page after topojson-client and `BEACON_COUNTRIES` (the TopoJSON).
(() => {
  const topo = BEACON_COUNTRIES;
  const countries = topojson.feature(topo, topo.objects.countries).features;
  const land = topojson.feature(topo, topo.objects.land);
  const borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
  const rad = Math.PI / 180;
  const clampLat = (lat) => Math.max(-85, Math.min(85, lat));

  /** Every ring or line of a geometry, as arrays of [lon, lat]. */
  function lines(g) {
    switch (g.type) {
      case "Polygon":
      case "MultiLineString":
        return g.coordinates;
      case "MultiPolygon":
        return g.coordinates.flat();
      case "LineString":
        return [g.coordinates];
      case "GeometryCollection":
        return g.geometries.flatMap(lines);
      case "Feature":
        return lines(g.geometry);
      case "FeatureCollection":
        return g.features.flatMap(lines);
      default:
        return [];
    }
  }

  function create({ width, height, center = [0, 0], zoom = 1, projection = "mercator" }) {
    const k = (width * zoom) / (2 * Math.PI);
    const merc = projection === "mercator";
    const yOf = (lat) => (merc ? Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * rad) / 2)) : lat * rad);
    const y0 = yOf(center[1]);
    const px = (lon, lat, shift) => [width / 2 + k * (lon + shift - center[0]) * rad, height / 2 - k * (yOf(lat) - y0)];
    // Natural Earth is cut at ±180°: drawn three times, 360° apart, the world wraps around whatever the centre.
    const shifts = [-360, 0, 360];
    const path = (geo, close) => {
      let d = "";
      for (const shift of shifts)
        for (const ring of lines(geo)) {
          const pts = ring.map(([lon, lat]) => px(lon, lat, shift));
          if (pts.every(([x]) => x < -width) || pts.every(([x]) => x > 2 * width)) continue;
          d += "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L") + (close ? "Z" : "");
        }
      return d;
    };
    /** [x, y] in the page of a place, on the copy of the world nearest the centre. */
    const project = ([lon, lat]) => px(((((lon - center[0] + 180) % 360) + 360) % 360) - 180 + center[0], lat, 0);
    return {
      project,
      land: path(land, true),
      borders: path(borders, false),
      country(name) {
        const f = countries.find((c) => c.properties.name.toLowerCase() === String(name).toLowerCase());
        return f ? path(f, true) : "";
      },
      countries: countries.map((c) => c.properties.name),
      graticule(step = 15) {
        let d = "";
        for (let lon = -180; lon < 180; lon += step) d += path({ type: "LineString", coordinates: [-85, -60, -30, 0, 30, 60, 85].map((lat) => [lon, lat]) }, false);
        for (let lat = -75; lat <= 75; lat += step) d += path({ type: "LineString", coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) }, false);
        return d;
      },
      /** A curved route from one [lon, lat] to another, bowed towards the pole by `bend` of its length: an SVG path. */
      arc(from, to, bend = 0.25) {
        const [ax, ay] = project(from);
        const [bx, by] = project(to);
        const len = Math.hypot(bx - ax, by - ay);
        const pole = (from[1] + to[1]) / 2 >= 0 ? -1 : 1;
        let [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
        if (ny * pole < 0) [nx, ny] = [-nx, -ny];
        const [cx, cy] = [(ax + bx) / 2 + nx * len * bend, (ay + by) / 2 + ny * len * bend];
        return `M${ax.toFixed(1)},${ay.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
      },
    };
  }

  window.BeaconMap = { create };
})();
