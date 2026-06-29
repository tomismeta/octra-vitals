(function(){
  const $ = (id) => document.getElementById(id);
  const statusGrid = $("status-grid");
  const result = $("result-table");
  const message = $("message");
  const sqlInput = $("sql-input");
  const limitInput = $("limit-input");
  const queryDescription = $("query-description");
  const windowValue = $("window-value");
  const windowUnit = $("window-unit");
  const databaseLink = $("database-link");
  const runBtn = $("run-btn");
  const editor = sqlInput ? sqlInput.closest(".lab-editor") : null;
  const highlightLayer = editor ? editor.querySelector(".lab-sql-hl") : null;
  const highlightCode = highlightLayer ? highlightLayer.querySelector("code") : null;
  const cannedButtons = Array.from(document.querySelectorAll("[data-canned-query]"));
  const relationNodes = Array.from(document.querySelectorAll("[data-table]"));
  let activeQuery = "history";

  const cannedQueries = {
    history: {
      description: "Recent mirrored AML snapshots and accounting fields.",
      sql: historySql
    },
    tables: {
      description: "List tables and indexes in the Circle-backed query mirror.",
      sql: () => `select
  type,
  name,
  tbl_name
from sqlite_schema
where name not like 'sqlite_%'
  and type in ('table', 'index')
order by
  case type when 'table' then 0 else 1 end,
  tbl_name,
  name`
    },
    schema: {
      description: "Inspect table and index definitions from the mirror schema.",
      sql: () => `select
  type,
  name,
  tbl_name,
  sql
from sqlite_schema
where name not like 'sqlite_%'
order by type, name`
    }
  };

  function setMessage(text, error=false){
    message.textContent = text || "";
    message.classList.toggle("error", error);
  }

  function valueText(value){
    if(value === null || value === undefined) return "";
    if(typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function indexText(value, fallback="none"){
    if(value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? `#${Math.trunc(number)}` : fallback;
  }

  function windowConfig(){
    const parsed = Math.trunc(Number(windowValue?.value || 1));
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3650) : 1;
    const unit = windowUnit?.value === "hour" ? "hour" : "day";
    if(windowValue) windowValue.value = String(value);
    return { value, unit };
  }

  function historySql(){
    const { value, unit } = windowConfig();
    return `with params(window_value, window_unit) as (values (${value}, '${unit}')),
window_seconds(seconds) as (
  select case window_unit
    when 'hour' then window_value * 60 * 60
    else window_value * 24 * 60 * 60
  end
  from params
)
select
  s.snapshot_index,
  s.snapshot_id,
  c.issued_raw,
  c.burned_raw,
  c.encrypted_raw,
  c.total_locked_raw,
  c.total_wrapped_raw,
  c.total_unclaimed_raw,
  d.raw_value as unclassified_raw
from snapshots s
join core_accounting_facts c using(snapshot_index)
left join derived_snapshot_metrics d
  on d.snapshot_index = s.snapshot_index
 and d.metric_key = 'unclassified_raw'
where s.observed_at_unix >= (
  select max(s2.observed_at_unix) - window_seconds.seconds
  from snapshots s2, window_seconds
)
order by s.snapshot_index desc`;
  }

  const SQL_KEYWORDS = new Set([
    "select","with","as","from","join","left","right","inner","outer","full",
    "cross","on","using","where","group","order","by","having","limit","offset",
    "and","or","not","in","is","null","case","when","then","else","end","union",
    "all","asc","desc","values","distinct","between","like","exists","into",
    "natural"
  ]);

  const SQL_TOKEN_RE = /(\/\*[\s\S]*?(?:\*\/|$))|(--[^\n]*)|('(?:[^']|'')*'?)|(\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|([ \t\r\n]+)|([^\s])/g;

  function tokenizeSql(src){
    const tokens = [];
    let match;
    SQL_TOKEN_RE.lastIndex = 0;
    while((match = SQL_TOKEN_RE.exec(src)) !== null){
      const text = match[0];
      if(text === ""){ SQL_TOKEN_RE.lastIndex++; continue; } // never spin
      let cls;
      if(match[1] || match[2]) cls = "tok-com";
      else if(match[3]) cls = "tok-str";
      else if(match[4]) cls = "tok-num";
      else if(match[5]) cls = SQL_KEYWORDS.has(text.toLowerCase()) ? "tok-kw" : "tok-id";
      else if(match[6]) cls = null;
      else cls = "tok-op";
      tokens.push({ text, cls });
    }
    return tokens;
  }

  function renderHighlight(){
    if(!highlightCode || !sqlInput) return;
    const src = sqlInput.value.endsWith("\n") ? `${sqlInput.value}\u200b` : sqlInput.value;
    highlightCode.textContent = "";
    try {
      const frag = document.createDocumentFragment();
      tokenizeSql(src).forEach(({ text, cls })=>{
        if(cls){
          const span = document.createElement("span");
          span.className = cls;
          span.textContent = text;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(text));
        }
      });
      highlightCode.appendChild(frag);
    } catch (_err) {
      highlightCode.textContent = src;
    }
    syncHighlightScroll();
  }

  function syncHighlightScroll(){
    if(!highlightCode || !sqlInput) return;
    highlightCode.style.transform = `translate(${-sqlInput.scrollLeft}px, ${-sqlInput.scrollTop}px)`;
  }

  function setSql(value){
    if(!sqlInput) return;
    sqlInput.value = value;
    renderHighlight();
  }

  if(sqlInput){
    sqlInput.addEventListener("input", renderHighlight);
    sqlInput.addEventListener("scroll", syncHighlightScroll, { passive:true });
  }

  function renderTable(target, payload){
    const rows = payload?.rows || payload?.result?.rows || [];
    const columns = payload?.columns || payload?.result?.columns || Object.keys(rows[0] || {});
    target.textContent = "";
    if(!rows.length){
      target.appendChild(Object.assign(document.createElement("div"), {className:"lab-message", textContent:"No rows."}));
      return;
    }
    const table = document.createElement("table");
    table.className = "lab-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    columns.forEach((column)=>{
      const th = document.createElement("th");
      th.textContent = column;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    rows.forEach((row)=>{
      const tr = document.createElement("tr");
      columns.forEach((column, index)=>{
        const td = document.createElement("td");
        td.textContent = Array.isArray(row) ? valueText(row[index]) : valueText(row[column]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    target.appendChild(table);
  }

  async function getJson(path){
    const res = await fetch(path, {headers:{"Accept":"application/json"}});
    const body = await res.json().catch(()=>({error:"invalid_json"}));
    if(!res.ok) throw new Error(body.error || `${path} returned ${res.status}`);
    return body;
  }

  async function postJson(path, body={}){
    const headers = {"Content-Type":"application/json", "Accept":"application/json"};
    const res = await fetch(path, {
      method:"POST",
      headers,
      body:JSON.stringify(body)
    });
    const payload = await res.json().catch(()=>({error:"invalid_json"}));
    if(!res.ok) throw new Error(payload.error || `${path} returned ${res.status}`);
    return payload;
  }

  function renderStatus(payload){
    const authority = payload.authority || {};
    const rows = payload.database?.rows || [];
    const watermark = rows.find((row)=>row.section === "watermark") || {};
    const latestRun = rows.find((row)=>row.section === "run") || {};
    const mode = authority.lab_database_enabled
      ? "enabled"
      : authority.lab_database_reason || "disabled";
    const stats = [
      ["Mode", mode],
      ["Network", authority.lab_database_network || "unknown"],
      ["Mirrored", indexText(latestRun.mirrored_latest_index, "none")],
      ["Complete", indexText(watermark.complete_through_index, "not complete")]
    ];
    statusGrid.textContent = "";
    stats.forEach(([key, value])=>{
      const div = document.createElement("div");
      div.className = "lab-stat";
      const k = document.createElement("div");
      k.className = "k";
      k.textContent = key;
      const v = document.createElement("div");
      v.className = "v";
      v.textContent = value;
      div.appendChild(k);
      div.appendChild(v);
      statusGrid.appendChild(div);
    });
  }

  async function refreshStatus(){
    const payload = await getJson("/api/lab/status");
    renderStatus(payload);
    renderDatabaseLink(payload.authority || {});
  }

  function explorerUrlForDatabase(uri){
    const match = String(uri || "").match(/^oct:\/\/([^/]+)\/([^/?#]+)/);
    if(!match) return null;
    const network = match[1];
    const id = match[2];
    const host = network === "devnet" ? "https://devnet.octrascan.io" : "https://octrascan.io";
    return `${host}/address.html?addr=${encodeURIComponent(id)}`;
  }

  function renderDatabaseLink(authority){
    if(!databaseLink) return;
    const uri = authority.lab_database_uri || authority.lab_database;
    const href = explorerUrlForDatabase(uri);
    databaseLink.textContent = "";
    if(!href || !uri) return;
    const icon = document.createElement("span");
    icon.className = "db-ico";
    icon.setAttribute("aria-hidden", "true");
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.title = uri;
    anchor.textContent = "Octra Vitals Mirror SQLite Database";
    databaseLink.appendChild(icon);
    databaseLink.appendChild(anchor);
  }

  async function runQuery(sql, limit){
    setMessage("Running...");
    const payload = await postJson("/api/lab/query", {sql, limit});
    renderTable(result, payload.result);
    setMessage(`${payload.result.row_count} row${payload.result.row_count === 1 ? "" : "s"}.`);
  }

  async function withButton(button, fn){
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      setMessage(error?.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  function setActiveQuery(name, run=false){
    const query = cannedQueries[name] || cannedQueries.history;
    activeQuery = cannedQueries[name] ? name : "history";
    cannedButtons.forEach((button)=>{
      const pressed = button.getAttribute("data-canned-query") === activeQuery;
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
      button.classList.toggle("primary", pressed);
    });
    if(queryDescription) queryDescription.textContent = query.description;
    setSql(query.sql());
    if(run) return runQuery(sqlInput.value, limitInput.value);
    return Promise.resolve();
  }

  cannedButtons.forEach((button)=>{
    const name = button.getAttribute("data-canned-query") || "history";
    button.addEventListener("click", ()=>withButton(button, async ()=>{
      await setActiveQuery(name, true);
    }));
    button.addEventListener("mouseenter", ()=>{
      if(queryDescription) queryDescription.textContent = cannedQueries[name]?.description || "";
    });
    button.addEventListener("focus", ()=>{
      if(queryDescription) queryDescription.textContent = cannedQueries[name]?.description || "";
    });
    button.addEventListener("mouseleave", ()=>{
      if(queryDescription) queryDescription.textContent = cannedQueries[activeQuery]?.description || "";
    });
    button.addEventListener("blur", ()=>{
      if(queryDescription) queryDescription.textContent = cannedQueries[activeQuery]?.description || "";
    });
  });

  [windowValue, windowUnit].forEach((control)=>{
    control?.addEventListener("change", ()=>{
      if(activeQuery === "history") setSql(historySql());
    });
    control?.addEventListener("input", ()=>{
      if(activeQuery === "history") setSql(historySql());
    });
  });

  function setRelationFocus(table){
    relationNodes.forEach((node)=>{
      const own = node.getAttribute("data-table") || "";
      const related = (node.getAttribute("data-related") || "").split(/\s+/).filter(Boolean);
      const activeNode = own === table;
      const relatedNode = related.includes(table);
      const sourceRelated = relationNodes.find((candidate)=>candidate.getAttribute("data-table") === table)
        ?.getAttribute("data-related")?.split(/\s+/).filter(Boolean).includes(own);
      node.classList.toggle("is-active", activeNode);
      node.classList.toggle("is-related", relatedNode || Boolean(sourceRelated));
      node.classList.toggle("is-muted", Boolean(table) && !activeNode && !relatedNode && !sourceRelated);
    });
  }

  relationNodes.forEach((node)=>{
    const table = node.getAttribute("data-table") || "";
    node.addEventListener("mouseenter", ()=>setRelationFocus(table));
    node.addEventListener("focus", ()=>setRelationFocus(table));
    node.addEventListener("mouseleave", ()=>setRelationFocus(""));
    node.addEventListener("blur", ()=>setRelationFocus(""));
  });

  runBtn.addEventListener("click", ()=>withButton(runBtn, async ()=>{
    await runQuery(sqlInput.value, limitInput.value);
  }));

  renderHighlight();

  refreshStatus()
    .then(()=>setActiveQuery("history", true))
    .catch((error)=>setMessage(error?.message || String(error), true));
})();
