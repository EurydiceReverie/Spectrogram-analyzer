import { Outlet, Link, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

// Preload FFmpeg WASM in background on app start
function useFFmpegPreload() {
  useEffect(() => {
    const timer = setTimeout(async () => {
      const { getFFmpeg, getFlac } = await import("@/lib/wasmDecoders");
      getFFmpeg()
        .then(() => console.log("[App] FFmpeg WASM preloaded"))
        .catch((e: unknown) => console.info("[App] FFmpeg preload deferred:", e));
      getFlac()
        .then(() => console.log("[App] libflacjs preloaded"))
        .catch((e: unknown) => console.info("[App] libflacjs preload deferred:", e));
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
}

// Register service worker
function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        console.log("[SW] Registered:", reg.scope);
      })
      .catch((err) => console.warn("[SW] Registration failed:", err));
  }, []);
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you are looking for does not exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  useServiceWorker();
  useFFmpegPreload();
  return (
    <TooltipProvider delayDuration={200}>
      <Outlet />
    </TooltipProvider>
  );
}
