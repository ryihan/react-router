import { createMemoryHistory, InitialEntry, parsePath } from "../history";
import type {
  HydrationState,
  LoaderFunctionArgs,
  NavigateOptions,
} from "../index";
import {
  createRouter,
  Fetcher,
  IDLE_FETCHER,
  IDLE_TRANSITION,
} from "../router";
import {
  ActionFunctionArgs,
  DataRouteObject,
  invariant,
  matchRoutes,
  RouteMatch,
} from "../utils";

///////////////////////////////////////////////////////////////////////////////
//#region Types and Utils
///////////////////////////////////////////////////////////////////////////////

type Deferred = ReturnType<typeof defer>;

// Routes passed into setup() should just have a boolean for loader/action
// indicating they want a stub
type TestRouteObject = Pick<
  DataRouteObject,
  "id" | "index" | "path" | "shouldReload"
> & {
  loader?: boolean;
  action?: boolean;
  exceptionElement?: boolean;
  children?: TestRouteObject[];
};

// Enhanced route objects are what is passed to the router for testing, as they
// have been enhanced with stubbed loaders and actions
type EnhancedRouteObject = Omit<
  TestRouteObject,
  "loader" | "action" | "children"
> & {
  loader?: (args: LoaderFunctionArgs) => Promise<unknown>;
  action?: (args: ActionFunctionArgs) => Promise<unknown>;
  children?: EnhancedRouteObject[];
};

// A helper that includes the Deferred and stubs for any loaders/actions for the
// route allowing fine-grained test execution
type InternalHelpers = {
  navigationId: number;
  dfd: Deferred;
  stub: jest.Mock;
  _signal?: AbortSignal;
};

type Helpers = InternalHelpers & {
  get signal(): AbortSignal;
  resolve: (d: any) => Promise<void>;
  reject: (d: any) => Promise<void>;
  redirect: (
    href: string,
    status?: number,
    headers?: Record<string, string>
  ) => Promise<NavigationHelpers>;
  redirectReturn: (
    href: string,
    status?: number,
    headers?: Record<string, string>
  ) => Promise<NavigationHelpers>;
};

// Helpers returned from a TestHarness.navigate call, allowing fine grained
// control and assertions over the loaders/actions
type NavigationHelpers = {
  navigationId: number;
  loaders: Record<string, Helpers>;
  actions: Record<string, Helpers>;
};

type FetcherHelpers = NavigationHelpers & {
  key: string;
  fetcher: Fetcher;
  shimLoaderHelper: (routeId: string) => void;
};

// Global array to stick any errors thrown from router.navigate() and then we
// can assert against them and clear the array in afterEach
let uncaughtExceptions: string[] = [];
function handleUncaughtException(e: any): void {
  console.error("Error caught from navigate()", e);
  uncaughtExceptions.push(
    e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
  );
}

function defer() {
  let resolve: (val?: any) => Promise<void>;
  let reject: (error?: Error) => Promise<void>;
  let promise = new Promise((res, rej) => {
    resolve = async (val: any) => {
      res(val);
      try {
        await promise;
      } catch (e) {}
    };
    reject = async (error?: Error) => {
      rej(error);
      try {
        await promise;
      } catch (e) {}
    };
  });
  return {
    promise,
    //@ts-ignore
    resolve,
    //@ts-ignore
    reject,
  };
}

function createFormData(obj: Record<string, string>): FormData {
  let formData = new FormData();
  Object.entries(obj).forEach((e) => formData.append(e[0], e[1]));
  return formData;
}

function isRedirect(result: any) {
  return (
    result instanceof Response && result.status >= 300 && result.status <= 399
  );
}

type SetupOpts = {
  routes: TestRouteObject[];
  initialEntries?: InitialEntry[];
  initialIndex?: number;
  hydrationData?: HydrationState;
};

function setup({
  routes,
  initialEntries,
  initialIndex,
  hydrationData,
}: SetupOpts) {
  let guid = 0;
  // Global "active" helpers, keyed by navType:guid:loaderOrAction:routeId.
  // For example, the first navigation for /parent/foo would generate:
  //   navigation:1:action:parent -> helpers
  //   navigation:1:action:foo -> helpers
  //   navigation:1:loader:parent -> helpers
  //   navigation:1:loader:foo -> helpers
  //
  let activeHelpers = new Map<string, InternalHelpers>();
  // "Active" flags to indicate which helpers should be used the next time a
  // router calls an action or loader internally.
  let activeActionType: "navigation" | "fetch" = "navigation";
  let activeLoaderType: "navigation" | "fetch" = "navigation";
  let activeLoaderNavigationId = guid;
  let activeActionNavigationId = guid;
  let activeLoaderFetchId = guid;
  let activeActionFetchId = guid;
  // A set of to-be-garbage-collected Deferred's to clean up at the end of a test
  let gcDfds = new Set<Deferred>();

  // Enhance routes with loaders/actions as requested that will call the
  // active navigation loader/action
  function enhanceRoutes(_routes: TestRouteObject[]) {
    return _routes.map((r) => {
      let enhancedRoute: EnhancedRouteObject = {
        ...r,
        loader: undefined,
        action: undefined,
        children: undefined,
      };
      if (r.loader) {
        enhancedRoute.loader = (args) => {
          let navigationId =
            activeLoaderType === "fetch"
              ? activeLoaderFetchId
              : activeLoaderNavigationId;
          let helperKey = `${activeLoaderType}:${navigationId}:loader:${r.id}`;
          let helpers = activeHelpers.get(helperKey);
          invariant(helpers, `No helpers found for: ${helperKey}`);
          helpers.stub(args);
          helpers._signal = args.signal;
          return helpers.dfd.promise;
        };
      }
      if (r.action) {
        enhancedRoute.action = (args) => {
          let type = activeActionType;
          let navigationId =
            activeActionType === "fetch"
              ? activeActionFetchId
              : activeActionNavigationId;
          let helperKey = `${activeActionType}:${navigationId}:action:${r.id}`;
          let helpers = activeHelpers.get(helperKey);
          invariant(helpers, `No helpers found for: ${helperKey}`);
          helpers.stub(args);
          helpers._signal = args.signal;
          return helpers.dfd.promise.then(
            (result) => {
              // After a successful non-redirect action, ensure we call the right
              // loaders as a follow up.  In the case of a redirect, ths navigation
              // is aborted and we will use whatever new navigationId the redirect
              // already assigned
              if (!isRedirect(result)) {
                if (type === "navigation") {
                  activeLoaderType = "navigation";
                  activeLoaderNavigationId = navigationId;
                } else {
                  activeLoaderType = "fetch";
                  activeLoaderFetchId = navigationId;
                }
              }
              return result;
            },
            (result) => {
              // After a non-redirect rejected navigation action, we may still call
              // ancestor loaders so set the right values to ensure we trigger the
              // right ones.
              if (type === "navigation" && !isRedirect(result)) {
                activeLoaderType = "navigation";
                activeLoaderNavigationId = navigationId;
              }
              return Promise.reject(result);
            }
          );
        };
      }
      if (r.children) {
        enhancedRoute.children = enhanceRoutes(r.children);
      }
      return enhancedRoute;
    });
  }

  let history = createMemoryHistory({ initialEntries, initialIndex });
  let enhancedRoutes = enhanceRoutes(routes);
  jest.spyOn(history, "push");
  jest.spyOn(history, "replace");
  let router = createRouter({
    history,
    routes: enhancedRoutes,
    hydrationData,
  });

  function getRouteHelpers(
    routeId: string,
    navigationId: number,
    addHelpers: (routeId: string, helpers: InternalHelpers) => void
  ): Helpers {
    // Internal methods we need access to from the route loader execution
    let internalHelpers: InternalHelpers = {
      navigationId,
      dfd: defer(),
      stub: jest.fn(),
    };
    // Allow the caller to store off the helpers in the right spot so eventual
    // executions by the router can access the right ones
    addHelpers(routeId, internalHelpers);
    gcDfds.add(internalHelpers.dfd);

    let routeHelpers: Helpers = {
      // @ts-expect-error
      get signal() {
        return internalHelpers._signal;
      },
      // Note: This spread has to come _after_ the above getter, otherwise
      // we lose the getter nature of it somewhere in the babel/typescript
      // transform.  Doesn't seem ot be an issue in ts-jest but that's a
      // bit large of a change to look into at the moment
      ...internalHelpers,
      // Public APIs only needed for test execution
      async resolve(value) {
        await internalHelpers.dfd.resolve(value);
        await new Promise((r) => setImmediate(r));
      },
      async reject(value) {
        try {
          await internalHelpers.dfd.reject(value);
          await new Promise((r) => setImmediate(r));
        } catch (e) {}
      },
      async redirect(href, status = 301, headers = {}) {
        let redirectNavigationId = ++guid;
        activeLoaderType = "navigation";
        activeLoaderNavigationId = redirectNavigationId;
        let helpers = getNavigationHelpers(href, redirectNavigationId);
        try {
          //@ts-ignore
          await internalHelpers.dfd.reject(
            //@ts-ignore
            new Response(null, {
              status,
              headers: {
                location: href,
                ...headers,
              },
            })
          );
          await new Promise((r) => setImmediate(r));
        } catch (e) {}
        return helpers;
      },
      async redirectReturn(href, status = 301, headers = {}) {
        let redirectNavigationId = ++guid;
        activeLoaderType = "navigation";
        activeLoaderNavigationId = redirectNavigationId;
        let helpers = getNavigationHelpers(href, redirectNavigationId);
        try {
          //@ts-ignore
          await internalHelpers.dfd.resolve(
            //@ts-ignore
            new Response(null, {
              status,
              headers: {
                location: href,
                ...headers,
              },
            })
          );
          await new Promise((r) => setImmediate(r));
        } catch (e) {}
        return helpers;
      },
    };
    return routeHelpers;
  }

  function getHelpers(
    matches: RouteMatch<string, DataRouteObject>[],
    navigationId: number,
    addHelpers: (routeId: string, helpers: InternalHelpers) => void
  ): Record<string, Helpers> {
    return matches.reduce(
      (acc, m) =>
        Object.assign(acc, {
          [m.route.id]: getRouteHelpers(m.route.id, navigationId, addHelpers),
        }),
      {}
    );
  }

  function getNavigationHelpers(
    href: string,
    navigationId: number
  ): NavigationHelpers {
    let matches = matchRoutes(enhancedRoutes, href);

    // Generate helpers for all route matches that contain loaders
    let loaderHelpers = getHelpers(
      (matches || []).filter((m) => m.route.loader),
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(
          `navigation:${navigationId}:loader:${routeId}`,
          helpers
        )
    );
    let actionHelpers = getHelpers(
      (matches || []).filter((m) => m.route.action),
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(
          `navigation:${navigationId}:action:${routeId}`,
          helpers
        )
    );

    return {
      navigationId,
      loaders: loaderHelpers,
      actions: actionHelpers,
    };
  }

  function getFetcherHelpers(
    key: string,
    href: string,
    navigationId: number,
    opts?: NavigateOptions
  ): FetcherHelpers {
    let matches = matchRoutes(enhancedRoutes, href);
    invariant(matches, `No matches found for fetcher href:${href}`);
    let search = parsePath(href).search || "";
    let hasNakedIndexQuery = new URLSearchParams(search)
      .getAll("index")
      .some((v) => v === "");

    let match =
      matches[matches.length - 1].route.index && !hasNakedIndexQuery
        ? matches.slice(-2)[0]
        : matches.slice(-1)[0];

    // If this is an action submission we need loaders for all current matches.
    // Otherwise we should only need a loader for the leaf match
    let activeLoaderMatches = [match];
    // @ts-expect-error
    if (opts?.formMethod === "post") {
      if (router.state.transition?.location) {
        activeLoaderMatches = matchRoutes(
          enhancedRoutes,
          router.state.transition.location
        ) as RouteMatch<string, EnhancedRouteObject>[];
      } else {
        activeLoaderMatches = router.state.matches as RouteMatch<
          string,
          EnhancedRouteObject
        >[];
      }
    }

    // Generate helpers for all route matches that contain loaders
    let loaderHelpers = getHelpers(
      activeLoaderMatches.filter((m) => m.route.loader),
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(`fetch:${navigationId}:loader:${routeId}`, helpers)
    );
    let actionHelpers = getHelpers(
      match.route.action ? [match] : [],
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(`fetch:${navigationId}:action:${routeId}`, helpers)
    );

    let fetcherHelpers: FetcherHelpers;

    function shimLoaderHelper(routeId: string) {
      invariant(
        !fetcherHelpers.loaders[routeId],
        "Can;t overwrite existing helpers"
      );
      fetcherHelpers.loaders[routeId] = getRouteHelpers(
        routeId,
        navigationId,
        (routeId, helpers) =>
          activeHelpers.set(`fetch:${navigationId}:loader:${routeId}`, helpers)
      );
    }

    fetcherHelpers = {
      key,
      navigationId,
      get fetcher() {
        return router.getFetcher(key);
      },
      loaders: loaderHelpers,
      actions: actionHelpers,
      shimLoaderHelper,
    };

    return fetcherHelpers;
  }

  // Simulate a navigation, returning a series of helpers to manually
  // control/assert loader/actions
  function navigate(n: number): Promise<NavigationHelpers>;
  function navigate(
    href: string,
    opts?: NavigateOptions
  ): Promise<NavigationHelpers>;
  async function navigate(
    href: number | string,
    opts?: NavigateOptions
  ): Promise<NavigationHelpers> {
    let navigationId = ++guid;
    let helpers: NavigationHelpers;

    // @ts-expect-error
    if (opts?.formMethod === "post") {
      activeActionType = "navigation";
      activeActionNavigationId = navigationId;
      // Assume happy path and mark this navigations loaders as active.  Even if
      // we never call them from the router (if the action rejects) we'll want
      // this to be accurate so we can assert against the stubs
      activeLoaderType = "navigation";
      activeLoaderNavigationId = navigationId;
    } else {
      activeLoaderType = "navigation";
      activeLoaderNavigationId = navigationId;
    }

    if (typeof href === "number") {
      let promise = new Promise<void>((r) => {
        let unsubscribe = router.subscribe(() => {
          helpers = getNavigationHelpers(
            history.createHref(history.location),
            navigationId
          );
          unsubscribe();
          r();
        });
      });
      router.navigate(href).catch(handleUncaughtException);
      await promise;
      //@ts-ignore
      return helpers;
    }

    helpers = getNavigationHelpers(href, navigationId);
    router.navigate(href, opts).catch(handleUncaughtException);
    return helpers;
  }

  // Simulate a fetcher call, returning a series of helpers to manually
  // control/assert loader/actions
  async function fetch(href: string): Promise<FetcherHelpers>;
  async function fetch(href: string, key: string): Promise<FetcherHelpers>;
  async function fetch(
    href: string,
    opts: NavigateOptions
  ): Promise<FetcherHelpers>;
  async function fetch(
    href: string,
    key: string,
    opts: NavigateOptions
  ): Promise<FetcherHelpers>;
  async function fetch(
    href: string,
    keyOrOpts?: string | NavigateOptions,
    opts?: NavigateOptions
  ): Promise<FetcherHelpers> {
    let navigationId = ++guid;
    let key = typeof keyOrOpts === "string" ? keyOrOpts : String(navigationId);
    opts = typeof keyOrOpts === "object" ? keyOrOpts : opts;

    // @ts-expect-error
    if (opts?.formMethod === "post") {
      activeActionType = "fetch";
      activeActionFetchId = navigationId;
    } else {
      activeLoaderType = "fetch";
      activeLoaderFetchId = navigationId;
    }

    let helpers = getFetcherHelpers(key, href, navigationId, opts);
    router.fetch(key, href, opts).catch(handleUncaughtException);
    return helpers;
  }

  // Simulate a revalidation, returning a series of helpers to manually
  // control/assert loader/actions
  async function revalidate(): Promise<NavigationHelpers> {
    // if a revalidation interrupts an action submission, we don't actually
    // start a new new navigation so don't increment here
    let navigationId =
      router.state.transition.type === "actionSubmission" ? guid : ++guid;
    activeLoaderType = "navigation";
    activeLoaderNavigationId = navigationId;
    let href = router.createHref(
      router.state.transition.location || router.state.location
    );
    let helpers = getNavigationHelpers(href, navigationId);
    router.revalidate().catch(handleUncaughtException);
    return helpers;
  }

  return {
    history,
    router,
    navigate,
    fetch,
    revalidate,
    cleanup() {
      gcDfds.forEach((dfd) => dfd.resolve());
    },
  };
}

