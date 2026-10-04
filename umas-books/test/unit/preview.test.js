const test = require("node:test");
const assert = require("node:assert/strict");
const { isPreviewMode, previewMiddleware } = require("../../src/lib/preview");

function withEnv(value, fn) {
  const old = process.env.PREVIEW_MODE;
  try {
    if (value === undefined) delete process.env.PREVIEW_MODE; else process.env.PREVIEW_MODE = value;
    return fn();
  } finally {
    if (old === undefined) delete process.env.PREVIEW_MODE; else process.env.PREVIEW_MODE = old;
  }
}

test("isPreviewMode is on only for 1 / true (any case, trimmed)", () => {
  for (const v of ["1", "true", "TRUE", "True", " true "]) assert.equal(isPreviewMode({ PREVIEW_MODE: v }), true, v);
  for (const v of [undefined, "", "0", "false", "yes", "on", "tru"]) assert.equal(isPreviewMode({ PREVIEW_MODE: v }), false, String(v));
  assert.equal(isPreviewMode({}), false);
});

test("isPreviewMode reads process.env by default", () => {
  assert.equal(withEnv("true", () => isPreviewMode()), true);
  assert.equal(withEnv(undefined, () => isPreviewMode()), false);
});

test("previewMiddleware sets the local and the robots header only in preview mode", () => {
  for (const [value, on] of [["true", true], [undefined, false]]) {
    withEnv(value, () => {
      const headers = {};
      const res = { locals: {}, set: (k, v) => { headers[k] = v; } };
      let called = false;
      previewMiddleware({}, res, () => { called = true; });
      assert.equal(called, true);
      assert.equal(res.locals.preview, on);
      assert.deepEqual(headers, on ? { "X-Robots-Tag": "noindex, nofollow" } : {});
    });
  }
});
