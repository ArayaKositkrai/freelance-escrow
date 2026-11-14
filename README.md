# DigitalWork Escrow — ระบบจ้างงานฟรีแลนซ์และชำระเงินตามผลงาน
**Freelance Escrow & Smart Payment Platform** (โจทย์ที่ 1)

แพลตฟอร์มที่ใช้ Smart Contract บน Ethereum เป็นตัวกลางเก็บเงิน (Escrow) ระหว่างผู้ว่าจ้างกับฟรีแลนซ์
เงินค่าจ้างถูกล็อกไว้ใน contract และจะโอนให้ฟรีแลนซ์อัตโนมัติเมื่อผู้ว่าจ้างอนุมัติงาน
หากมีปัญหา คู่สัญญาแจ้งข้อพิพาทได้ และผู้ดูแล (Arbiter) เป็นผู้ตัดสินคืนเงินหรือจ่ายเงิน


| GitHub Repository | https://github.com/ArayaKositkrai/freelance-escrow |

---

## 🧩 สถาปัตยกรรม

```
┌──────────────────────┐      ethers.js       ┌──────────────┐      JSON-RPC      ┌────────────────────────┐
│ หน้าบ้าน (docs/)       │ ───────────────────▶ │  MetaMask    │ ─────────────────▶ │ หลังบ้าน: Smart Contract │
│ HTML/CSS/JS          │  อ่านข้อมูล / Events   │ (เซ็นธุรกรรม) │                    │ FreelanceEscrow.sol    │
│ โฮสต์บน GitHub Pages │ ◀─────────────────── │              │ ◀───────────────── │ บน Sepolia Testnet      │
└──────────────────────┘                      └──────────────┘                    └────────────────────────┘
```

- **หลังบ้าน (Backend)** — `contracts/FreelanceEscrow.sol` (Solidity 0.8.24) เก็บข้อมูลงาน ถือเงิน และบังคับใช้กฎทางธุรกิจทั้งหมดบน blockchain
- **หน้าบ้าน (Frontend)** — `docs/` เว็บแบบ static ใช้ ethers.js v6 เชื่อม MetaMask ไม่ต้องมี server จึงโฮสต์บน GitHub Pages ได้
- **เครื่องมือ** — Hardhat สำหรับ compile / test / deploy

## ✅ ฟังก์ชันตามโจทย์

| # | ความต้องการ | ฟังก์ชันใน Contract | หน้าเว็บ |
|---|---|---|---|
| 1 | สร้างข้อตกลงการจ้างงาน | `createJob(title, description, freelancer, amount, deadline)` | แท็บ "สร้างข้อตกลงใหม่" |
| 2 | ฝากเงินค่าจ้าง | `deposit(jobId)` payable — ต้องโอนเท่ากับค่าจ้างพอดี | ปุ่ม "ฝากเงิน" / ติ๊กฝากทันทีตอนสร้าง |
| 3 | บันทึกการส่งมอบงาน | `submitWork(jobId, evidence)` — URL หรือ Hash | ปุ่ม "ส่งมอบงาน" + ตัวช่วยคำนวณ SHA-256 ของไฟล์ |
| 4 | อนุมัติและจ่ายเงิน | `approveAndRelease(jobId)` — โอน ETH ให้ฟรีแลนซ์อัตโนมัติ | ปุ่ม "อนุมัติและจ่ายเงิน" |
| 5 | จัดการข้อพิพาท | `raiseDispute(jobId, reason)` / `resolveDispute(jobId, freelancerPercent)` | ปุ่ม "แจ้งข้อพิพาท" / แท็บ "ผู้ดูแลข้อพิพาท" (แบ่งเงิน 0–100%) |
| 6 | ติดตามสถานะธุรกรรม | `getJob`, `getJobsByClient`, `getJobsByFreelancer` + Events | แท็บ "งานของฉัน", "ประวัติธุรกรรม" (มี Tx Hash ลิงก์ Etherscan) |

ฟังก์ชันเสริม: `cancelJob` (ยกเลิกก่อนฝากเงิน), `refundAfterDeadline` (เลยกำหนดส่งแล้วฟรีแลนซ์ยังไม่ส่งงาน ผู้ว่าจ้างขอเงินคืนได้), `setArbiter` (Owner เพิ่ม/ถอนผู้ดูแล)

