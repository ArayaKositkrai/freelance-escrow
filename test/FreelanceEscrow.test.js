const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Status = { Created: 0, Funded: 1, Submitted: 2, Paid: 3, Disputed: 4, Resolved: 5, Refunded: 6, Cancelled: 7 };
const ONE = ethers.parseEther("1");

describe("FreelanceEscrow", function () {
  let escrow, admin, client, freelancer, other;

  async function newJob(amount = ONE) {
    const deadline = (await time.latest()) + 7 * 24 * 3600;
    await escrow.connect(client).createJob("เว็บไซต์ร้านกาแฟ", "ทำหน้า landing page", freelancer.address, amount, deadline);
    return await escrow.jobCount();
  }

  beforeEach(async () => {
    [admin, client, freelancer, other] = await ethers.getSigners();
    escrow = await (await ethers.getContractFactory("FreelanceEscrow")).deploy();
  });

  it("1) สร้างข้อตกลงการจ้างงานได้", async () => {
    const id = await newJob();
    const j = await escrow.getJob(id);
    expect(j.client).to.equal(client.address);
    expect(j.freelancer).to.equal(freelancer.address);
    expect(j.amount).to.equal(ONE);
    expect(j.status).to.equal(Status.Created);
    expect(await escrow.getJobsByClient(client.address)).to.deep.equal([id]);
    expect(await escrow.getJobsByFreelancer(freelancer.address)).to.deep.equal([id]);
  });

  it("ตรวจสอบข้อมูลตอนสร้าง (deadline / freelancer / amount)", async () => {
    const now = await time.latest();
    await expect(escrow.connect(client).createJob("A", "", freelancer.address, ONE, now - 1)).to.be.revertedWith("Deadline must be in future");
    await expect(escrow.connect(client).createJob("A", "", client.address, ONE, now + 100)).to.be.revertedWith("Client cannot be freelancer");
    await expect(escrow.connect(client).createJob("A", "", freelancer.address, 0, now + 100)).to.be.revertedWith("Amount must be > 0");
  });

  it("2) ฝากเงินได้เฉพาะผู้ว่าจ้าง และต้องเท่ากับค่าจ้างพอดี", async () => {
    const id = await newJob();
    await expect(escrow.connect(other).deposit(id, { value: ONE })).to.be.revertedWith("Only client");
    await expect(escrow.connect(client).deposit(id, { value: ONE / 2n })).to.be.revertedWith("Must deposit exact amount");
    await expect(escrow.connect(client).deposit(id, { value: ONE })).to.emit(escrow, "PaymentDeposited").withArgs(id, client.address, ONE);
    expect(await escrow.totalEscrowed()).to.equal(ONE);
    await expect(escrow.connect(client).deposit(id, { value: ONE })).to.be.revertedWith("Already funded or closed");
  });

  it("3-4) ส่งงาน -> อนุมัติ -> โอนเงินให้ฟรีแลนซ์ และห้ามจ่ายซ้ำ", async () => {
    const id = await newJob();
    await escrow.connect(client).deposit(id, { value: ONE });
    await expect(escrow.connect(client).approveAndRelease(id)).to.be.revertedWith("Work not submitted");
    await expect(escrow.connect(other).submitWork(id, "ipfs://x")).to.be.revertedWith("Only freelancer");

    await escrow.connect(freelancer).submitWork(id, "https://github.com/demo/work");
    expect((await escrow.getJob(id)).status).to.equal(Status.Submitted);

    await expect(escrow.connect(client).approveAndRelease(id)).to.changeEtherBalances([freelancer, escrow], [ONE, -ONE]);
    const j = await escrow.getJob(id);
    expect(j.status).to.equal(Status.Paid);
    expect(j.escrowBalance).to.equal(0);

    await expect(escrow.connect(client).approveAndRelease(id)).to.be.revertedWith("Work not submitted");
  });

  it("ไม่สามารถส่งงานก่อนฝากเงินได้", async () => {
    const id = await newJob();
    await expect(escrow.connect(freelancer).submitWork(id, "x")).to.be.revertedWith("Job not funded");
  });

  it("5) ข้อพิพาท: ผู้ดูแลแบ่งเงิน 70/30", async () => {
    const id = await newJob();
    await escrow.connect(client).deposit(id, { value: ONE });
    await escrow.connect(freelancer).submitWork(id, "ipfs://hash");
    await expect(escrow.connect(other).raiseDispute(id, "x")).to.be.revertedWith("Only parties");
    await escrow.connect(client).raiseDispute(id, "งานไม่ครบตาม scope");

    // ระหว่างข้อพิพาท ห้ามเบิกเงิน
    await expect(escrow.connect(client).approveAndRelease(id)).to.be.revertedWith("Work not submitted");
    await expect(escrow.connect(other).resolveDispute(id, 70)).to.be.revertedWith("Only arbiter");

    const toF = (ONE * 70n) / 100n;
    await expect(escrow.connect(admin).resolveDispute(id, 70)).to.changeEtherBalances([freelancer, client, escrow], [toF, ONE - toF, -ONE]);
    expect((await escrow.getJob(id)).status).to.equal(Status.Resolved);
    await expect(escrow.connect(admin).resolveDispute(id, 70)).to.be.revertedWith("Not disputed");
  });

  it("ผู้ดูแลที่เป็นคู่สัญญาเองตัดสินไม่ได้ และ owner เพิ่มผู้ดูแลได้", async () => {
    await escrow.connect(admin).setArbiter(client.address, true);
    const id = await newJob();
    await escrow.connect(client).deposit(id, { value: ONE });
    await escrow.connect(freelancer).raiseDispute(id, "ไม่ตอบกลับ");
    await expect(escrow.connect(client).resolveDispute(id, 0)).to.be.revertedWith("Arbiter is a party");
    await expect(escrow.connect(other).setArbiter(other.address, true)).to.be.revertedWith("Only owner");
  });

  it("คืนเงินได้เมื่อเลยกำหนดส่งและยังไม่มีการส่งงาน", async () => {
    const id = await newJob();
    await escrow.connect(client).deposit(id, { value: ONE });
    await expect(escrow.connect(client).refundAfterDeadline(id)).to.be.revertedWith("Deadline not passed");
    await time.increase(8 * 24 * 3600);
    await expect(escrow.connect(client).refundAfterDeadline(id)).to.changeEtherBalances([client, escrow], [ONE, -ONE]);
    await expect(escrow.connect(client).refundAfterDeadline(id)).to.be.revertedWith("Only funded & not submitted");
  });

  it("ยกเลิกได้เฉพาะก่อนฝากเงิน", async () => {
    const id = await newJob();
    await escrow.connect(client).cancelJob(id);
    expect((await escrow.getJob(id)).status).to.equal(Status.Cancelled);
    await expect(escrow.connect(client).deposit(id, { value: ONE })).to.be.revertedWith("Already funded or closed");
  });

  it("ปฏิเสธ ETH ที่โอนเข้ามาตรง ๆ", async () => {
    await expect(client.sendTransaction({ to: await escrow.getAddress(), value: ONE })).to.be.revertedWith("Use deposit()");
  });
});
