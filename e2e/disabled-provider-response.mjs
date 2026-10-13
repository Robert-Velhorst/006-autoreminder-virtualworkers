export const UNLINKED_TRELLO_MESSAGE = "Link one unambiguous Trello member to your worker profile before viewing Trello cards or activity.";
export const UNLINKED_TRELLO_PATH = "/api/trpc/trello.actionAlerts";
export const TRELLO_CREDENTIALS_MISSING_MESSAGE = "Trello API credentials not configured";

export function isDisabledProviderResponse(path, status, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (path === UNLINKED_TRELLO_PATH) {
    const error = body.error?.json;
    const expectedMessage = [UNLINKED_TRELLO_MESSAGE, TRELLO_CREDENTIALS_MISSING_MESSAGE]
      .includes(error?.message);
    return status === 412 && expectedMessage &&
      error.code === -32012 && error.data?.code === "PRECONDITION_FAILED" &&
      error.data.httpStatus === 412 && error.data.path === "trello.actionAlerts";
  }
  if (path === "/api/trello/tasks")
    return status === 500 && body.error === "Trello credentials not configured";
  if (path === "/api/va/assignments")
    return status === 503 && body.code === "TRELLO_ASSIGNMENTS_UNAVAILABLE" &&
      body.error === "Trello assignments are unavailable. Retry after checking the Trello connection.";
  if (path === "/api/atis/timeline-tasks")
    return status === 503 && body.code === "TRELLO_BOARD_ACCESS_UNAVAILABLE" &&
      body.error === "Trello work queue is unavailable. Retry after checking the Trello connection.";
  return false;
}