### สถานะของงาน (State Machine)

```
Created ──deposit──▶ Funded ──submitWork──▶ Submitted ──approveAndRelease──▶ Paid
   │                   │  │                    │
   └─cancelJob─▶ Cancelled  └─(เลยกำหนด) refundAfterDeadline─▶ Refunded
                       │                       │
                       └──────raiseDispute─────┴──▶ Disputed ──resolveDispute──▶ Resolved
```

### 🔒 กฎทางธุรกิจ

- **ห้ามจ่ายเงินซ้ำ** — ทุกฟังก์ชันที่โอนเงินจะเปลี่ยนสถานะเป็นสถานะสิ้นสุด และตั้ง `escrowBalance = 0` *ก่อน* โอน (Checks-Effects-Interactions) พร้อม `nonReentrant` กัน reentrancy
- **เบิกเงินจาก Escrow ไม่ได้ถ้ายังไม่เข้าเงื่อนไข** — เงินออกได้เพียง 3 ทาง: ผู้ว่าจ้างอนุมัติงานที่ส่งแล้ว / ผู้ดูแลตัดสินข้อพิพาท / เลยกำหนดส่งโดยไม่มีการส่งงาน
- ระหว่างข้อพิพาท ผู้ว่าจ้างอนุมัติจ่ายเองไม่ได้ ต้องรอผู้ดูแลตัดสิน
- ผู้ดูแลที่เป็นคู่สัญญาของงานนั้นตัดสินงานนั้นไม่ได้
- contract ไม่รับ ETH ที่โอนเข้ามาตรง ๆ (ต้องผ่าน `deposit` เท่านั้น)

---

## 📁 โครงสร้างโปรเจกต์

```
freelance-escrow/
├── contracts/FreelanceEscrow.sol   # Smart Contract (หลังบ้าน)
├── test/FreelanceEscrow.test.js    # Unit tests 10 กรณี
├── scripts/deploy.js               # Deploy + อัปเดต docs/config.js อัตโนมัติ
├── scripts/export-abi.js           # คัดลอก ABI ไปให้หน้าเว็บ
├── docs/                           # หน้าบ้าน (GitHub Pages)
│   ├── index.html
│   ├── style.css
│   ├── app.js                      # logic + เชื่อม MetaMask
│   ├── config.js                   # Contract Address / Chain ID
│   ├── abi.js
│   └── (ethers v6 โหลดจาก jsDelivr CDN)
├── hardhat.config.js
├── .env.example
└── README.md
```

---

## 🚀 วิธีติดตั้งและใช้งาน

