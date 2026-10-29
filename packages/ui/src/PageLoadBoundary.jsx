import { Component } from "react";
import { afterFailedLoad, isFailedPageLoad } from "@bmp/shared/pageLoad";

// Around each app's routes, so a page that cannot be drawn never leaves the
// screen blank. A page's code that failed to load (most often a new version
// gone live while the tab was open, its old files gone) reloads the page once
// by itself; when that load fails again, or the page breaks some other way,
// the screen says so with a Reload button and the error goes to the console,
// reported as uncaught (reportError), so error monitoring and the browser
// tests' "no script errors" checks still see it. The rules are
// @bmp/shared/pageLoad's.
//
//   <PageLoadBoundary resetKey={pathname}>
//     <Suspense fallback={…}><Routes>…</Routes></Suspense>
//   </PageLoadBoundary>
//
// resetKey: when it changes (the person goes to another address, with Back),
// the boundary tries the page again.

const tabStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const reload = () => window.location.reload();

// The browser's own report of an uncaught error (the console and the window's
// error event), without stopping anything here.
const reportUncaught = (error) => {
  if (typeof window.reportError === "function") {
    window.reportError(error);
  } else {
    window.setTimeout(() => {
      throw error;
    });
  }
};

export default class PageLoadBoundary extends Component {
  state = { error: null, reloading: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error) {
    return { error, reloading: false };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey === state.resetKey ? null : { error: null, reloading: false, resetKey: props.resetKey };
  }

  componentDidCatch(error, info) {
    const address = `${window.location.pathname}${window.location.search}`;

    if (isFailedPageLoad(error) && afterFailedLoad(tabStorage(), address) === "reload") {
      console.error("This page's code could not be loaded; reloading once for the latest version.", error);
      this.setState({ reloading: true });
      reload();
      return;
    }

    console.error("This page could not be shown.", info?.componentStack || "");
    reportUncaught(error);
  }

  render() {
    const { error, reloading } = this.state;

    if (!error) {
      return this.props.children;
    }

    if (reloading) {
      return (
        <div className="page-load-failed" role="status">
          <p className="muted">Loading the latest version of this page…</p>
        </div>
      );
    }

    const failedLoad = isFailedPageLoad(error);

    return (
      <div className="page-load-failed" role="alert">
        <h1>{failedLoad ? "This page could not be loaded" : "This page could not be shown"}</h1>
        <p className="muted">
          {failedLoad ? "Check the internet connection, then reload the page." : "Something went wrong while drawing it. Reload the page to try again."}
        </p>
        <button type="button" className="button" onClick={reload}>
          Reload
        </button>
      </div>
    );
  }
}
