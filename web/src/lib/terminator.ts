/**
 * §7.2's *"night-side dimming tied to actual solar position."*
 *
 * Computed locally from the clock. No ephemeris service, no API, nothing to
 * rate-limit, and it works with the network unplugged -- which matters for a
 * dashboard whose whole point is to keep running on a laptop behind Tailscale.
 *
 * The algorithm is NOAA's low-precision solar position calculation, accurate to
 * well under a degree for any date this dashboard will render. That is far more
 * precision than a dimmed polygon needs; it is used because the alternative --
 * a rough sinusoid -- is wrong in a way that is visible at the solstices, which
 * is exactly when someone would look at it and notice.
 *
 * Pure and instant-injected: `subsolarPoint(new Date())` at the call site, so
 * the maths is testable against known values rather than against "whatever the
 * host clock said."
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface SubsolarPoint {
  /** Latitude directly under the sun. Equals the solar declination. */
  lat: number;
  /** Longitude directly under the sun, in [-180, 180]. */
  lon: number;
}

/**
 * Where on earth the sun is straight overhead at `date`.
 *
 * Julian-century terms follow NOAA's spreadsheet formulation. The equation of
 * time is what makes this more than "15 degrees per hour": true solar noon
 * drifts up to ~16 minutes from clock noon across the year, which is a
 * four-degree error in longitude -- small on a world map and clearly wrong at
 * the day/night boundary of a city you know.
 */
export function subsolarPoint(date: Date): SubsolarPoint {
  const julianDay = date.getTime() / 86400000 + 2440587.5;
  const t = (julianDay - 2451545) / 36525;

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const centre =
    Math.sin(meanAnom * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * DEG) * 0.000289;

  const trueLong = meanLong + centre;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG);

  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG);

  const declination =
    Math.asin(Math.sin(obliquity * DEG) * Math.sin(apparentLong * DEG)) * RAD;

  // Equation of time, in minutes.
  const y = Math.tan((obliquity / 2) * DEG) ** 2;
  const eqTime =
    4 *
    RAD *
    (y * Math.sin(2 * meanLong * DEG) -
      2 * eccentricity * Math.sin(meanAnom * DEG) +
      4 * eccentricity * y * Math.sin(meanAnom * DEG) * Math.cos(2 * meanLong * DEG) -
      0.5 * y * y * Math.sin(4 * meanLong * DEG) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnom * DEG));

  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;

  // Longitude where true solar time is noon.
  let lon = -((utcMinutes + eqTime) / 4 - 180);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;

  return { lat: declination, lon };
}

/**
 * A GeoJSON polygon covering the night side of the earth at `date`.
 *
 * The terminator is the set of points 90 degrees from the subsolar point. For
 * each longitude that is a single latitude:
 *
 *     lat = atan( -cos(lon - subsolarLon) / tan(declination) )
 *
 * The polygon is closed to whichever pole is in darkness -- the one whose sign
 * is opposite the declination. Handling that explicitly is what makes the
 * polar day/night regions come out right: in northern summer the *south* pole
 * is the dark cap, and a version that always closed north would render the
 * night side inside-out for half the year while looking plausible in the
 * equinox screenshots someone would check it against.
 *
 * `steps` at 2 degrees is 181 vertices -- smooth at every zoom this map uses
 * and cheap enough to recompute on a timer.
 */
export function nightPolygon(date: Date, steps = 2): GeoJSON.Feature<GeoJSON.Polygon> {
  const { lat: declination, lon: subsolarLon } = subsolarPoint(date);
  const ring: Array<[number, number]> = [];

  // A declination of exactly zero makes tan() zero and the latitude undefined;
  // the equinox terminator is the meridian pair through the poles. Nudged
  // rather than special-cased -- the visual difference is unmeasurable and the
  // alternative is a branch that runs twice a year and is therefore never
  // exercised.
  const dec = Math.abs(declination) < 1e-6 ? 1e-6 : declination;
  const tanDec = Math.tan(dec * DEG);

  for (let i = 0; i <= 360; i += steps) {
    const lon = -180 + i;
    const lat = Math.atan(-Math.cos((lon - subsolarLon) * DEG) / tanDec) * RAD;
    ring.push([lon, lat]);
  }

  // Close to the dark pole: opposite hemisphere from the subsolar latitude.
  const darkPole = dec > 0 ? -90 : 90;
  ring.push([180, darkPole], [-180, darkPole], [ring[0]![0], ring[0]![1]]);

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}