function initializeTmTest(init?: {
  url?: string;
  hydrationData?: HydrationState;
}) {
  return setup({
    routes: TM_ROUTES,
    hydrationData: init?.hydrationData || {
      loaderData: { root: "ROOT", index: "INDEX" },
    },
    ...(init?.url ? { initialEntries: [init.url] } : {}),
  });
}
//#endregion

///////////////////////////////////////////////////////////////////////////////
//#region Tests
///////////////////////////////////////////////////////////////////////////////

// Reusable routes for a simple tasks app, for test cases that don't want
// to create their own more complex routes
const TASK_ROUTES: TestRouteObject[] = [
  {
    id: "root",
    path: "/",
    loader: true,
    exceptionElement: true,
    children: [
      {
        id: "index",
        index: true,
        loader: true,
      },
      {
        id: "tasks",
        path: "tasks",
        loader: true,
        action: true,
        exceptionElement: true,
      },
      {
        id: "tasksId",
        path: "tasks/:id",
        loader: true,
        action: true,
        exceptionElement: true,
      },
      {
        id: "noLoader",
        path: "no-loader",
      },
    ],
  },
];

const TM_ROUTES = [
  {
    path: "",
    id: "root",
    element: {},
    module: "",
    exceptionElement: true,
    loader: true,
    children: [
      {
        path: "/",
        id: "index",
        hasLoader: true,
        loader: true,
        action: true,
        element: {},
        module: "",
      },
      {
        path: "/foo",
        id: "foo",
        loader: true,
        action: true,
        element: {},
        module: "",
      },
      {
        path: "/foo/bar",
        id: "foobar",
        loader: true,
        action: true,
        element: {},
        module: "",
      },
      {
        path: "/bar",
        id: "bar",
        loader: true,
        action: true,
        element: {},
        module: "",
      },
      {
        path: "/baz",
        id: "baz",
        loader: true,
        action: true,
        element: {},
        module: "",
      },
      {
        path: "/p/:param",
        id: "param",
        loader: true,
        action: true,
        element: {},
        module: "",
      },
    ],
  },
];

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

// Detect any failures inside the router navigate code
afterEach(() => {
  // @ts-ignore
  console.warn.mockReset();
  if (uncaughtExceptions.length) {
    let NO_UNCAUGHT_EXCEPTIONS = "No Uncaught Exceptions";
    let strExceptions = uncaughtExceptions.join(",") || NO_UNCAUGHT_EXCEPTIONS;
    uncaughtExceptions = [];
    expect(strExceptions).toEqual(NO_UNCAUGHT_EXCEPTIONS);
  }
});

