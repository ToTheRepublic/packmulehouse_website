    const loginCard = document.getElementById("login-card");
    const dash = document.getElementById("dash");
    const loginStatus = document.getElementById("login-status");
    const dashStatus = document.getElementById("dash-status");

    function token() {
      return sessionStorage.getItem("pmh_admin_token") || "";
    }

    function setToken(t) {
      if (t) sessionStorage.setItem("pmh_admin_token", t);
      else sessionStorage.removeItem("pmh_admin_token");
    }

    function setMsg(el, msg, ok) {
      el.textContent = msg || "";
      el.className = "status " + (ok ? "ok" : msg ? "err" : "");
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token() ? `Bearer ${token()}` : "",
        },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    function renderState(s) {
      const badge = document.getElementById("mto-badge");
      const on = !!s.enabled && Number(s.remaining) > 0;
      badge.textContent = on ? "Open" : "Standby";
      badge.className = "badge " + (on ? "on" : "off");
      document.getElementById("mto-remaining").textContent = String(s.remaining);
      document.getElementById("mto-max").textContent = String(s.max);
      document.getElementById("mto-promise").textContent = s.promise || "—";
      document.getElementById("set-remaining").value = String(s.remaining);
    }

    async function refresh() {
      const data = await api("/api/admin/status", {});
      renderState(data);
    }

    document.getElementById("login-btn").addEventListener("click", async () => {
      setMsg(loginStatus, "Signing in…", true);
      try {
        const pw = document.getElementById("password").value;
        const data = await api("/api/admin/login", { password: pw });
        setToken(data.token);
        loginCard.classList.add("hidden");
        dash.classList.remove("hidden");
        setMsg(loginStatus, "");
        await refresh();
      } catch (e) {
        setMsg(loginStatus, e.message, false);
      }
    });

    document.getElementById("password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("login-btn").click();
    });

    document.getElementById("btn-save").addEventListener("click", async () => {
      try {
        const remaining = Number(document.getElementById("set-remaining").value);
        const data = await api("/api/admin/mto", { action: "set", remaining });
        renderState(data);
        setMsg(dashStatus, "Saved.", true);
      } catch (e) {
        setMsg(dashStatus, e.message, false);
      }
    });

    document.getElementById("btn-reset").addEventListener("click", async () => {
      try {
        const data = await api("/api/admin/mto", { action: "reset" });
        renderState(data);
        setMsg(dashStatus, "Reset to max and enabled.", true);
      } catch (e) {
        setMsg(dashStatus, e.message, false);
      }
    });

    document.getElementById("btn-enable").addEventListener("click", async () => {
      try {
        const data = await api("/api/admin/mto", { action: "enable" });
        renderState(data);
        setMsg(dashStatus, "MTO enabled.", true);
      } catch (e) {
        setMsg(dashStatus, e.message, false);
      }
    });

    document.getElementById("btn-disable").addEventListener("click", async () => {
      try {
        const data = await api("/api/admin/mto", { action: "disable" });
        renderState(data);
        setMsg(dashStatus, "MTO on standby.", true);
      } catch (e) {
        setMsg(dashStatus, e.message, false);
      }
    });

    document.getElementById("btn-logout").addEventListener("click", () => {
      setToken("");
      dash.classList.add("hidden");
      loginCard.classList.remove("hidden");
      document.getElementById("password").value = "";
    });

    // Auto-resume session
    (async () => {
      if (!token()) return;
      try {
        await refresh();
        loginCard.classList.add("hidden");
        dash.classList.remove("hidden");
      } catch {
        setToken("");
      }
    })();
  