/* DigitalWork Escrow — frontend (ethers v6 + MetaMask) */
(() => {
  const { ethers } = window;
  const CFG = window.APP_CONFIG;
  const ABI = window.ESCROW_ABI;
  const NET = CFG.NETWORKS[CFG.CHAIN_ID] || { name: `Chain ${CFG.CHAIN_ID}`, rpc: "", explorer: "", symbol: "ETH" };

  const STATUS = [
    "รอฝากเงิน",        // 0 Created
    "ฝากเงินแล้ว",       // 1 Funded
    "ส่งงานแล้ว รอตรวจ", // 2 Submitted
    "จ่ายเงินแล้ว",       // 3 Paid
    "ข้อพิพาท",          // 4 Disputed
    "ตัดสินแล้ว",         // 5 Resolved
    "คืนเงินแล้ว",        // 6 Refunded
    "ยกเลิก",            // 7 Cancelled
  ];
  const EVENT_TH = {
    JobCreated: "สร้างข้อตกลง",
    PaymentDeposited: "ฝากเงินเข้า Escrow",
    WorkSubmitted: "ส่งมอบงาน",
    PaymentReleased: "อนุมัติและจ่ายเงิน",
    DisputeRaised: "แจ้งข้อพิพาท",
    DisputeResolved: "ตัดสินข้อพิพาท",
    Refunded: "คืนเงินผู้ว่าจ้าง",
    JobCancelled: "ยกเลิกข้อตกลง",
    ArbiterUpdated: "ปรับสิทธิ์ผู้ดูแล",
  };

  const state = {
    readProvider: null,
    browserProvider: null,
    signer: null,
    account: null,
    contract: null, // read
    writeContract: null,
    isArbiter: false,
    isOwner: false,
    jobs: [],
    events: [],
    role: "all",
  };

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");
  const eth = (wei) => `${Number(ethers.formatEther(wei)).toLocaleString("th-TH", { maximumFractionDigits: 6 })} ETH`;
  const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const txLink = (h) => (NET.explorer ? `<a class="mono" href="${NET.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>` : `<span class="mono" title="${h}">${short(h)}</span>`);
  const addrLink = (a) => (NET.explorer ? `<a class="mono" href="${NET.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>` : `<span class="mono" title="${a}">${short(a)}</span>`);
  const evidenceHtml = (e) => (/^https?:\/\//i.test(e) ? `<a href="${esc(e)}" target="_blank" rel="noopener noreferrer">${esc(e)}</a>` : `<span class="mono">${esc(e)}</span>`);
  const isZeroAddr = CFG.CONTRACT_ADDRESS === ethers.ZeroAddress;

  function toast(html, type = "", ms = 6000) {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.innerHTML = html;
    $("#toasts").appendChild(t);
    if (ms) setTimeout(() => t.remove(), ms);
    return t;
  }

  function notice(html) {
    const n = $("#notice");
    if (!html) return n.classList.add("hidden");
    n.innerHTML = html;
    n.classList.remove("hidden");
  }

  function errMsg(e) {
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "ผู้ใช้ยกเลิกธุรกรรมใน MetaMask";
    return e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  }

  // ส่งธุรกรรม + แสดงสถานะ + tx hash
  async function sendTx(label, fn) {
    if (!state.writeContract) throw new Error("กรุณาเชื่อมต่อ MetaMask ก่อน");
    const pending = toast(`⏳ ${label}: รอยืนยันใน MetaMask…`, "", 0);
    try {
      const tx = await fn(state.writeContract);
      pending.innerHTML = `⛏️ ${label}: ส่งธุรกรรมแล้ว รอ confirm…<br>Tx: ${txLink(tx.hash)}`;
      const receipt = await tx.wait();
      pending.remove();
      toast(`✅ ${label} สำเร็จ<br>Tx: ${txLink(tx.hash)}`, "ok", 9000);
      await refreshAll();
      return receipt;
    } catch (e) {
      pending.remove();
      toast(`❌ ${label} ไม่สำเร็จ: ${esc(errMsg(e))}`, "err", 10000);
      throw e;
    }
  }

  // ---------- wallet ----------
  async function connect() {
    if (!window.ethereum) {
      toast('ไม่พบ MetaMask — ติดตั้งได้ที่ <a href="https://metamask.io/download/" target="_blank">metamask.io</a>', "err", 10000);
      return;
    }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await ensureNetwork();
      await setupWallet();
    } catch (e) {
      toast(`เชื่อมต่อไม่สำเร็จ: ${esc(errMsg(e))}`, "err");
    }
  }

  async function ensureNetwork() {
    const hex = "0x" + CFG.CHAIN_ID.toString(16);
    const current = await window.ethereum.request({ method: "eth_chainId" });
    if (parseInt(current, 16) === CFG.CHAIN_ID) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code === 4902 && NET.rpc) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex, chainName: NET.name, rpcUrls: [NET.rpc], nativeCurrency: { name: NET.symbol, symbol: NET.symbol, decimals: 18 }, blockExplorerUrls: NET.explorer ? [NET.explorer] : [] }],
        });
      } else throw e;
    }
  }

  async function setupWallet() {
    state.browserProvider = new ethers.BrowserProvider(window.ethereum);
    const net = await state.browserProvider.getNetwork();
    const accounts = await state.browserProvider.send("eth_accounts", []);
    if (!accounts.length) return disconnectUI();

    const okChain = Number(net.chainId) === CFG.CHAIN_ID;
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.writeContract = okChain && !isZeroAddr ? new ethers.Contract(CFG.CONTRACT_ADDRESS, ABI, state.signer) : null;
    if (okChain) state.readProvider = state.browserProvider;

    $("#connectBtn").textContent = `🦊 ${short(state.account)}`;
    const badge = $("#networkBadge");
    badge.textContent = okChain ? NET.name : `ผิดเครือข่าย (ต้องเป็น ${NET.name})`;
    badge.className = `badge ${okChain ? "ok" : "bad"}`;
    if (!okChain) notice(`MetaMask อยู่บนเครือข่ายอื่น <button class="btn" id="switchBtn">สลับไป ${esc(NET.name)}</button>`);
    else if (!isZeroAddr) notice("");
    $("#switchBtn")?.addEventListener("click", () => ensureNetwork().catch((e) => toast(esc(errMsg(e)), "err")));

    await refreshAll();
  }

  function disconnectUI() {
    state.signer = state.account = state.writeContract = null;
    state.isArbiter = state.isOwner = false;
    $("#connectBtn").textContent = "🦊 เชื่อมต่อ MetaMask";
    $("#networkBadge").textContent = "ยังไม่เชื่อมต่อ";
    $("#networkBadge").className = "badge muted";
    refreshAll();
  }

  // ---------- data ----------
  function readContract() {
    if (!state.readProvider) state.readProvider = new ethers.JsonRpcProvider(NET.rpc, CFG.CHAIN_ID, { staticNetwork: true });
    return new ethers.Contract(CFG.CONTRACT_ADDRESS, ABI, state.readProvider);
  }

  function toJob(r) {
    return {
      id: Number(r.id), client: r.client, freelancer: r.freelancer, title: r.title, description: r.description,
      amount: r.amount, deadline: Number(r.deadline), escrowBalance: r.escrowBalance, workEvidence: r.workEvidence,
      disputeReason: r.disputeReason, disputeRaisedBy: r.disputeRaisedBy, status: Number(r.status),
      createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
    };
  }

  async function loadJobs(c) {
    const count = Number(await c.jobCount());
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = await Promise.all(ids.slice(i, i + 20).map((id) => c.getJob(id)));
      out.push(...chunk.map(toJob));
    }
    return out.reverse(); // ใหม่สุดก่อน
  }

  async function loadEvents(c) {
    const provider = c.runner.provider || c.runner;
    const latest = await provider.getBlockNumber();
    const from = CFG.DEPLOY_BLOCK || Math.max(0, latest - 50000);
    const logs = [];
    let step = latest - from + 1;
    for (let start = from; start <= latest; ) {
      const end = Math.min(latest, start + step - 1);
      try {
        logs.push(...(await c.queryFilter("*", start, end)));
        start = end + 1;
      } catch (e) {
        if (step <= 500) throw e;
        step = Math.floor(step / 4); // RPC จำกัดช่วง block → แบ่งย่อย
      }
    }
    const blockTimes = {};
    const uniq = [...new Set(logs.map((l) => l.blockNumber))];
    await Promise.all(uniq.map(async (b) => { blockTimes[b] = (await provider.getBlock(b))?.timestamp; }));
    return logs
      .filter((l) => l.fragment)
      .map((l) => ({ name: l.fragment.name, args: l.args, hash: l.transactionHash, block: l.blockNumber, time: blockTimes[l.blockNumber] }))
      .reverse();
  }

  async function refreshAll() {
    if (isZeroAddr) {
      notice("ยังไม่ได้ตั้งค่า <b>CONTRACT_ADDRESS</b> ใน <code>docs/config.js</code> — deploy contract แล้วใส่ address ก่อนใช้งาน");
      return;
    }
    $("#statContract").textContent = short(CFG.CONTRACT_ADDRESS);
    if (NET.explorer) $("#statContract").href = `${NET.explorer}/address/${CFG.CONTRACT_ADDRESS}`;
    try {
      const c = readContract();
      state.contract = c;
      const [jobs, escrowed] = await Promise.all([loadJobs(c), c.totalEscrowed()]);
      state.jobs = jobs;
      $("#statJobs").textContent = jobs.length.toLocaleString("th-TH");
      $("#statEscrow").textContent = eth(escrowed);

      if (state.account) {
        const [bal, arb, owner] = await Promise.all([state.readProvider.getBalance(state.account), c.isArbiter(state.account), c.owner()]);
        $("#statBalance").textContent = eth(bal);
        state.isArbiter = arb;
        state.isOwner = same(owner, state.account);
      } else {
        $("#statBalance").textContent = "–";
      }
      $("#adminTab").classList.toggle("hidden", !state.isArbiter);
      $("#arbiterForm").classList.toggle("hidden", !state.isOwner);
      renderJobs();

      state.events = await loadEvents(c);
      renderHistory();
    } catch (e) {
      console.error(e);
      notice(`โหลดข้อมูลจาก contract ไม่สำเร็จ: ${esc(errMsg(e))}<br>ตรวจสอบ CONTRACT_ADDRESS / เครือข่ายใน config.js`);
    }
  }

  // ---------- render ----------
  function roleOf(j) {
    const r = [];
    if (same(j.client, state.account)) r.push("ผู้ว่าจ้าง");
    if (same(j.freelancer, state.account)) r.push("ฟรีแลนซ์");
    return r;
  }

  function actionsFor(j) {
    const me = state.account;
    if (!me || !state.writeContract) return "";
    const isC = same(j.client, me), isF = same(j.freelancer, me);
    const now = Date.now() / 1000;
    const b = [];
    if (isC && j.status === 0) b.push(["deposit", "💰 ฝากเงิน", "primary"], ["cancel", "ยกเลิก", "danger"]);
    if (isF && (j.status === 1 || j.status === 2)) b.push(["submit", j.status === 2 ? "📤 ส่งงานใหม่" : "📤 ส่งมอบงาน", "primary"]);
    if (isC && j.status === 2) b.push(["approve", "✅ อนุมัติและจ่ายเงิน", "primary"]);
    if (isC && j.status === 1 && now > j.deadline) b.push(["refund", "↩️ ขอคืนเงิน (เลยกำหนด)", "warn"]);
    if ((isC || isF) && (j.status === 1 || j.status === 2)) b.push(["dispute", "⚠️ แจ้งข้อพิพาท", "warn"]);
    if (state.isArbiter && j.status === 4 && !isC && !isF) b.push(["resolve", "⚖️ ตัดสิน", "primary"]);
    return b.map(([a, t, cls]) => `<button class="btn ${cls}" data-act="${a}" data-id="${j.id}">${t}</button>`).join("");
  }

  function jobCard(j) {
    const roles = roleOf(j).map((r) => `<span class="role">${r}</span>`).join("");
    const late = j.status === 1 && Date.now() / 1000 > j.deadline ? ' <span style="color:var(--danger)">(เลยกำหนด)</span>' : "";
    return `
      <article class="job">
        <div class="job-top">
          <div><div class="id">งาน #${j.id}${roles}</div><h3>${esc(j.title)}</h3></div>
          <span class="status s${j.status}">${STATUS[j.status]}</span>
        </div>
        <div class="amount">${eth(j.amount)}</div>
        <dl>
          <dt>ผู้ว่าจ้าง</dt><dd>${addrLink(j.client)}</dd>
          <dt>ฟรีแลนซ์</dt><dd>${addrLink(j.freelancer)}</dd>
          <dt>กำหนดส่ง</dt><dd>${fmtDate(j.deadline)}${late}</dd>
          <dt>ใน Escrow</dt><dd>${eth(j.escrowBalance)}</dd>
          ${j.workEvidence ? `<dt>ผลงาน</dt><dd>${evidenceHtml(j.workEvidence)}</dd>` : ""}
        </dl>
        <div class="actions">
          <button class="btn ghost" data-act="detail" data-id="${j.id}">รายละเอียด / ประวัติ</button>
          ${actionsFor(j)}
        </div>
      </article>`;
  }

  function renderGrid(el, jobs, emptyText) {
    el.innerHTML = jobs.length ? jobs.map(jobCard).join("") : `<div class="empty">${emptyText}</div>`;
  }

  function renderJobs() {
    const me = state.account;
    let mine = me ? state.jobs.filter((j) => same(j.client, me) || same(j.freelancer, me)) : [];
    if (state.role === "client") mine = mine.filter((j) => same(j.client, me));
    if (state.role === "freelancer") mine = mine.filter((j) => same(j.freelancer, me));
    renderGrid($("#myJobs"), mine, me ? "ยังไม่มีงานที่เกี่ยวข้องกับกระเป๋านี้ — ลองสร้างข้อตกลงใหม่" : "เชื่อมต่อ MetaMask เพื่อดูงานของคุณ");

    const q = Number($("#searchId").value);
    renderGrid($("#allJobs"), q ? state.jobs.filter((j) => j.id === q) : state.jobs, "ไม่พบงาน");

    renderGrid($("#disputeJobs"), state.jobs.filter((j) => j.status === 4), "ไม่มีข้อพิพาทที่รอพิจารณา");
  }

  function eventDetail(e) {
    const a = e.args;
    switch (e.name) {
      case "JobCreated": return `${esc(a.title)} · ${eth(a.amount)} · ผู้ว่าจ้าง ${addrLink(a.client)} → ฟรีแลนซ์ ${addrLink(a.freelancer)}`;
      case "PaymentDeposited": return `${eth(a.amount)} จาก ${addrLink(a.client)}`;
      case "WorkSubmitted": return `หลักฐาน: ${evidenceHtml(a.evidence)}`;
      case "PaymentReleased": return `${eth(a.amount)} → ${addrLink(a.freelancer)}`;
      case "DisputeRaised": return `โดย ${addrLink(a.raisedBy)}: ${esc(a.reason)}`;
      case "DisputeResolved": return `ฟรีแลนซ์ ${eth(a.toFreelancer)} · คืนผู้ว่าจ้าง ${eth(a.toClient)} · โดย ${addrLink(a.arbiter)}`;
      case "Refunded": return `${eth(a.amount)} → ${addrLink(a.client)}`;
      case "JobCancelled": return `โดย ${addrLink(a.client)}`;
      case "ArbiterUpdated": return `${addrLink(a.arbiter)} ${a.enabled ? "ได้รับสิทธิ์" : "ถูกถอนสิทธิ์"}`;
      default: return "";
    }
  }

  function eventInvolvesMe(e) {
    const me = state.account;
    if (!me) return false;
    if (e.args.jobId !== undefined) {
      const j = state.jobs.find((x) => x.id === Number(e.args.jobId));
      return j && (same(j.client, me) || same(j.freelancer, me));
    }
    return Object.values(e.args.toObject ? e.args.toObject() : {}).some((v) => typeof v === "string" && same(v, me));
  }

  function renderHistory() {
    const onlyMine = $("#onlyMine").checked && state.account;
    const rows = state.events.filter((e) => !onlyMine || eventInvolvesMe(e));
    $("#historyBody").innerHTML = rows.length
      ? rows.map((e) => `<tr>
          <td>${e.time ? fmtDate(e.time) : "–"}<br><span class="mono" style="color:var(--muted)">#${e.block}</span></td>
          <td><b>${EVENT_TH[e.name] || e.name}</b></td>
          <td>${e.args.jobId !== undefined ? `#${e.args.jobId}` : "–"}</td>
          <td>${eventDetail(e)}</td>
          <td>${txLink(e.hash)}</td></tr>`).join("")
      : `<tr><td colspan="5" class="empty" style="border:0">ยังไม่มีธุรกรรม</td></tr>`;
  }

  // ---------- modal ----------
  const modal = $("#modal");
  function openModal(html) {
    $("#modalBody").innerHTML = `<button class="close" data-close>×</button>${html}`;
    modal.showModal();
  }
  modal.addEventListener("click", (e) => { if (e.target === modal || e.target.hasAttribute("data-close")) modal.close(); });

  function showDetail(id) {
    const j = state.jobs.find((x) => x.id === id);
    const evs = state.events.filter((e) => e.args.jobId !== undefined && Number(e.args.jobId) === id).slice().reverse();
    openModal(`
      <div><div class="id" style="color:var(--muted)">งาน #${j.id}</div><h2>${esc(j.title)}</h2></div>
      <div><span class="status s${j.status}">${STATUS[j.status]}</span></div>
      <div class="desc">${esc(j.description) || "<i>ไม่มีรายละเอียด</i>"}</div>
      <div class="job" style="border:0;padding:0"><dl>
        <dt>ค่าจ้าง</dt><dd>${eth(j.amount)}</dd>
        <dt>เงินใน Escrow</dt><dd>${eth(j.escrowBalance)}</dd>
        <dt>ผู้ว่าจ้าง</dt><dd>${addrLink(j.client)}</dd>
        <dt>ฟรีแลนซ์</dt><dd>${addrLink(j.freelancer)}</dd>
        <dt>สร้างเมื่อ</dt><dd>${fmtDate(j.createdAt)}</dd>
        <dt>กำหนดส่ง</dt><dd>${fmtDate(j.deadline)}</dd>
        <dt>อัปเดตล่าสุด</dt><dd>${fmtDate(j.updatedAt)}</dd>
        ${j.workEvidence ? `<dt>ผลงาน</dt><dd style="white-space:normal">${evidenceHtml(j.workEvidence)}</dd>` : ""}
        ${j.disputeReason ? `<dt>ข้อพิพาท</dt><dd style="white-space:normal">${esc(j.disputeReason)} (โดย ${addrLink(j.disputeRaisedBy)})</dd>` : ""}
      </dl></div>
      <h3 style="margin:8px 0 0">ประวัติธุรกรรม</h3>
      <ul class="timeline">${evs.map((e) => `<li><b>${EVENT_TH[e.name]}</b> — ${eventDetail(e)}<div class="when">${e.time ? fmtDate(e.time) : ""} · Tx ${txLink(e.hash)}</div></li>`).join("") || "<li>–</li>"}</ul>
      <div class="actions">${actionsFor(j)}</div>`);
  }

  function promptForm(title, fieldsHtml, submitText, onSubmit) {
    openModal(`<h2>${title}</h2><form class="form" style="border:0;padding:0;max-width:none" id="mform">${fieldsHtml}<button class="btn primary big" type="submit">${submitText}</button></form>`);
    $("#mform").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(ev.target));
      modal.close();
      try { await onSubmit(data); } catch (_) {}
    });
  }

  // ---------- actions ----------
  async function handleAction(act, id) {
    const j = state.jobs.find((x) => x.id === id);
    try {
      switch (act) {
        case "detail": return showDetail(id);
        case "deposit":
          if (modal.open) modal.close();
          return await sendTx(`ฝากเงินงาน #${id}`, (c) => c.deposit(id, { value: j.amount }));
        case "cancel":
          if (!confirm(`ยืนยันยกเลิกงาน #${id}?`)) return;
          if (modal.open) modal.close();
          return await sendTx(`ยกเลิกงาน #${id}`, (c) => c.cancelJob(id));
        case "approve":
          if (!confirm(`อนุมัติงาน #${id} และโอน ${eth(j.escrowBalance)} ให้ฟรีแลนซ์?`)) return;
          if (modal.open) modal.close();
          return await sendTx(`อนุมัติและจ่ายเงินงาน #${id}`, (c) => c.approveAndRelease(id));
        case "refund":
          if (modal.open) modal.close();
          return await sendTx(`ขอคืนเงินงาน #${id}`, (c) => c.refundAfterDeadline(id));
        case "submit":
          return promptForm(`ส่งมอบงาน #${id}`,
            `<label>URL หรือ Hash ของไฟล์ผลงาน<input name="evidence" required placeholder="https://github.com/... หรือ ipfs://... หรือ SHA-256" value="${esc(j.workEvidence)}" /></label>
             <label class="check" style="font-size:13px;color:var(--muted)">ใช้ปุ่มด้านล่างคำนวณ SHA-256 ของไฟล์ได้</label>
             <input type="file" id="hashFile" />`,
            "บันทึกการส่งงาน",
            (d) => sendTx(`ส่งงาน #${id}`, (c) => c.submitWork(id, d.evidence.trim())));
        case "dispute":
          return promptForm(`แจ้งข้อพิพาท งาน #${id}`,
            `<label>เหตุผล<textarea name="reason" rows="4" required placeholder="อธิบายปัญหาให้ผู้ดูแลพิจารณา"></textarea></label>`,
            "แจ้งข้อพิพาท",
            (d) => sendTx(`แจ้งข้อพิพาทงาน #${id}`, (c) => c.raiseDispute(id, d.reason.trim())));
        case "resolve":
          return promptForm(`ตัดสินข้อพิพาท งาน #${id}`,
            `<div class="desc"><b>เหตุผล:</b> ${esc(j.disputeReason)}<br><b>ผลงาน:</b> ${j.workEvidence ? evidenceHtml(j.workEvidence) : "ยังไม่ส่ง"}</div>
             <label>สัดส่วนที่จ่ายให้ฟรีแลนซ์: <b id="pctLabel">50%</b>
               <input type="range" name="pct" min="0" max="100" value="50" id="pctRange" /></label>
             <div id="pctPreview" class="mono"></div>`,
            "ยืนยันคำตัดสิน",
            (d) => sendTx(`ตัดสินข้อพิพาทงาน #${id}`, (c) => c.resolveDispute(id, Number(d.pct))));
      }
    } catch (_) { /* toast already shown */ }
  }

  // hash file helper & resolve slider preview (delegated, since modal is dynamic)
  document.addEventListener("change", async (e) => {
    if (e.target.id === "hashFile" && e.target.files[0]) {
      const buf = await e.target.files[0].arrayBuffer();
      const h = await crypto.subtle.digest("SHA-256", buf);
      const hex = "sha256:" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
      $("#mform [name=evidence]").value = hex;
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "pctRange") {
      const p = Number(e.target.value);
      const id = Number($("#modalBody h2").textContent.match(/#(\d+)/)[1]);
      const j = state.jobs.find((x) => x.id === id);
      const toF = (j.escrowBalance * BigInt(p)) / 100n;
      $("#pctLabel").textContent = `${p}%`;
      $("#pctPreview").textContent = `ฟรีแลนซ์ได้ ${eth(toF)} · คืนผู้ว่าจ้าง ${eth(j.escrowBalance - toF)}`;
    }
  });

  async function createJob(ev) {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      if (!state.writeContract) throw new Error("กรุณาเชื่อมต่อ MetaMask บนเครือข่ายที่ถูกต้องก่อน");
      const freelancer = f.get("freelancer").trim();
      if (!ethers.isAddress(freelancer)) throw new Error("Wallet Address ของฟรีแลนซ์ไม่ถูกต้อง");
      if (same(freelancer, state.account)) throw new Error("ผู้ว่าจ้างและฟรีแลนซ์ต้องเป็นคนละกระเป๋า");
      const amount = ethers.parseEther(String(f.get("amount")));
      if (amount <= 0n) throw new Error("ค่าจ้างต้องมากกว่า 0");
      const deadline = Math.floor(new Date(f.get("deadline")).getTime() / 1000);
      if (!(deadline > Date.now() / 1000)) throw new Error("กำหนดส่งต้องเป็นเวลาในอนาคต");

      const receipt = await sendTx("สร้างข้อตกลง", (c) => c.createJob(f.get("title").trim(), f.get("description").trim(), ethers.getAddress(freelancer), amount, deadline));
      const log = receipt.logs.map((l) => { try { return state.writeContract.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "JobCreated");
      const jobId = log ? Number(log.args.jobId) : null;
      ev.target.reset();
      setDefaultDeadline();
      if (jobId && f.get("depositNow")) {
        await sendTx(`ฝากเงินงาน #${jobId}`, (c) => c.deposit(jobId, { value: amount }));
      }
      switchTab("jobs");
    } catch (e) {
      if (!e?.code && !e?.reason) toast(`❌ ${esc(errMsg(e))}`, "err");
    }
  }

  async function setArbiter(ev) {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const addr = f.get("addr").trim();
    if (!ethers.isAddress(addr)) return toast("Address ไม่ถูกต้อง", "err");
    try { await sendTx("ปรับสิทธิ์ผู้ดูแล", (c) => c.setArbiter(addr, f.get("enabled") === "true")); ev.target.reset(); } catch (_) {}
  }

  // ---------- UI wiring ----------
  function switchTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  }

  function setDefaultDeadline() {
    const d = new Date(Date.now() + 7 * 864e5);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $("#createForm [name=deadline]").value = d.toISOString().slice(0, 16);
  }

  function init() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
    $$(".seg-btn").forEach((b) => b.addEventListener("click", () => {
      $$(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
      state.role = b.dataset.role;
      renderJobs();
    }));
    $$("[data-refresh]").forEach((b) => b.addEventListener("click", refreshAll));
    $("#connectBtn").addEventListener("click", connect);
    $("#createForm").addEventListener("submit", createJob);
    $("#arbiterForm").addEventListener("submit", setArbiter);
    $("#searchId").addEventListener("input", renderJobs);
    $("#onlyMine").addEventListener("change", renderHistory);
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) handleAction(b.dataset.act, Number(b.dataset.id));
    });
    setDefaultDeadline();

    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", () => setupWallet());
      window.ethereum.on?.("chainChanged", () => location.reload());
      window.ethereum.request({ method: "eth_accounts" }).then((a) => (a.length ? setupWallet() : refreshAll())).catch(refreshAll);
    } else {
      refreshAll();
    }
  }

  init();
})();
