export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// The server owns callback configuration and one-time browser-bound state.
export const getLoginUrl = () => "/api/oauth/start";
