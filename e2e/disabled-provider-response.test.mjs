import test from "node:test";
import assert from "node:assert/strict";
import { isDisabledProviderResponse, TRELLO_CREDENTIALS_MISSING_MESSAGE, UNLINKED_TRELLO_MESSAGE, UNLINKED_TRELLO_PATH } from "./disabled-provider-response.mjs";

const fixtures = [
  ["/api/trello/tasks", 500, { error: "Trello credentials not configured" }],
  ["/api/va/assignments", 503, { code: "TRELLO_ASSIGNMENTS_UNAVAILABLE", error: "Trello assignments are unavailable. Retry after checking the Trello connection." }],
  ["/api/atis/timeline-tasks", 503, { code: "TRELLO_BOARD_ACCESS_UNAVAILABLE", error: "Trello work queue is unavailable. Retry after checking the Trello connection." }],
];
for (const [path, status, body] of fixtures) {
  test(`recognizes only the verified contract for ${path}`, () => {
    assert.equal(isDisabledProviderResponse(path, status, body), true);
    for (const other of [200, 401, 403, 412, 502])
      assert.equal(isDisabledProviderResponse(path, other, body), false);
    assert.equal(isDisabledProviderResponse("/api/unrelated", status, body), false);
    assert.equal(isDisabledProviderResponse(path, status, { ...body, error: "Unexpected failure" }), false);
    for (const invalid of [null, [], "error", {}])
      assert.equal(isDisabledProviderResponse(path, status, invalid), false);
  });
}
test("unlinked worker errors require the exact procedure and structured precondition", () => {
  const error = { message: UNLINKED_TRELLO_MESSAGE, code: -32012,
    data: { code: "PRECONDITION_FAILED", httpStatus: 412, path: "trello.actionAlerts" } };
  assert.equal(isDisabledProviderResponse(UNLINKED_TRELLO_PATH, 412, { error: { json: error } }), true);
  for (const status of [200, 403, 500, 503])
    assert.equal(isDisabledProviderResponse(UNLINKED_TRELLO_PATH, status, { error: { json: error } }), false);
  assert.equal(isDisabledProviderResponse("/api/trpc/operator.runManager", 412, { error: { json: error } }), false);
  for (const changed of [{ ...error, message: "Unexpected failure" }, { ...error, code: -32603 },
    { ...error, data: { ...error.data, code: "INTERNAL_SERVER_ERROR" } },
    { ...error, data: { ...error.data, path: "operator.runManager" } },
    { ...error, data: { ...error.data, httpStatus: 500 } }])
    assert.equal(isDisabledProviderResponse(UNLINKED_TRELLO_PATH, 412, { error: { json: changed } }), false);
});
test("missing Trello credentials require the exact procedure and structured precondition", () => {
  const error = { message: TRELLO_CREDENTIALS_MISSING_MESSAGE, code: -32012,
    data: { code: "PRECONDITION_FAILED", httpStatus: 412, path: "trello.actionAlerts" } };
  assert.equal(isDisabledProviderResponse(UNLINKED_TRELLO_PATH, 412, { error: { json: error } }), true);
  assert.equal(isDisabledProviderResponse(UNLINKED_TRELLO_PATH, 500, { error: { json: error } }), false);
  assert.equal(isDisabledProviderResponse("/api/trpc/operator.runManager", 412, { error: { json: error } }), false);
  assert.equal(isDisabledProviderResponse(UNLINKED_TRELLO_PATH, 412, {
    error: { json: { ...error, message: "Another failure" } },
  }), false);
});