### สิ่งที่ต้องมี
- [Node.js](https://nodejs.org/) 18 ขึ้นไป
- [MetaMask](https://metamask.io/download/) บนเบราว์เซอร์
- SepoliaETH สำหรับค่า gas (ขอฟรีจาก Sepolia faucet เช่น Google Cloud Web3 Faucet)

### 1) ติดตั้งและทดสอบ

```bash
git clone https://github.com/ArayaKositkrai/freelance-escrow.git
cd freelance-escrow
npm install
npx hardhat compile
npx hardhat test
```

### 2) Deploy Smart Contract ไป Sepolia

**วิธี A — Hardhat (แนะนำ)**

```bash
cp .env.example .env
# แก้ .env ใส่ PRIVATE_KEY ของกระเป๋าที่มี SepoliaETH (ห้าม commit ไฟล์ .env)
npm run deploy:sepolia
```
สคริปต์จะแสดง Contract Address และเขียนค่า `CONTRACT_ADDRESS`, `CHAIN_ID`, `DEPLOY_BLOCK` ลง `docs/config.js` ให้อัตโนมัติ

**วิธี B — Remix IDE (ไม่ต้องใช้ private key)**
1. เปิด https://remix.ethereum.org แล้วสร้างไฟล์ `FreelanceEscrow.sol` วางโค้ดจาก `contracts/`
2. แท็บ Solidity Compiler → เลือก 0.8.24 → Compile
3. แท็บ Deploy & Run → Environment เลือก **Injected Provider - MetaMask** (MetaMask อยู่บน Sepolia) → Deploy
4. คัดลอก address ที่ได้ไปใส่ `CONTRACT_ADDRESS` ใน `docs/config.js` (และใส่เลข block ที่ deploy ใน `DEPLOY_BLOCK` ถ้าต้องการ)

### 3) รันหน้าเว็บในเครื่อง

```bash
npx http-server docs -p 8080
# หรือ: python -m http.server 8080 --directory docs
```
เปิด http://localhost:8080 แล้วกด "เชื่อมต่อ MetaMask"

> ทดสอบบน local chain: รัน `npm run node` แล้ว `npm run deploy:local` และ import private key ของบัญชีทดสอบ Hardhat เข้า MetaMask (เครือข่าย `http://127.0.0.1:8545`, chain id 31337)

### 4) เผยแพร่ขึ้น GitHub Pages

```bash
git init
git add .
git commit -m "Freelance Escrow dApp"
git branch -M main
git remote add origin https://github.com/<username>/freelance-escrow.git
git push -u origin main
```
จากนั้นไปที่ repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / โฟลเดอร์ `/docs` → Save
รอ 1–2 นาที จะได้ URL `https://<username>.github.io/freelance-escrow/`

---

## 🧪 สถานการณ์ทดสอบ (ใช้ MetaMask 3 บัญชี)

| บัญชี | บทบาท |
|---|---|
| Account 1 | Owner / ผู้ดูแลข้อพิพาท (บัญชีที่ deploy) |
| Account 2 | ผู้ว่าจ้าง |
| Account 3 | ฟรีแลนซ์ |

1. **Account 2** สร้างข้อตกลง ใส่ address ของ Account 3 ค่าจ้าง 0.001 ETH และติ๊ก "ฝากเงินทันที"
2. **Account 3** เปิด "งานของฉัน" → "ส่งมอบงาน" ใส่ URL ผลงาน
3. **Account 2** กด "อนุมัติและจ่ายเงิน" → ฟรีแลนซ์ได้รับ ETH, สถานะ = จ่ายเงินแล้ว
4. ลองสร้างงานที่ 2 แล้วกด "แจ้งข้อพิพาท" → สลับเป็น **Account 1** แท็บ "ผู้ดูแลข้อพิพาท" เลื่อนแถบแบ่งเงินแล้วยืนยัน
5. ดูแท็บ "ประวัติธุรกรรม" — ทุกขั้นตอนมี Transaction Hash ลิงก์ไป Etherscan

> หมายเหตุ: ผู้ดูแลตัดสินงานที่ตัวเองเป็นคู่สัญญาไม่ได้ จึงควรใช้บัญชีแยกกันอย่างน้อย 3 บัญชี (หรือให้ Owner เพิ่มผู้ดูแลคนอื่นด้วย `setArbiter`)

### ผลการทดสอบ Unit Test

```
  FreelanceEscrow
    ✔ 1) สร้างข้อตกลงการจ้างงานได้
    ✔ ตรวจสอบข้อมูลตอนสร้าง (deadline / freelancer / amount)
    ✔ 2) ฝากเงินได้เฉพาะผู้ว่าจ้าง และต้องเท่ากับค่าจ้างพอดี
    ✔ 3-4) ส่งงาน -> อนุมัติ -> โอนเงินให้ฟรีแลนซ์ และห้ามจ่ายซ้ำ
    ✔ ไม่สามารถส่งงานก่อนฝากเงินได้
    ✔ 5) ข้อพิพาท: ผู้ดูแลแบ่งเงิน 70/30
    ✔ ผู้ดูแลที่เป็นคู่สัญญาเองตัดสินไม่ได้ และ owner เพิ่มผู้ดูแลได้
    ✔ คืนเงินได้เมื่อเลยกำหนดส่งและยังไม่มีการส่งงาน
    ✔ ยกเลิกได้เฉพาะก่อนฝากเงิน
    ✔ ปฏิเสธ ETH ที่โอนเข้ามาตรง ๆ

  10 passing
```

---

## 🛠️ เทคโนโลยี
Solidity 0.8.24 · Hardhat · ethers.js v6 · MetaMask · GitHub Pages · Sepolia Testnet

## 👩‍💻 ผู้จัดทำ
66012968 สิราวรรณ จันแดง
66048395 อารยา โฆษิตไกร
66080904 กันต์ณิษา อินตรา
66085170 ศิรินทร์ จันทร์ทนต์
