import axios from "axios";

const TOKEN_KEY = "rmp_token";

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

// Send the saved token with every request.
api.interceptors.request.use((config) => {
  const token = tokenStorage.get();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// A 401 on a request that carried a token means the session has ended
// (expired, or the user was deactivated), so tell the app to log out.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && error.config?.headers?.Authorization) {
      tokenStorage.clear();
      window.dispatchEvent(new Event("auth:logout"));
    }

    return Promise.reject(error);
  },
);

export const getErrorMessage = (error) =>
  error.response?.data?.message || "Cannot reach the server. Please check that the API is running.";

export default api;
