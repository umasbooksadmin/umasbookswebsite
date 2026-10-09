// Permissions-Policy: switches off browser features the site never uses, so a
// script injected one day (or a third-party frame) cannot turn them on.
//
// camera=() because nothing calls getUserMedia: the admin photo scan and the
// cover-photo fields are <input type="file" capture="environment">, which hands
// over to the phone's own camera app and is NOT governed by this header. If a
// live in-page camera scanner is ever added, change camera to (self) here.
// The HelloAsso membership iframe (frame-src) is not delegated any feature
// (nothing is listed with a third-party origin).
const FEATURES = [
  "accelerometer",
  "autoplay",
  "bluetooth",
  "camera",
  "display-capture",
  "geolocation",
  "gyroscope",
  "hid",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
];

const PERMISSIONS_POLICY = FEATURES.map((f) => `${f}=()`).join(", ");

function permissionsPolicy(req, res, next) {
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  next();
}

module.exports = { PERMISSIONS_POLICY, permissionsPolicy };
