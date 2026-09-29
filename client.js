window.__ModuleLoader__.load({
	id: "dsh-9router-go",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * Dashboard address of the managed sidecar. The browser boot row carries no
		 * plugin configuration, so this is the one place the client half knows the
		 * gateway port; keep it equal to `port` in `cordis.patch.yml`.
		 */
		const DASHBOARD_URL = "http://127.0.0.1:20130/";
		const COMMAND_NAME = "9router-go";
		const inject = ["commandUi", "sidebarRight"];
		function apply(ctx) {
			ctx.effect(() => ctx.commandUi.register({
				name: COMMAND_NAME,
				description: () => "Open the 9Router dashboard in the sidebar Browser",
				available: () => ctx.get("sidebarRightTabs")?.get("browser") !== undefined,
				ui: {
					kind: "action",
					run: () => {
						ctx.sidebarRight.openTab("browser", { params: { url: DASHBOARD_URL } });
					}
				}
			}), "dsh-9router-go: dashboard command");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