describe("a router", () => {
  describe("init", () => {
    it("with initial values", async () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRouter({
        routes: [
          {
            element: {},
            id: "root",
            path: "/",
            exceptionElement: {},
            loader: () => Promise.resolve(),
          },
        ],
        history,
        hydrationData: {
          loaderData: { root: "LOADER DATA" },
          actionData: { root: "ACTION DATA" },
          exceptions: { root: new Error("lol") },
        },
      });
      expect(router.state).toEqual({
        historyAction: "POP",
        loaderData: {
          root: "LOADER DATA",
        },
        actionData: {
          root: "ACTION DATA",
        },
        exceptions: {
          root: new Error("lol"),
        },
        location: {
          hash: "",
          key: expect.any(String),
          pathname: "/",
          search: "",
          state: null,
        },
        matches: [
          {
            params: {},
            pathname: "/",
            pathnameBase: "/",
            route: {
              element: {},
              exceptionElement: {},
              id: "root",
              loader: expect.any(Function),
              path: "/",
            },
          },
        ],
        initialized: true,
        transition: {
          location: undefined,
          state: "idle",
          submission: undefined,
          type: "idle",
        },
        revalidation: "idle",
        fetchers: new Map(),
      });
    });

    it("requires routes", async () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      expect(() =>
        createRouter({
          routes: [],
          history,
          hydrationData: {},
        })
      ).toThrowErrorMatchingInlineSnapshot(
        `"You must provide a non-empty routes array to use Data Routers"`
      );
    });

    it("converts routes to data routes", async () => {
      let history = createMemoryHistory({
        initialEntries: ["/child/grandchild"],
      });
      let routes = [
        {
          path: "/",
          children: [
            {
              id: "child-keep-me",
              path: "child",
              children: [
                {
                  path: "grandchild",
                },
              ],
            },
          ],
        },
      ];
      let originalRoutes = JSON.parse(JSON.stringify(routes));
      let router = createRouter({
        routes,
        history,
        hydrationData: {},
      });
      // routes are not mutated in place
      expect(routes).toEqual(originalRoutes);
      expect(router.state.matches).toMatchObject([
        {
          route: {
            id: "0",
          },
        },
        {
          route: {
            id: "child-keep-me",
          },
        },
        {
          route: {
            id: "0-0-0",
          },
        },
      ]);
    });

    it("throws if it finds duplicate route ids", async () => {
      let history = createMemoryHistory({
        initialEntries: ["/child/grandchild"],
      });
      let routes = [
        {
          path: "/",
          children: [
            {
              id: "child",
              path: "child",
              children: [
                {
                  id: "child",
                  path: "grandchild",
                },
              ],
            },
          ],
        },
      ];
      expect(() =>
        createRouter({
          routes,
          history,
          hydrationData: {},
        })
      ).toThrowErrorMatchingInlineSnapshot(
        `"Found a route id collision on id \\"child\\".  Route id's must be globally unique within Data Router usages"`
      );
    });
  });

  describe("basename", () => {
    it("handles a basename", async () => {
      let history = createMemoryHistory({
        initialEntries: ["/app/"],
      });
      let router = createRouter({
        basename: "/app",
        routes: [
          {
            id: "root",
            path: "/",
            children: [
              {
                id: "index",
                index: true,
              },
              {
                id: "child",
                path: "child",
              },
            ],
          },
        ],
        history,
        hydrationData: {},
      });

      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: {
          hash: "",
          key: expect.any(String),
          pathname: "/app/",
          search: "",
          state: null,
        },
        matches: [
          {
            params: {},
            pathname: "/",
            pathnameBase: "/",
            route: {
              id: "root",
              path: "/",
            },
          },
          {
            params: {},
            pathname: "/",
            pathnameBase: "/",
            route: {
              id: "index",
              index: true,
            },
          },
        ],
      });

      router.navigate("/app/child");

      expect(router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          hash: "",
          key: expect.any(String),
          pathname: "/app/child",
          search: "",
          state: null,
        },
        matches: [
          {
            params: {},
            pathname: "/",
            pathnameBase: "/",
            route: {
              id: "root",
              path: "/",
            },
          },
          {
            params: {},
            pathname: "/child",
            pathnameBase: "/child",
            route: {
              id: "child",
              path: "child",
            },
          },
        ],
      });
    });
  });

  describe("normal navigation", () => {
    it("fetches data on navigation", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.loaderData).toMatchInlineSnapshot(`
        Object {
          "foo": "FOO",
          "root": "ROOT",
        }
      `);
    });

    it("allows `null` as a valid data value", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve(null);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: null,
      });
    });

    it("does not fetch unchanging layout data", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData.root).toBe("ROOT");
    });

    it("reloads all routes on search changes", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo?q=1");
      await A.loaders.root.resolve("ROOT1");
      await A.loaders.foo.resolve("1");
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT1",
        foo: "1",
      });

      let B = await t.navigate("/foo?q=2");
      await B.loaders.root.resolve("ROOT2");
      await B.loaders.foo.resolve("2");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT2",
        foo: "2",
      });
    });

    it("does not reload all routes when search does not change", async () => {
      let t = initializeTmTest();
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let A = await t.navigate("/foo?q=1");
      await A.loaders.root.resolve("ROOT1");
      await A.loaders.foo.resolve("1");
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT1",
        foo: "1",
      });

      let B = await t.navigate("/foo/bar?q=1");
      await B.loaders.foobar.resolve("2");
      expect(B.loaders.root.stub.mock.calls.length).toBe(0);

      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT1",
        foobar: "2",
      });
    });

    it("reloads only routes with changed params", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/p/one");
      await A.loaders.param.resolve("one");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        param: "one",
      });

      let B = await t.navigate("/p/two");
      await B.loaders.param.resolve("two");
      expect(B.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        param: "two",
      });
    });

    it("reloads all routes on refresh", async () => {
      let t = initializeTmTest();
      let url = "/p/same";

      let A = await t.navigate(url);
      await A.loaders.param.resolve("1");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        param: "1",
      });

      let B = await t.navigate(url);
      await B.loaders.root.resolve("ROOT2");
      await B.loaders.param.resolve("2");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT2",
        param: "2",
      });
    });

    it("does not load anything on hash change only", async () => {
      let t = initializeTmTest();
      expect(t.router.state.loaderData).toMatchObject({ root: "ROOT" });
      let A = await t.navigate("/#bar");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({ root: "ROOT" });
    });

    it("sets all right states on hash change only", async () => {
      let t = initializeTmTest();
      let key = t.router.state.location.key;
      t.navigate("/#bar");
      // hash changes are synchronous but force a key change
      expect(t.router.state.location.key).not.toBe(key);
      expect(t.router.state.location.hash).toBe("#bar");
      expect(t.router.state.transition.state).toBe("idle");
    });

    it("loads new data on new routes even if there's also a hash change", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo#bar");
      expect(t.router.state.transition.type).toBe("normalLoad");
      await A.loaders.foo.resolve("A");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: "A",
      });
    });

    it("redirects from loaders (throw)", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/bar");
      expect(t.router.state.transition.type).toBe("normalLoad");
      expect(t.router.state.transition.location?.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let B = await A.loaders.bar.redirect("/baz");
      expect(t.router.state.transition.type).toBe("normalRedirect");
      expect(t.router.state.transition.location?.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      await B.loaders.baz.resolve("B");
      expect(t.router.state.transition.type).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        baz: "B",
      });
    });

    it("redirects from loaders (return)", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/bar");
      expect(t.router.state.transition.type).toBe("normalLoad");
      expect(t.router.state.transition.location?.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let B = await A.loaders.bar.redirectReturn("/baz");
      expect(t.router.state.transition.type).toBe("normalRedirect");
      expect(t.router.state.transition.location?.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      await B.loaders.baz.resolve("B");
      expect(t.router.state.transition.type).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        baz: "B",
      });
    });

    it("reloads all routes if X-Remix-Revalidate was set in a loader redirect header", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/bar");
      expect(t.router.state.transition.type).toBe("normalLoad");
      expect(t.router.state.transition.location?.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let B = await A.loaders.bar.redirectReturn("/baz", undefined, {
        "X-Remix-Revalidate": "yes",
      });
      expect(t.router.state.transition.type).toBe("normalRedirect");
      expect(t.router.state.transition.location?.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      await B.loaders.root.resolve("ROOT*");
      await B.loaders.baz.resolve("B");
      expect(t.router.state.transition.type).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT*",
        baz: "B",
      });
    });
  });

  describe("shouldReload", () => {
    it("delegates to the route if it should reload or not", async () => {
      let rootLoader = jest.fn((args) => "ROOT");
      let childLoader = jest.fn((args) => "CHILD");
      let shouldReload = jest.fn(({ url }) => {
        return new URLSearchParams(parsePath(url).search).get("reload") === "1";
      });

      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",
            loader: async (...args) => rootLoader(...args),
            shouldReload: (args) => shouldReload(args) === true,
            element: {},
            children: [
              {
                path: "/",
                id: "index",
                element: {},
              },
              {
                path: "/child",
                id: "child",
                loader: async (...args) => childLoader(...args),
                action: async () => null,
                element: {},
              },
            ],
          },
        ],
      });

      // Initial load - no existing data, should always call loader and should
      // not give use ability to opt-out
      await new Promise((r) => setImmediate(r));
      expect(rootLoader.mock.calls.length).toBe(1);
      expect(shouldReload.mock.calls.length).toBe(0);

      // Should not re-run on normal navigations re-using the loader
      await router.navigate("/child");
      await router.navigate("/");
      await router.navigate("/child");
      expect(rootLoader.mock.calls.length).toBe(1);
      expect(shouldReload.mock.calls.length).toBe(0);

      // Should use shouldReload() if it's a same-path
      await router.navigate("/child");
      expect(rootLoader.mock.calls.length).toBe(1);
      expect(shouldReload.mock.calls.length).toBe(1);
      expect(shouldReload.mock.calls[0]).toMatchObject([
        {
          url: "/child",
        },
      ]);

      // Should use shouldReload() if it's a query string change
      await router.navigate("/child?reload=1");
      expect(rootLoader.mock.calls.length).toBe(2);
      expect(shouldReload.mock.calls.length).toBe(2);
      expect(shouldReload.mock.calls[1]).toMatchObject([
        {
          url: "/child?reload=1",
        },
      ]);

      // Should use shouldReload() if it's a form submission revalidation
      await router.navigate("/child", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(rootLoader.mock.calls.length).toBe(2);
      expect(shouldReload.mock.calls.length).toBe(3);
      expect(shouldReload.mock.calls[2]).toMatchObject([
        {
          url: "/child",
          formData: createFormData({ gosh: "dang" }),
        },
      ]);
    });
  });

  describe("no route match", () => {
    it("transitions to root catch", () => {
      let t = initializeTmTest();
      t.navigate("/not-found");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT",
      });
      expect(t.router.state.exceptions).toEqual({
        root: new Response(null, { status: 404 }),
      });
      expect(t.router.state.matches).toMatchObject([
        {
          params: {},
          pathname: "",
          route: {
            exceptionElement: true,
            children: expect.any(Array),
            element: {},
            id: "root",
            loader: expect.any(Function),
            module: "",
            path: "",
          },
        },
      ]);
    });
  });

  describe("errors on navigation", () => {
    describe("with an error boundary in the throwing route", () => {
      it("uses the throwing route's error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              children: [
                {
                  path: "/child",
                  id: "child",
                  exceptionElement: true,
                  loader: true,
                },
              ],
            },
          ],
        });
        let nav = await t.navigate("/child");
        await nav.loaders.child.reject(new Error("Kaboom!"));
        expect(t.router.state.exceptions).toEqual({
          child: new Error("Kaboom!"),
        });
      });
    });

    describe("with an error boundary above the throwing route", () => {
      it("uses the nearest error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              exceptionElement: true,
              children: [
                {
                  path: "/child",
                  id: "child",
                  loader: true,
                },
              ],
            },
          ],
        });
        let nav = await t.navigate("/child");
        await nav.loaders.child.reject(new Error("Kaboom!"));
        expect(t.router.state.exceptions).toEqual({
          parent: new Error("Kaboom!"),
        });
      });

      it("clears out the error on new locations", async () => {
        let t = setup({
          routes: [
            {
              path: "",
              id: "root",
              loader: true,
              children: [
                {
                  path: "/",
                  id: "parent",
                  children: [
                    {
                      path: "/child",
                      id: "child",
                      exceptionElement: true,
                      loader: true,
                    },
                  ],
                },
              ],
            },
          ],
        });

        let nav = await t.navigate("/child");
        await nav.loaders.root.resolve("ROOT1");
        await nav.loaders.child.reject("Kaboom!");
        expect(t.router.state.loaderData).toEqual({ root: "ROOT1" });
        expect(t.router.state.exceptions).toEqual({ child: "Kaboom!" });

        await t.navigate("/");
        expect(t.router.state.loaderData).toEqual({ root: "ROOT1" });
        expect(t.router.state.exceptions).toBe(null);
      });
    });

    it("loads data above error boundary route", async () => {
      let t = setup({
        routes: [
          {
            path: "/",
            id: "a",
            loader: true,
            children: [
              {
                path: "/b",
                id: "b",
                loader: true,
                exceptionElement: true,
                children: [
                  {
                    path: "/b/c",
                    id: "c",
                    loader: true,
                  },
                ],
              },
            ],
          },
        ],
        hydrationData: { loaderData: { a: "LOADER A" } },
      });
      let nav = await t.navigate("/b/c");
      await nav.loaders.b.resolve("LOADER B");
      await nav.loaders.c.reject("Kaboom!");
      expect(t.router.state.loaderData).toEqual({
        a: "LOADER A",
        b: "LOADER B",
      });
      expect(t.router.state.exceptions).toEqual({
        b: "Kaboom!",
      });
    });
  });

  describe("POP navigations after action redirect", () => {
    it("does a normal load when backing into an action redirect", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      let B = await A.actions.foo.redirect("/bar");
      await B.loaders.root.resolve("ROOT DATA");
      await B.loaders.bar.resolve("B LOADER");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT DATA",
        bar: "B LOADER",
      });

      let C = await t.navigate("/baz");
      await C.loaders.baz.resolve("C LOADER");
      expect(C.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT DATA",
        baz: "C LOADER",
      });

      let D = await t.navigate(-2);
      await D.loaders.bar.resolve("D LOADER");
      expect(D.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT DATA",
        bar: "D LOADER",
      });
    });
  });

  describe("submission navigations", () => {
    it("reloads all routes when a loader during an actionReload redirects", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      await A.actions.foo.resolve("FOO ACTION");
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);

      let B = await A.loaders.foo.redirect("/bar");
      await A.loaders.root.reject("ROOT ERROR");
      await B.loaders.root.resolve("ROOT LOADER 2");
      await B.loaders.bar.resolve("BAR LOADER");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state).toMatchObject({
        loaderData: {
          root: "ROOT LOADER 2",
          bar: "BAR LOADER",
        },
        exceptions: {},
      });
    });

    it("commits action data as soon as it lands", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(t.router.state.actionData).toBeNull();

      await A.actions.foo.resolve("A");
      expect(t.router.state.actionData).toEqual({
        foo: "A",
      });
    });

    it("reloads all routes after the action", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      await A.actions.foo.resolve(null);
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);

      await A.loaders.foo.resolve("A LOADER");
      expect(t.router.state.transition.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT", // old data
        index: "INDEX", // old data
      });

      await A.loaders.root.resolve("ROOT LOADER");
      expect(t.router.state.transition.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        foo: "A LOADER",
        root: "ROOT LOADER",
      });
    });

    it("reloads all routes after action redirect (throw)", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      let B = await A.actions.foo.redirect("/bar");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);

      await B.loaders.root.resolve("ROOT LOADER");
      expect(t.router.state.transition.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT", // old data
        index: "INDEX", // old data
      });

      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.transition.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        bar: "B LOADER",
        root: "ROOT LOADER",
      });
    });

    it("reloads all routes after action redirect (return)", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      let B = await A.actions.foo.redirectReturn("/bar");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);

      await B.loaders.root.resolve("ROOT LOADER");
      expect(t.router.state.transition.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT", // old data
        index: "INDEX", // old data
      });

      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.transition.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        bar: "B LOADER",
        root: "ROOT LOADER",
      });
    });

    it("removes action data at new locations", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await A.actions.foo.resolve("A ACTION");
      await A.loaders.foo.resolve("A LOADER");
      expect(t.router.state.actionData).toEqual({ foo: "A ACTION" });

      let B = await t.navigate("/bar");
      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.actionData).toBeNull();
    });

    it("uses the proper action for index routes", async () => {
      let t = setup({
        routes: [
          {
            path: "/",
            id: "parent",
            children: [
              {
                path: "/child",
                id: "child",
                exceptionElement: true,
                action: true,
                children: [
                  {
                    index: true,
                    id: "childIndex",
                    exceptionElement: true,
                    action: true,
                  },
                ],
              },
            ],
          },
        ],
      });
      let A = await t.navigate("/child", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await A.actions.child.resolve("CHILD");
      expect(t.router.state.actionData).toEqual({
        child: "CHILD",
      });

      let B = await t.navigate("/child?index", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await B.actions.childIndex.resolve("CHILD INDEX");
      expect(t.router.state.actionData).toEqual({
        childIndex: "CHILD INDEX",
      });
    });

    it("retains the index match when submitting to a layout route", async () => {
      let t = setup({
        routes: [
          {
            path: "/",
            id: "parent",
            loader: true,
            action: true,
            children: [
              {
                path: "/child",
                id: "child",
                loader: true,
                action: true,
                children: [
                  {
                    index: true,
                    id: "childIndex",
                    loader: true,
                    action: true,
                  },
                ],
              },
            ],
          },
        ],
      });
      let A = await t.navigate("/child", {
        formMethod: "post",
        formData: new FormData(),
      });
      await A.actions.child.resolve("CHILD ACTION");
      await A.loaders.parent.resolve("PARENT LOADER");
      await A.loaders.child.resolve("CHILD LOADER");
      await A.loaders.childIndex.resolve("CHILD INDEX LOADER");
      expect(t.router.state.transition.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        parent: "PARENT LOADER",
        child: "CHILD LOADER",
        childIndex: "CHILD INDEX LOADER",
      });
      expect(t.router.state.actionData).toEqual({
        child: "CHILD ACTION",
      });
      expect(t.router.state.matches.map((m) => m.route.id)).toEqual([
        "parent",
        "child",
        "childIndex",
      ]);
    });
  });

  describe("action errors", () => {
    describe("with an error boundary in the action route", () => {
      it("uses the action route's error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              children: [
                {
                  path: "/child",
                  id: "child",
                  exceptionElement: true,
                  action: true,
                },
              ],
            },
          ],
        });
        let A = await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        expect(t.router.state.exceptions).toEqual({
          child: new Error("Kaboom!"),
        });
      });

      it("loads parent data, but not action data", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              loader: true,
              children: [
                {
                  path: "/child",
                  id: "child",
                  exceptionElement: true,
                  loader: true,
                  action: true,
                },
              ],
            },
          ],
        });
        let A = await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        expect(A.loaders.parent.stub.mock.calls.length).toBe(1);
        expect(A.loaders.child.stub.mock.calls.length).toBe(0);
        await A.loaders.parent.resolve("PARENT LOADER");
        expect(t.router.state).toMatchObject({
          loaderData: {
            parent: "PARENT LOADER",
          },
          actionData: null,
          exceptions: {
            child: new Error("Kaboom!"),
          },
        });
      });
    });

    describe("with an error boundary above the action route", () => {
      it("uses the nearest error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              exceptionElement: true,
              children: [
                {
                  path: "/child",
                  id: "child",
                  action: true,
                },
              ],
            },
          ],
        });
        let A = await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        expect(t.router.state.exceptions).toEqual({
          parent: new Error("Kaboom!"),
        });
      });
    });

    describe("with a parent loader that throws also, good grief!", () => {
      it("uses action error but nearest errorBoundary to parent", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "root",
              exceptionElement: true,
              children: [
                {
                  path: "/parent",
                  id: "parent",
                  loader: true,
                  children: [
                    {
                      path: "/parent/child",
                      id: "child",
                      action: true,
                      exceptionElement: true,
                    },
                  ],
                },
              ],
            },
          ],
        });

        let A = await t.navigate("/parent/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        await A.loaders.parent.reject(new Error("Should not see this!"));
        expect(t.router.state).toMatchObject({
          loaderData: {},
          actionData: {},
          exceptions: {
            root: new Error("Kaboom!"),
          },
        });
      });
    });

    describe("with no corresponding action", () => {
      it("throws a 405 Response", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              children: [
                {
                  path: "/child",
                  id: "child",
                  exceptionElement: true,
                },
              ],
            },
          ],
        });
        let spy = jest.spyOn(console, "warn").mockImplementation(() => {});
        await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        expect(t.router.state.exceptions).toEqual({
          child: new Response(null, { status: 405 }),
        });
        expect(console.warn).toHaveBeenCalled();
        spy.mockReset();
      });

      it("still calls appropriate loaders after 405", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              loader: true,
              children: [
                {
                  path: "child",
                  id: "child",
                  loader: true,
                  children: [
                    {
                      path: "grandchild",
                      id: "grandchild",
                      loader: true,
                      // no action to post to
                      exceptionElement: true,
                    },
                  ],
                },
              ],
            },
          ],
          hydrationData: {
            loaderData: {
              parent: "PARENT DATA",
            },
          },
        });
        let A = await t.navigate("/child/grandchild", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        expect(t.router.state.exceptions).toBe(null);
        expect(A.loaders.parent.stub.mock.calls.length).toBe(1); // called again for revalidation
        expect(A.loaders.child.stub.mock.calls.length).toBe(1); // called because it's above exception
        expect(A.loaders.grandchild.stub.mock.calls.length).toBe(0); // dont call due to exception
        await A.loaders.parent.resolve("PARENT DATA*");
        await A.loaders.child.resolve("CHILD DATA");
        expect(t.router.state.loaderData).toEqual({
          parent: "PARENT DATA*",
          child: "CHILD DATA",
        });
        expect(t.router.state.actionData).toBe(null);
        expect(t.router.state.exceptions).toEqual({
          grandchild: new Response(null, { status: 405 }),
        });
      });
    });
  });

  describe("transition states", () => {
    it("initialization", async () => {
      let t = initializeTmTest();
      let transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });

    it("get", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      let transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("normalLoad");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.loaders.foo.resolve("A");
      transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });

    it("get + redirect", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo");
      let B = await A.loaders.foo.redirect("/bar");

      let transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("normalRedirect");
      expect(transition.formData).toBeUndefined();
      expect(transition.location?.pathname).toBe("/bar");

      await B.loaders.bar.resolve("B");
      transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });

    it("action submission", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      let transition = t.router.state.transition;
      expect(transition.state).toBe("submitting");
      expect(transition.type).toBe("actionSubmission");

      expect(
        // @ts-expect-error
        new URLSearchParams(transition.formData).toString()
      ).toBe("gosh=dang");
      expect(transition.formMethod).toBe("post");
      expect(transition.formEncType).toBe("application/x-www-form-urlencoded");
      expect(transition.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.actions.foo.resolve("A");
      transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("actionReload");
      expect(
        // @ts-expect-error
        new URLSearchParams(transition.formData).toString()
      ).toBe("gosh=dang");
      expect(transition.formMethod).toBe("post");
      expect(transition.formEncType).toBe("application/x-www-form-urlencoded");
      expect(transition.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.loaders.foo.resolve("A");
      transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("actionReload");

      await A.loaders.root.resolve("B");
      transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });

    it("action submission + redirect", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      let B = await A.actions.foo.redirect("/bar");

      let transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("submissionRedirect");
      expect(
        // @ts-expect-error
        new URLSearchParams(transition.formData).toString()
      ).toBe("gosh=dang");
      expect(transition.formMethod).toBe("post");
      expect(transition.location).toMatchObject({
        pathname: "/bar",
        search: "",
        hash: "",
      });

      await B.loaders.bar.resolve("B");
      transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("submissionRedirect");

      await B.loaders.root.resolve("C");
      transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });

    it("loader submission", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formData: createFormData({ gosh: "dang" }),
      });
      let transition = t.router.state.transition;
      expect(transition.state).toBe("submitting");
      expect(transition.type).toBe("loaderSubmission");
      expect(
        // @ts-expect-error
        new URLSearchParams(transition.formData).toString()
      ).toBe("gosh=dang");
      expect(transition.formMethod).toBe("get");
      expect(transition.formEncType).toBe("application/x-www-form-urlencoded");
      expect(transition.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.loaders.foo.resolve("A");
      transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });

    it("loader submission + redirect", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formData: createFormData({ gosh: "dang" }),
      });
      let B = await A.loaders.foo.redirect("/bar");

      let transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("submissionRedirect");
      expect(
        // @ts-expect-error
        new URLSearchParams(transition.formData).toString()
      ).toBe("gosh=dang");
      expect(transition.formMethod).toBe("get");
      expect(transition.formEncType).toBe("application/x-www-form-urlencoded");
      expect(transition.location).toMatchObject({
        pathname: "/bar",
        search: "",
        hash: "",
      });

      await B.loaders.bar.resolve("B");
      transition = t.router.state.transition;
      expect(transition.state).toBe("loading");
      expect(transition.type).toBe("submissionRedirect");

      await B.loaders.root.resolve("C");
      transition = t.router.state.transition;
      expect(transition.state).toBe("idle");
      expect(transition.type).toBe("idle");
      expect(transition.formData).toBeUndefined();
      expect(transition.location).toBeUndefined();
    });
  });

  describe("interruptions", () => {
    describe(`
      A) GET /foo |---X
      B) GET /bar     |---O
    `, () => {
      it("aborts previous load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo");
        t.navigate("/bar");
        expect(A.loaders.foo.stub.mock.calls.length).toBe(1);
      });
    });

    describe(`
      A) GET  /foo |---X
      B) POST /bar     |---O
    `, () => {
      it("aborts previous load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo");
        await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) POST /foo |---X
      B) POST /bar     |---O
    `, () => {
      it("aborts previous action", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        expect(A.actions.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) POST /foo |--|--X
      B) GET  /bar       |---O
    `, () => {
      it("aborts previous action reload", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        await A.actions.foo.resolve("A ACTION");
        await t.navigate("/bar");
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) POST /foo |--|--X
      B) POST /bar       |---O
    `, () => {
      it("aborts previous action reload", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        await A.actions.foo.resolve("A ACTION");
        await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) GET /foo |--/bar--X
      B) GET /baz          |---O
    `, () => {
      it("aborts previous action redirect load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo");
        let AR = await A.loaders.foo.redirect("/bar");
        t.navigate("/baz");
        expect(AR.loaders.bar.stub.mock.calls.length).toBe(1);
      });
    });

    describe(`
      A) POST /foo |--/bar--X
      B) GET  /baz          |---O
    `, () => {
      it("aborts previous action redirect load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        let AR = await A.actions.foo.redirect("/bar");
        await t.navigate("/baz");
        expect(AR.loaders.bar.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) GET /foo |---X
      B) GET /bar     |---X
      C) GET /baz         |---O
    `, () => {
      it("aborts multiple subsequent loads", async () => {
        let t = initializeTmTest();
        // Start A navigation and immediately interrupt
        let A = await t.navigate("/foo");
        let B = await t.navigate("/bar");
        // resolve A then interrupt B - ensure the A resolution doesn't clear
        // the new pendingNavigationController which is now reflecting B's nav
        await A.loaders.foo.resolve("A");
        let C = await t.navigate("/baz");
        await B.loaders.bar.resolve("B");
        await C.loaders.baz.resolve("C");

        expect(A.loaders.foo.stub.mock.calls.length).toBe(1);
        expect(A.loaders.foo.signal.aborted).toBe(true);

        expect(B.loaders.bar.stub.mock.calls.length).toBe(1);
        expect(B.loaders.bar.signal.aborted).toBe(true);

        expect(C.loaders.baz.stub.mock.calls.length).toBe(1);
        expect(C.loaders.baz.signal.aborted).toBe(false);

        expect(t.router.state.loaderData).toEqual({
          root: "ROOT",
          baz: "C",
        });
      });
    });

    describe(`
      A) POST /foo |---X
      B) POST /bar     |---X
      C) POST /baz         |---O
    `, () => {
      it("aborts previous load", async () => {
        let t = initializeTmTest();
        // Start A navigation and immediately interrupt
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        let B = await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        // resolve A then interrupt B - ensure the A resolution doesn't clear
        // the new pendingNavigationController which is now reflecting B's nav
        await A.actions.foo.resolve("A");
        let C = await t.navigate("/baz", {
          formMethod: "post",
          formData: new FormData(),
        });
        await B.actions.bar.resolve("B");
        await C.actions.baz.resolve("C");

        expect(A.actions.foo.stub.mock.calls.length).toBe(1);
        expect(A.actions.foo.signal.aborted).toBe(true);

        expect(B.actions.bar.stub.mock.calls.length).toBe(1);
        expect(B.actions.bar.signal.aborted).toBe(true);

        expect(C.actions.baz.stub.mock.calls.length).toBe(1);
        expect(C.actions.baz.signal.aborted).toBe(false);

        expect(t.router.state.actionData).toEqual({
          baz: "C",
        });
      });
    });
  });

  describe("navigation (new)", () => {
    it("navigates through a history stack without data loading", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "tasks",
            path: "tasks",
          },
          {
            id: "tasksId",
            path: "tasks/:id",
          },
        ],
        initialEntries: ["/"],
      });

      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/" })],
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/tasks" })],
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks");

      await t.navigate("/tasks/1", { replace: true });
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: {
          pathname: "/tasks/1",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/tasks/1" })],
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      await t.router.navigate(-1);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/" })],
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await t.navigate("/tasks?foo=bar#hash");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks",
          search: "?foo=bar",
          hash: "#hash",
          state: null,
          key: expect.any(String),
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/tasks" })],
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location).toEqual({
        pathname: "/tasks",
        search: "?foo=bar",
        hash: "#hash",
        state: null,
        key: expect.any(String),
      });

      t.cleanup();
    });

    it("handles 404 routes", () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });
      t.navigate("/junk");
      expect(t.router.state).toMatchObject({
        location: {
          pathname: "/junk",
        },
        transition: IDLE_TRANSITION,
        loaderData: {},
        exceptions: {
          root: new Response(null, { status: 404 }),
        },
      });
    });
  });

  describe("data loading (new)", () => {
    it("hydrates initial data", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT DATA",
            index: "INDEX DATA",
          },
        },
      });

      expect(console.warn).not.toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        initialized: true,
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT DATA",
          index: "INDEX DATA",
        },
      });
    });

    it("kicks off initial data load if no hydration data is provided", async () => {
      let parentDfd = defer();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = defer();
      let childSpy = jest.fn(() => childDfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
            ],
          },
        ],
      });

      expect(console.warn).not.toHaveBeenCalled();
      expect(parentSpy.mock.calls.length).toBe(1);
      expect(childSpy.mock.calls.length).toBe(1);
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        transition: {
          state: "loading",
          type: "normalLoad",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await parentDfd.resolve("PARENT DATA");
      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        transition: {
          state: "loading",
          type: "normalLoad",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await childDfd.resolve("CHILD DATA");
      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        transition: IDLE_TRANSITION,
        loaderData: {
          "0": "PARENT DATA",
          "0-0": "CHILD DATA",
        },
      });
    });

    it("kicks off initial data load if partial hydration data is provided", async () => {
      let parentDfd = defer();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = defer();
      let childSpy = jest.fn(() => childDfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
            ],
          },
        ],
        hydrationData: {
          loaderData: {
            "0": "PARENT DATA",
          },
        },
      });

      expect(console.warn).toHaveBeenCalledWith(
        "The provided hydration data did not find loaderData for all matched " +
          "routes with loaders.  Performing a full initial data load"
      );
      expect(parentSpy.mock.calls.length).toBe(1);
      expect(childSpy.mock.calls.length).toBe(1);
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        transition: {
          state: "loading",
          type: "normalLoad",
        },
      });
      expect(router.state.loaderData).toEqual({});

      await parentDfd.resolve("PARENT DATA 2");
      await childDfd.resolve("CHILD DATA");
      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        transition: IDLE_TRANSITION,
        loaderData: {
          "0": "PARENT DATA 2",
          "0-0": "CHILD DATA",
        },
      });
    });

    it("does not kick off initial data load due to partial hydration if exceptions exist", async () => {
      let parentDfd = defer();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = defer();
      let childSpy = jest.fn(() => childDfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
            ],
          },
        ],
        hydrationData: {
          exceptions: {
            "0": "PARENT ERROR",
          },
          loaderData: {
            "0-0": "CHILD_DATA",
          },
        },
      });

      expect(console.warn).not.toHaveBeenCalled();
      expect(parentSpy).not.toHaveBeenCalled();
      expect(childSpy).not.toHaveBeenCalled();
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        transition: IDLE_TRANSITION,
        exceptions: {
          "0": "PARENT ERROR",
        },
        loaderData: {
          "0-0": "CHILD_DATA",
        },
      });
    });

    it("handles interruptions of initial data load", async () => {
      let parentDfd = defer();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = defer();
      let childSpy = jest.fn(() => childDfd.promise);
      let child2Dfd = defer();
      let child2Spy = jest.fn(() => child2Dfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
              {
                path: "child2",
                loader: child2Spy,
              },
            ],
          },
        ],
      });

      expect(console.warn).not.toHaveBeenCalled();
      expect(parentSpy.mock.calls.length).toBe(1);
      expect(childSpy.mock.calls.length).toBe(1);
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        transition: {
          state: "loading",
          type: "normalLoad",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await parentDfd.resolve("PARENT DATA");
      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        transition: {
          state: "loading",
          type: "normalLoad",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      router.navigate("/child2");
      await childDfd.resolve("CHILD DATA");
      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        transition: {
          state: "loading",
          type: "normalLoad",
          location: { pathname: "/child2" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await child2Dfd.resolve("CHILD2 DATA");
      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "PUSH",
        location: expect.objectContaining({ pathname: "/child2" }),
        initialized: true,
        transition: IDLE_TRANSITION,
        loaderData: {
          "0": "PARENT DATA",
          "0-1": "CHILD2 DATA",
        },
      });
    });

    it("handles exceptions in initial data load", async () => {
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: () => Promise.reject("Kaboom!"),
            children: [
              {
                path: "child",
                loader: () => Promise.resolve("child"),
              },
            ],
          },
        ],
      });

      await new Promise((r) => setImmediate(r));
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        transition: IDLE_TRANSITION,
        loaderData: {
          "0-0": "child",
        },
        exceptions: {
          "0": "Kaboom!",
        },
      });
    });

    it("executes loaders on push navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav1 = await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
          type: "normalLoad",
        },
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav1.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks",
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks");

      let nav2 = await t.navigate("/tasks/1");
      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks/1",
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
          tasksId: "TASKS_ID_DATA",
        },
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      t.cleanup();
    });

    it("executes loaders on replace navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav = await t.navigate("/tasks", { replace: true });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
          type: "normalLoad",
        },
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: {
          pathname: "/tasks",
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks");

      t.cleanup();
    });

    it("executes loaders on go navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/", "/tasks"],
        initialIndex: 0,
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // pop forward to /tasks
      let nav2 = await t.navigate(1);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
          type: "normalLoad",
        },
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/tasks");

      await nav2.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/tasks",
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/tasks");

      t.cleanup();
    });

    it("persists location keys throughout navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      expect(t.router.state.location.key).toBe("default");

      let A = await t.navigate("/tasks");
      let transitionKey = t.router.state.transition.location?.key;
      expect(t.router.state.location.key).toBe("default");
      expect(t.router.state.transition.state).toBe("loading");
      expect(transitionKey).not.toBe("default");
      expect(Number(transitionKey?.length) > 0).toBe(true);

      await A.loaders.tasks.resolve("TASKS");
      expect(t.router.state.transition.state).toBe("idle");

      // Make sure we keep the same location.key throughout the transition and
      // history isn't creating a new one in history.push
      expect(t.router.state.location.key).toBe(transitionKey);
      expect(t.history.location.key).toBe(transitionKey);

      t.cleanup();
    });

    it("sends proper arguments to loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let nav = await t.navigate("/tasks");
      expect(nav.loaders.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: new Request("/tasks"),
        signal: expect.any(AbortSignal),
      });

      let nav2 = await t.navigate("/tasks/1");
      expect(nav2.loaders.tasksId.stub).toHaveBeenCalledWith({
        params: { id: "1" },
        request: new Request("/tasks/1"),
        signal: expect.any(AbortSignal),
      });

      let nav3 = await t.navigate("/tasks?foo=bar#hash");
      expect(nav3.loaders.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: new Request("/tasks?foo=bar"),
        signal: expect.any(AbortSignal),
      });

      t.cleanup();
    });

    it("handles exceptions thrown from loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.reject("TASKS_ERROR");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
      expect(t.router.state.exceptions).toEqual({
        tasks: "TASKS_ERROR",
      });

      // Throw from index, handled by root
      let nav2 = await t.navigate("/");
      await nav2.loaders.index.reject("INDEX_ERROR");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
      expect(t.router.state.exceptions).toEqual({
        root: "INDEX_ERROR",
      });

      t.cleanup();
    });

    it("re-runs loaders on post-exception navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          exceptions: {
            root: "ROOT_ERROR",
          },
        },
      });

      // If a route has an exception, we should call the loader if that route is
      // re-used on a navigation
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.transition.state).toEqual("loading");
      expect(t.router.state.loaderData).toEqual({});
      expect(t.router.state.exceptions).toEqual({
        root: "ROOT_ERROR",
      });

      await nav.loaders.root.resolve("ROOT_DATA");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });
      expect(t.router.state.exceptions).toBe(null);

      t.cleanup();
    });

    it("handles interruptions during navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let historySpy = jest.spyOn(t.history, "push");

      let nav = await t.navigate("/tasks");
      expect(t.router.state.transition.type).toEqual("normalLoad");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(nav.loaders.tasks.signal.aborted).toBe(false);
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      // Interrupt and confirm prior loader was aborted
      let nav2 = await t.navigate("/tasks/1");
      expect(t.router.state.transition.type).toEqual("normalLoad");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(nav.loaders.tasks.signal.aborted).toBe(true);
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      // Complete second navigation
      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.location.pathname).toEqual("/tasks/1");
      expect(t.history.location.pathname).toEqual("/tasks/1");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasksId: "TASKS_ID_DATA",
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      // Resolve first navigation - should no-op
      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.transition).toEqual(IDLE_TRANSITION);
      expect(t.router.state.location.pathname).toEqual("/tasks/1");
      expect(t.history.location.pathname).toEqual("/tasks/1");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasksId: "TASKS_ID_DATA",
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      expect(historySpy.mock.calls).toEqual([
        [
          expect.objectContaining({
            pathname: "/tasks/1",
          }),
          null,
        ],
      ]);
      t.cleanup();
    });

    it("handles redirects thrown from loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav1 = await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
          type: "normalLoad",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        exceptions: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      let nav2 = await nav1.loaders.tasks.redirect("/tasks/1");

      // Should not abort if it redirected
      expect(nav1.loaders.tasks.signal.aborted).toBe(false);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks/1",
          },
          state: "loading",
          type: "normalRedirect",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        exceptions: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: {
          pathname: "/tasks/1",
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
          tasksId: "TASKS_ID_DATA",
        },
        exceptions: null,
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      t.cleanup();
    });

    it("handles redirects returned from loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav1 = await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
          type: "normalLoad",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        exceptions: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      let nav2 = await nav1.loaders.tasks.redirectReturn("/tasks/1");

      // Should not abort if it redirected
      expect(nav1.loaders.tasks.signal.aborted).toBe(false);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        transition: {
          location: {
            pathname: "/tasks/1",
          },
          state: "loading",
          type: "normalRedirect",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        exceptions: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: {
          pathname: "/tasks/1",
        },
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
          tasksId: "TASKS_ID_DATA",
        },
        exceptions: null,
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      t.cleanup();
    });

    it("handles thrown non-redirect Responses as normal exceptions", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = await t.navigate("/tasks");
      let response = new Response(null, { status: 400 });
      await nav.loaders.tasks.reject(response);
      expect(t.router.state).toMatchObject({
        transition: IDLE_TRANSITION,
        loaderData: {
          root: "ROOT_DATA",
        },
        actionData: null,
        exceptions: {
          tasks: response,
        },
      });

      t.cleanup();
    });

    it("sends proper arguments to actions", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let formData = createFormData({ query: "params" });

      let nav = await t.navigate("/tasks", { formMethod: "post", formData });
      expect(nav.actions.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: new Request("/tasks"),
        signal: expect.any(AbortSignal),
        formMethod: "post",
        formEncType: "application/x-www-form-urlencoded",
        formData,
      });

      t.cleanup();
    });
  });

  describe("router.revalidate", () => {
    it("handles uninterrupted revalidation in an idle state (from POP)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });
      expect(t.router.state.location.key).toBe(key);
      expect(t.history.push).not.toHaveBeenCalled();
      expect(t.history.replace).not.toHaveBeenCalled();

      t.cleanup();
    });

    it("handles uninterrupted revalidation in an idle state (from PUSH)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/");
      await N.loaders.root.resolve("ROOT_DATA");
      await N.loaders.index.resolve("INDEX_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      // @ts-expect-error
      expect(t.history.push.mock.calls.length).toBe(1);

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });
      expect(t.router.state.location.key).toBe(key);
      // @ts-ignore
      expect(t.history.push.mock.calls.length).toBe(1);
      expect(t.history.replace).not.toHaveBeenCalled();

      t.cleanup();
    });

    it("handles revalidation interrupted by a <Link> navigation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/tasks");
      // Revalidation was aborted
      expect(R.loaders.root.signal.aborted).toBe(true);
      expect(R.loaders.index.signal.aborted).toBe(true);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: {
          state: "loading",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      // Land the revalidation calls - should no-op
      await R.loaders.root.resolve("ROOT_DATA interrupted");
      await R.loaders.index.resolve("INDEX_DATA interrupted");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: {
          state: "loading",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      // Land the navigation calls - should update state and end the revalidation
      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      t.cleanup();
    });

    it("handles revalidation interrupted by a <Form method=get> navigation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let formData = createFormData({ key: "value" });
      let N = await t.navigate("/tasks", {
        formMethod: "get",
        formData,
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: {
          state: "submitting",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      await R.loaders.root.resolve("ROOT_DATA interrupted");
      await R.loaders.index.resolve("INDEX_DATA interrupted");
      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      t.cleanup();
    });

    it("handles revalidation interrupted by a <Form method=post> navigation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: {
          state: "submitting",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      // Aborted by the navigation, resolving should no-op
      expect(R.loaders.root.signal.aborted).toBe(true);
      expect(R.loaders.index.signal.aborted).toBe(true);
      await R.loaders.root.resolve("ROOT_DATA interrupted");
      await R.loaders.index.resolve("INDEX_DATA interrupted");

      await N.actions.tasks.resolve("TASKS_ACTION");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: {
          state: "loading",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      t.cleanup();
    });

    it("handles <Link> navigation interrupted by a revalidation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks");
      expect(N.loaders.root.stub).not.toHaveBeenCalled();
      expect(N.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "loading" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let R = await t.revalidate();
      expect(R.loaders.root.stub).toHaveBeenCalled();
      expect(R.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "loading" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      t.cleanup();
    });

    it("handles <Form method=get> navigation interrupted by a revalidation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks?key=value", {
        formMethod: "get",
        formData: createFormData({ key: "value" }),
      });
      // Called due to search param changing
      expect(N.loaders.root.stub).toHaveBeenCalled();
      expect(N.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "submitting" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let R = await t.revalidate();
      expect(R.loaders.root.stub).toHaveBeenCalled();
      expect(R.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "submitting" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA interrupted");
      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      t.cleanup();
    });

    it("handles <Form method=post> navigation interrupted by a revalidation during action phase", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "submitting" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "submitting" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.actions.tasks.resolve("TASKS_ACTION");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "loading" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA interrupted");
      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      // Action was not resubmitted
      expect(N.actions.tasks.stub.mock.calls.length).toBe(1);
      // This is sort of an implementation detail.  Internally we do not start
      // a new navigation, but our helpers return the new "loaders" from the
      // revalidate.  The key here is that together, loaders only got called once
      expect(N.loaders.root.stub.mock.calls.length).toBe(0);
      expect(N.loaders.tasks.stub.mock.calls.length).toBe(0);
      expect(R.loaders.root.stub.mock.calls.length).toBe(1);
      expect(R.loaders.tasks.stub.mock.calls.length).toBe(1);

      t.cleanup();
    });

    it("handles <Form method=post> navigation interrupted by a revalidation during loading phase", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "submitting" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.actions.tasks.resolve("TASKS_ACTION");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "loading" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: { state: "loading" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA interrupted");
      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      // Action was not resubmitted
      expect(N.actions.tasks.stub.mock.calls.length).toBe(1);
      // Because we interrupted during the loading phase, all loaders got re-called
      expect(N.loaders.root.stub.mock.calls.length).toBe(1);
      expect(N.loaders.tasks.stub.mock.calls.length).toBe(1);
      expect(R.loaders.root.stub.mock.calls.length).toBe(1);
      expect(R.loaders.tasks.stub.mock.calls.length).toBe(1);

      t.cleanup();
    });

    it("handles redirects returned from revalidations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.resolve("ROOT_DATA*");
      let N = await R.loaders.index.redirectReturn("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: {
          state: "loading",
          type: "normalRedirect",
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.router.state.location.key).toBe(key);

      await N.loaders.root.resolve("ROOT_DATA redirect");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: { pathname: "/tasks" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA redirect",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.router.state.location.key).not.toBe(key);

      t.cleanup();
    });

    it("handles exceptions from revalidations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.reject("ROOT_ERROR");
      await R.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA*",
        },
        exceptions: {
          root: "ROOT_ERROR",
        },
      });
      expect(t.router.state.location.key).toBe(key);

      t.cleanup();
    });

    it("leverages shouldReload on revalidation routes", async () => {
      let shouldReload = jest.fn(({ url }) => {
        return new URLSearchParams(parsePath(url).search).get("reload") === "1";
      });
      let t = setup({
        routes: [
          {
            id: "root",
            loader: true,
            shouldReload: (...args) => shouldReload(...args),
            children: [
              {
                id: "index",
                index: true,
                loader: true,
                shouldReload: (...args) => shouldReload(...args),
              },
            ],
          },
        ],
        initialEntries: ["/?reload=0"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(R.loaders.root.stub).not.toHaveBeenCalled();
      expect(R.loaders.index.stub).not.toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/?reload=1");
      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });

      let R2 = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });

      await R2.loaders.root.resolve("ROOT_DATA**");
      await R2.loaders.index.resolve("INDEX_DATA**");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        transition: IDLE_TRANSITION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA**",
          index: "INDEX_DATA**",
        },
      });

      t.cleanup();
    });
  });

  describe("fetchers", () => {
    describe("fetcher states", () => {
      // TODO: Remove once confident in below tests
      it("unabstracted loader fetch", async () => {
        let dfd = defer();
        let router = createRouter({
          history: createMemoryHistory({ initialEntries: ["/"] }),
          routes: [
            {
              id: "root",
              path: "/",
              loader: () => dfd.promise,
            },
          ],
          hydrationData: {
            loaderData: { root: "ROOT DATA" },
          },
        });

        let key = "key";
        router.fetch(key, "/");
        expect(router.state.fetchers.get(key)).toEqual({
          state: "loading",
          type: "normalLoad",
          formMethod: undefined,
          formEncType: undefined,
          formData: undefined,
          data: undefined,
        });

        await dfd.resolve("DATA");
        expect(router.state.fetchers.get(key)).toEqual({
          state: "idle",
          type: "done",
          formMethod: undefined,
          formEncType: undefined,
          formData: undefined,
          data: "DATA",
        });
      });

      it("loader fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });

        let A = await t.fetch("/foo");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.type).toBe("normalLoad");

        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.type).toBe("done");
        expect(A.fetcher.data).toBe("A DATA");
      });

      it("loader re-fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "key";

        let A = await t.fetch("/foo", key);
        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.type).toBe("done");
        expect(A.fetcher.data).toBe("A DATA");

        let B = await t.fetch("/foo", key);
        expect(B.fetcher.state).toBe("loading");
        expect(B.fetcher.type).toBe("normalLoad");
        expect(B.fetcher.data).toBe("A DATA");

        await B.loaders.foo.resolve("B DATA");
        expect(B.fetcher.state).toBe("idle");
        expect(B.fetcher.type).toBe("done");
        expect(B.fetcher.data).toBe("B DATA");

        expect(A.fetcher).toBe(B.fetcher);
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });

        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");
        expect(A.fetcher.type).toBe("loaderSubmission");

        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.type).toBe("done");
        expect(A.fetcher.data).toBe("A DATA");
      });

      it("loader submission re-fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "key";

        let A = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.type).toBe("done");
        expect(A.fetcher.data).toBe("A DATA");

        let B = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        expect(B.fetcher.state).toBe("submitting");
        expect(B.fetcher.type).toBe("loaderSubmission");
        expect(B.fetcher.data).toBe("A DATA");

        await B.loaders.foo.resolve("B DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.type).toBe("done");
        expect(A.fetcher.data).toBe("B DATA");
      });

      it("action fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });

        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");
        expect(A.fetcher.type).toBe("actionSubmission");

        await A.actions.foo.resolve("A ACTION");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.type).toBe("actionReload");
        expect(A.fetcher.data).toBe("A ACTION");

        await A.loaders.root.resolve("ROOT DATA");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.type).toBe("actionReload");
        expect(A.fetcher.data).toBe("A ACTION");

        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.type).toBe("done");
        expect(A.fetcher.data).toBe("A ACTION");
        expect(t.router.state.loaderData).toEqual({
          root: "ROOT DATA",
          foo: "A DATA",
        });
      });

      it("action re-fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "key";

        let A = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");

        await A.actions.foo.resolve("A ACTION");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.data).toBe("A ACTION");

        await A.loaders.root.resolve("ROOT DATA");
        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A ACTION");

        let B = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(B.fetcher.state).toBe("submitting");
        expect(B.fetcher.data).toBe("A ACTION");
      });
    });

    describe("fetchers", () => {
      it("gives an idle fetcher before submission", async () => {
        let t = initializeTmTest();
        let fetcher = t.router.getFetcher("randomKey");
        expect(fetcher).toBe(IDLE_FETCHER);
      });

      it("removes fetchers", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo");
        await A.loaders.foo.resolve("A");
        expect(t.router.getFetcher(A.key).data).toBe("A");

        t.router.deleteFetcher(A.key);
        expect(t.router.getFetcher(A.key)).toBe(IDLE_FETCHER);
      });

      it("cleans up abort controllers", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo");
        expect(t.router._internalFetchControllers.size).toBe(1);
        let B = await t.fetch("/bar");
        expect(t.router._internalFetchControllers.size).toBe(2);
        await A.loaders.foo.resolve(null);
        expect(t.router._internalFetchControllers.size).toBe(1);
        await B.loaders.bar.resolve(null);
        expect(t.router._internalFetchControllers.size).toBe(0);
      });

      it("uses current page matches and URL when reloading routes after submissions", async () => {
        let pagePathname = "/foo";
        let t = initializeTmTest({
          url: pagePathname,
          hydrationData: {
            loaderData: { root: "ROOT", foo: "FOO" },
          },
        });

        let A = await t.fetch("/bar", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.bar.resolve("ACTION");
        await A.loaders.root.resolve("ROOT DATA");
        await A.loaders.foo.resolve("FOO DATA");
        expect(t.router.state.loaderData).toEqual({
          root: "ROOT DATA",
          foo: "FOO DATA",
        });
        expect(A.loaders.root.stub).toHaveBeenCalledWith({
          params: {},
          request: new Request("/foo"),
          signal: expect.any(AbortSignal),
        });
      });
    });

    describe("fetcher exception states (4xx Response)", () => {
      it("loader fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo");
        await A.loaders.foo.reject(new Response(null, { status: 400 }));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.exceptions).toEqual({
          root: new Response(null, { status: 400 }),
        });
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        await A.loaders.foo.reject(new Response(null, { status: 400 }));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.exceptions).toEqual({
          root: new Response(null, { status: 400 }),
        });
      });

      it("action fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.reject(new Response(null, { status: 400 }));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.exceptions).toEqual({
          root: new Response(null, { status: 400 }),
        });
      });
    });

    describe("fetcher exception states (Error)", () => {
      it("loader fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo");
        await A.loaders.foo.reject(new Error("Kaboom!"));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.exceptions).toEqual({
          root: new Error("Kaboom!"),
        });
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        await A.loaders.foo.reject(new Error("Kaboom!"));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.exceptions).toEqual({
          root: new Error("Kaboom!"),
        });
      });

      it("action fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.reject(new Error("Kaboom!"));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.exceptions).toEqual({
          root: new Error("Kaboom!"),
        });
      });
    });

    describe("fetcher redirects", () => {
      it("loader fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo");
        let fetcher = A.fetcher;
        await A.loaders.foo.redirect("/bar");
        expect(t.router.getFetcher(A.key)).toBe(fetcher);
        expect(t.router.state.transition.type).toBe("normalRedirect");
        expect(t.router.state.transition.location?.pathname).toBe("/bar");
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        let fetcher = A.fetcher;
        await A.loaders.foo.redirect("/bar");
        expect(t.router.getFetcher(A.key)).toBe(fetcher);
        expect(t.router.state.transition.type).toBe("normalRedirect");
        expect(t.router.state.transition.location?.pathname).toBe("/bar");
      });

      it("action fetch", async () => {
        let t = initializeTmTest({
          url: "/foo",
          hydrationData: { loaderData: { root: "ROOT", foo: "FOO" } },
        });
        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");
        expect(A.fetcher.type).toBe("actionSubmission");
        let AR = await A.actions.foo.redirect("/bar");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.type).toBe("actionRedirect");
        // TODO: ok that fetchActionRedirect is collapsed into submissionRedirect now?
        expect(t.router.state.transition.type).toBe("submissionRedirect");
        expect(t.router.state.transition.location?.pathname).toBe("/bar");
        await AR.loaders.root.resolve("root");
        await AR.loaders.bar.resolve("stuff");
        expect(A.fetcher).toEqual({
          data: undefined,
          state: "idle",
          formMethod: undefined,
          formEncType: undefined,
          formData: undefined,
          type: "done",
        });
      });
    });

    describe("fetcher resubmissions/re-gets", () => {
      it("aborts re-gets", async () => {
        let t = initializeTmTest();
        let key = "KEY";
        let A = await t.fetch("/foo", key);
        let B = await t.fetch("/foo", key);
        await A.loaders.foo.resolve(null);
        let C = await t.fetch("/foo", key);
        await B.loaders.foo.resolve(null);
        await C.loaders.foo.resolve(null);
        expect(A.loaders.foo.signal.aborted).toBe(true);
        expect(B.loaders.foo.signal.aborted).toBe(true);
        expect(C.loaders.foo.signal.aborted).toBe(false);
      });

      it("aborts re-get-submissions", async () => {
        let t = initializeTmTest();
        let key = "KEY";
        let A = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        let B = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        t.fetch("/foo", key);
        expect(A.loaders.foo.signal.aborted).toBe(true);
        expect(B.loaders.foo.signal.aborted).toBe(true);
      });

      it("aborts resubmissions action call", async () => {
        let t = initializeTmTest();
        let key = "KEY";
        let A = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        let B = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.actions.foo.signal.aborted).toBe(true);
        expect(B.actions.foo.signal.aborted).toBe(true);
      });

      it("aborts resubmissions loader call", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "KEY";
        let A = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.resolve("A ACTION");
        t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });

      describe(`
        A) POST |--|--XXX
        B) POST       |----XXX|XXX
        C) POST            |----|---O
      `, () => {
        it("aborts A load, ignores A resolve, aborts B action", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let key = "KEY";

          let A = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A ACTION");
          expect(t.router.getFetcher(key).data).toBe("A ACTION");

          let B = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(t.router.getFetcher(key).data).toBe("A ACTION");

          await A.loaders.root.resolve("A ROOT LOADER");
          await A.loaders.foo.resolve("A LOADER");
          expect(t.router.state.loaderData.foo).toBeUndefined();

          let C = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          expect(B.actions.foo.signal.aborted).toBe(true);

          await B.actions.foo.resolve("B ACTION");
          expect(t.router.getFetcher(key).data).toBe("A ACTION");

          await C.actions.foo.resolve("C ACTION");
          expect(t.router.getFetcher(key).data).toBe("C ACTION");

          await B.loaders.root.resolve("B ROOT LOADER");
          await B.loaders.foo.resolve("B LOADER");
          expect(t.router.state.loaderData.foo).toBeUndefined();

          await C.loaders.root.resolve("C ROOT LOADER");
          await C.loaders.foo.resolve("C LOADER");
          expect(t.router.getFetcher(key).data).toBe("C ACTION");
          expect(t.router.state.loaderData.foo).toBe("C LOADER");
        });
      });

      describe(`
        A) k1 |----|----X
        B) k2   |----|-----O
        C) k1           |-----|---O
      `, () => {
        it("aborts A load, commits B and C loads", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let k1 = "1";
          let k2 = "2";

          let Ak1 = await t.fetch("/foo", k1, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let Bk2 = await t.fetch("/foo", k2, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await Ak1.actions.foo.resolve("A ACTION");
          await Bk2.actions.foo.resolve("B ACTION");
          expect(t.router.getFetcher(k2).data).toBe("B ACTION");

          let Ck1 = await t.fetch("/foo", k1, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          expect(Ak1.loaders.foo.signal.aborted).toBe(true);

          await Ak1.loaders.root.resolve("A ROOT LOADER");
          await Ak1.loaders.foo.resolve("A LOADER");
          expect(t.router.state.loaderData.foo).toBeUndefined();

          await Bk2.loaders.root.resolve("B ROOT LOADER");
          await Bk2.loaders.foo.resolve("B LOADER");
          expect(Ck1.actions.foo.signal.aborted).toBe(false);
          expect(t.router.state.loaderData.foo).toBe("B LOADER");

          await Ck1.actions.foo.resolve("C ACTION");
          await Ck1.loaders.root.resolve("C ROOT LOADER");
          await Ck1.loaders.foo.resolve("C LOADER");

          expect(t.router.getFetcher(k1).data).toBe("C ACTION");
          expect(t.router.state.loaderData.foo).toBe("C LOADER");
        });
      });
    });

    describe("multiple fetcher action reloads", () => {
      describe(`
        A) POST /foo |---[A]------O
        B) POST /foo   |-----[A,B]---O
      `, () => {
        it("commits A, commits B", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A action");
          await B.actions.foo.resolve("B action");

          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A loader");
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A loader",
          });

          await B.loaders.root.resolve("A,B root");
          await B.loaders.foo.resolve("A,B loader");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B root",
            foo: "A,B loader",
          });
        });
      });

      describe(`
        A) POST /foo |----🧤
        B) POST /foo   |--X
      `, () => {
        it("catches A, persists boundary for B", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await A.actions.foo.reject(new Response(null, { status: 400 }));
          expect(t.router.state.exceptions).toEqual({
            root: new Response(null, { status: 400 }),
          });

          await B.actions.foo.resolve("B");
          expect(t.router.state.exceptions).toEqual({
            root: new Response(null, { status: 400 }),
          });
          expect(t.router.state.actionData).toEqual(null);
        });
      });

      describe(`
        A) POST /foo |----[A]-|
        B) POST /foo   |------🧤
      `, () => {
        it("commits A, catches B", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await A.actions.foo.resolve("A action");
          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A loader");
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A loader",
          });

          await B.actions.foo.reject(new Response(null, { status: 400 }));
          expect(t.router.state.exceptions).toEqual({
            root: new Response(null, { status: 400 }),
          });
        });
      });

      describe(`
        A) POST /foo |---[A]-------X
        B) POST /foo   |----[A,B]--O
      `, () => {
        it("aborts A, commits B, sets A done", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A");
          await B.actions.foo.resolve("B");

          await B.loaders.root.resolve("A,B root");
          await B.loaders.foo.resolve("A,B");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B root",
            foo: "A,B",
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(A.fetcher.type).toBe("done");
          expect(A.fetcher.data).toBe("A");
        });
      });

      describe(`
        A) POST /foo |--------[B,A]---O
        B) POST /foo   |--[B]-------O
      `, () => {
        it("commits B, commits A", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await B.actions.foo.resolve("B action");
          await A.actions.foo.resolve("A action");

          await B.loaders.root.resolve("B root");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.loaderData).toEqual({
            root: "B root",
            foo: "B",
          });

          await A.loaders.root.resolve("B,A root");
          await A.loaders.foo.resolve("B,A");
          expect(t.router.state.loaderData).toEqual({
            root: "B,A root",
            foo: "B,A",
          });
        });
      });

      describe(`
        A) POST /foo |------|---O
        B) POST /foo   |--|-----X
      `, () => {
        it("aborts B, commits A, sets B done", async () => {
          let t = initializeTmTest({ url: "/foo" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await B.actions.foo.resolve("B");
          await A.actions.foo.resolve("A");

          await A.loaders.root.resolve("B,A root");
          await A.loaders.foo.resolve("B,A");
          expect(t.router.state.loaderData).toEqual({
            root: "B,A root",
            foo: "B,A",
          });
          expect(B.loaders.foo.signal.aborted).toBe(true);
          expect(B.fetcher.type).toBe("done");
          expect(B.fetcher.data).toBe("B");
        });
      });
    });

    describe("navigating with inflight fetchers", () => {
      describe(`
        A) fetch POST |-------|--O
        B) nav GET      |---O
      `, () => {
        it("does not abort A action or data reload", async () => {
          let t = initializeTmTest({ url: "/foo" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.navigate("/foo");
          expect(A.actions.foo.signal.aborted).toBe(false);
          expect(t.router.state.transition.type).toBe("normalLoad");
          expect(t.router.state.transition.location?.pathname).toBe("/foo");

          await B.loaders.root.resolve("B root");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.transition.type).toBe("idle");
          expect(t.router.state.location.pathname).toBe("/foo");
          expect(t.router.state.loaderData.foo).toBe("B");
          expect(A.loaders.foo.signal).toBe(undefined); // A loaders not called yet

          await A.actions.foo.resolve("A root");
          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A");
          expect(A.loaders.foo.signal.aborted).toBe(false);
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A",
          });
        });
      });

      describe(`
        A) fetch POST |----|-----O
        B) nav GET      |-----O
      `, () => {
        it("Commits A and uses next matches", async () => {
          let t = initializeTmTest({ url: "/" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          // This fetcher's helpers take the current locations loaders (root/index).
          // Since we know we're about to interrupt with /foo let's shim in a
          // loader helper for foo ahead of time
          A.shimLoaderHelper("foo");

          let B = await t.navigate("/foo");
          await A.actions.foo.resolve("A action");
          await B.loaders.root.resolve("B root");
          await B.loaders.foo.resolve("B");
          expect(A.actions.foo.signal.aborted).toBe(false);
          expect(A.loaders.foo.signal.aborted).toBe(false);
          expect(t.router.state.transition.type).toBe("idle");
          expect(t.router.state.location.pathname).toBe("/foo");
          expect(t.router.state.loaderData.foo).toBe("B");

          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A");
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A",
          });
        });
      });

      describe(`
        A) fetch POST |--|----X
        B) nav GET         |--O
      `, () => {
        it("aborts A, sets fetcher done", async () => {
          let t = initializeTmTest({
            url: "/foo",
            hydrationData: { loaderData: { root: "ROOT", foo: "FOO" } },
          });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A");
          let B = await t.navigate("/foo");
          await B.loaders.root.resolve("ROOT*");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.transition.type).toBe("idle");
          expect(t.router.state.location.pathname).toBe("/foo");
          expect(t.router.state.loaderData).toEqual({
            root: "ROOT*",
            foo: "B",
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(A.fetcher.type).toBe("done");
          expect(A.fetcher.data).toBe("A");
        });
      });

      describe(`
        A) fetch POST |--|---O
        B) nav GET         |---O
      `, () => {
        it("commits both", async () => {
          let t = initializeTmTest({ url: "/foo" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A action");
          let B = await t.navigate("/foo");
          await A.loaders.root.resolve("A ROOT");
          await A.loaders.foo.resolve("A");
          expect(t.router.state.loaderData).toEqual({
            root: "A ROOT",
            foo: "A",
          });

          await B.loaders.root.resolve("B ROOT");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.loaderData).toEqual({
            root: "B ROOT",
            foo: "B",
          });
        });
      });

      describe(`
        A) fetch POST |---[A]---O
        B) nav POST           |---[A,B]--O
      `, () => {
        it("keeps both", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A action");
          let B = await t.navigate("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.loaders.root.resolve("A ROOT");
          await A.loaders.foo.resolve("A");
          expect(t.router.state.loaderData).toEqual({
            root: "A ROOT",
            foo: "A",
          });

          await B.actions.foo.resolve("A,B");
          await B.loaders.root.resolve("A,B ROOT");
          await B.loaders.foo.resolve("A,B");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B ROOT",
            foo: "A,B",
          });
        });
      });

      describe(`
        A) fetch POST |---[A]--------X
        B) nav POST     |-----[A,B]--O
      `, () => {
        it("aborts A, commits B, marks fetcher done", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.navigate("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A");
          await B.actions.foo.resolve("A,B");
          await B.loaders.root.resolve("A,B ROOT");
          await B.loaders.foo.resolve("A,B");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B ROOT",
            foo: "A,B",
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(A.fetcher.type).toBe("done");
          expect(A.fetcher.data).toBe("A");
        });
      });

      describe(`
        A) fetch POST |-----------[B,A]--O
        B) nav POST     |--[B]--O
      `, () => {
        it("commits both, uses the nav's href", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          A.shimLoaderHelper("bar");
          let B = await t.navigate("/bar", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await B.actions.bar.resolve("B");
          await B.loaders.root.resolve("B");
          await B.loaders.bar.resolve("B");
          await A.actions.foo.resolve("B,A");
          await A.loaders.root.resolve("B,A ROOT");
          await A.loaders.bar.resolve("B,A");
          expect(t.router.state.loaderData).toEqual({
            root: "B,A ROOT",
            bar: "B,A",
          });
        });
      });

      describe(`
        A) fetch POST |-------[B,A]--O
        B) nav POST     |--[B]-------X
      `, () => {
        it("aborts B, commits A, uses the nav's href", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          A.shimLoaderHelper("bar");
          let B = await t.navigate("/bar", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await B.actions.bar.resolve("B");
          await A.actions.foo.resolve("B,A");
          await A.loaders.root.resolve("B,A ROOT");
          await A.loaders.bar.resolve("B,A");
          expect(B.loaders.bar.signal.aborted).toBe(true);
          expect(t.router.state.loaderData).toEqual({
            root: "B,A ROOT",
            bar: "B,A",
          });
          expect(t.router.state.transition).toBe(IDLE_TRANSITION);
        });
      });
    });
  });
});
