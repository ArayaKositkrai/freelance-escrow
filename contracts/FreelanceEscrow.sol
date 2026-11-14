// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  FreelanceEscrow
 * @notice ระบบจ้างงานฟรีแลนซ์และชำระเงินตามผลงาน (Freelance Escrow & Smart Payment Platform)
 *
 *  Flow ปกติ:
 *    Created --deposit--> Funded --submitWork--> Submitted --approveAndRelease--> Paid
 *
 *  Flow อื่น ๆ:
 *    Created   --cancelJob-------------> Cancelled          (ยังไม่ฝากเงิน ยกเลิกได้)
 *    Funded    --refundAfterDeadline---> Refunded           (เลยกำหนดส่งแล้วฟรีแลนซ์ยังไม่ส่งงาน)
 *    Funded/Submitted --raiseDispute---> Disputed
 *    Disputed  --resolveDispute--------> Resolved           (ผู้ดูแลแบ่งเงิน 0-100% ให้ฟรีแลนซ์ ที่เหลือคืนผู้ว่าจ้าง)
 *
 *  กฎทางธุรกิจ:
 *    - ห้ามจ่ายเงินซ้ำ: เปลี่ยนสถานะเป็นสถานะสิ้นสุดและตั้ง amount = 0 ก่อนโอนเงินทุกครั้ง + nonReentrant
 *    - เบิกเงินออกจาก Escrow ได้เฉพาะ approveAndRelease / resolveDispute / refundAfterDeadline เท่านั้น
 */
contract FreelanceEscrow {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    enum Status {
        Created,    // 0 สร้างข้อตกลงแล้ว รอฝากเงิน
        Funded,     // 1 ฝากเงินเข้า Escrow แล้ว
        Submitted,  // 2 ฟรีแลนซ์ส่งงานแล้ว รอตรวจรับ
        Paid,       // 3 อนุมัติและจ่ายเงินแล้ว
        Disputed,   // 4 อยู่ระหว่างข้อพิพาท
        Resolved,   // 5 ผู้ดูแลตัดสินข้อพิพาทแล้ว
        Refunded,   // 6 คืนเงินผู้ว่าจ้างแล้ว (เลยกำหนดส่ง)
        Cancelled   // 7 ยกเลิกก่อนฝากเงิน
    }

    struct Job {
        uint256 id;
        address client;          // ผู้ว่าจ้าง
        address freelancer;      // ฟรีแลนซ์
        string title;            // ชื่อโครงการ
        string description;      // รายละเอียดงาน
        uint256 amount;          // ค่าจ้าง (wei)
        uint256 deadline;        // กำหนดส่ง (unix timestamp)
        uint256 escrowBalance;   // เงินที่ถูกล็อกอยู่ใน Escrow ของงานนี้
        string workEvidence;     // URL / hash ของผลงาน
        string disputeReason;    // เหตุผลข้อพิพาท
        address disputeRaisedBy; // ผู้แจ้งข้อพิพาท
        Status status;
        uint256 createdAt;
        uint256 updatedAt;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------
    address public owner;
    mapping(address => bool) public isArbiter;

    uint256 public jobCount;
    mapping(uint256 => Job) private jobs;
    mapping(address => uint256[]) private clientJobs;
    mapping(address => uint256[]) private freelancerJobs;

    uint256 private locked = 1;

    // ------------------------------------------------------------------
    // Events (ใช้ติดตามสถานะ/ประวัติธุรกรรมบนหน้าเว็บ)
    // ------------------------------------------------------------------
    event JobCreated(uint256 indexed jobId, address indexed client, address indexed freelancer, string title, uint256 amount, uint256 deadline);
    event PaymentDeposited(uint256 indexed jobId, address indexed client, uint256 amount);
    event WorkSubmitted(uint256 indexed jobId, address indexed freelancer, string evidence);
    event PaymentReleased(uint256 indexed jobId, address indexed freelancer, uint256 amount);
    event DisputeRaised(uint256 indexed jobId, address indexed raisedBy, string reason);
    event DisputeResolved(uint256 indexed jobId, address indexed arbiter, uint256 toFreelancer, uint256 toClient);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobCancelled(uint256 indexed jobId, address indexed client);
    event ArbiterUpdated(address indexed arbiter, bool enabled);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyArbiter() {
        require(isArbiter[msg.sender], "Only arbiter");
        _;
    }

    modifier jobExists(uint256 jobId) {
        require(jobId > 0 && jobId <= jobCount, "Job not found");
        _;
    }

    modifier onlyClient(uint256 jobId) {
        require(msg.sender == jobs[jobId].client, "Only client");
        _;
    }

    modifier onlyFreelancer(uint256 jobId) {
        require(msg.sender == jobs[jobId].freelancer, "Only freelancer");
        _;
    }

    modifier nonReentrant() {
        require(locked == 1, "Reentrant call");
        locked = 2;
        _;
        locked = 1;
    }

    constructor() {
        owner = msg.sender;
        isArbiter[msg.sender] = true;
        emit ArbiterUpdated(msg.sender, true);
    }

    // ------------------------------------------------------------------
    // 1. Create Contract
    // ------------------------------------------------------------------
    function createJob(
        string calldata title,
        string calldata description,
        address freelancer,
        uint256 amount,
        uint256 deadline
    ) external returns (uint256 jobId) {
        require(bytes(title).length > 0, "Title required");
        require(freelancer != address(0), "Invalid freelancer");
        require(freelancer != msg.sender, "Client cannot be freelancer");
        require(amount > 0, "Amount must be > 0");
        require(deadline > block.timestamp, "Deadline must be in future");

        jobId = ++jobCount;
        Job storage j = jobs[jobId];
        j.id = jobId;
        j.client = msg.sender;
        j.freelancer = freelancer;
        j.title = title;
        j.description = description;
        j.amount = amount;
        j.deadline = deadline;
        j.status = Status.Created;
        j.createdAt = block.timestamp;
        j.updatedAt = block.timestamp;

        clientJobs[msg.sender].push(jobId);
        freelancerJobs[freelancer].push(jobId);

        emit JobCreated(jobId, msg.sender, freelancer, title, amount, deadline);
    }

    /// @notice ยกเลิกข้อตกลงที่ยังไม่ได้ฝากเงิน
    function cancelJob(uint256 jobId) external jobExists(jobId) onlyClient(jobId) {
        Job storage j = jobs[jobId];
        require(j.status == Status.Created, "Only before deposit");
        j.status = Status.Cancelled;
        j.updatedAt = block.timestamp;
        emit JobCancelled(jobId, msg.sender);
    }

    // ------------------------------------------------------------------
    // 2. Deposit Payment
    // ------------------------------------------------------------------
    function deposit(uint256 jobId) external payable jobExists(jobId) onlyClient(jobId) {
        Job storage j = jobs[jobId];
        require(j.status == Status.Created, "Already funded or closed");
        require(msg.value == j.amount, "Must deposit exact amount");

        j.escrowBalance = msg.value;
        j.status = Status.Funded;
        j.updatedAt = block.timestamp;

        emit PaymentDeposited(jobId, msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // 3. Submit Work
    // ------------------------------------------------------------------
    /// @dev ส่งซ้ำได้ระหว่างรอตรวจรับ (แก้งาน/อัปเดตลิงก์)
    function submitWork(uint256 jobId, string calldata evidence) external jobExists(jobId) onlyFreelancer(jobId) {
        Job storage j = jobs[jobId];
        require(j.status == Status.Funded || j.status == Status.Submitted, "Job not funded");
        require(bytes(evidence).length > 0, "Evidence required");

        j.workEvidence = evidence;
        j.status = Status.Submitted;
        j.updatedAt = block.timestamp;

        emit WorkSubmitted(jobId, msg.sender, evidence);
    }

    // ------------------------------------------------------------------
    // 4. Approve & Release Payment
    // ------------------------------------------------------------------
    function approveAndRelease(uint256 jobId) external nonReentrant jobExists(jobId) onlyClient(jobId) {
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "Work not submitted");

        uint256 payout = j.escrowBalance;
        require(payout > 0, "Nothing to release");

        // Effects ก่อน Interactions -> กันจ่ายซ้ำ
        j.escrowBalance = 0;
        j.status = Status.Paid;
        j.updatedAt = block.timestamp;

        _send(j.freelancer, payout);
        emit PaymentReleased(jobId, j.freelancer, payout);
    }

    // ------------------------------------------------------------------
    // 5. Dispute Management
    // ------------------------------------------------------------------
    function raiseDispute(uint256 jobId, string calldata reason) external jobExists(jobId) {
        Job storage j = jobs[jobId];
        require(msg.sender == j.client || msg.sender == j.freelancer, "Only parties");
        require(j.status == Status.Funded || j.status == Status.Submitted, "Cannot dispute now");
        require(bytes(reason).length > 0, "Reason required");

        j.status = Status.Disputed;
        j.disputeReason = reason;
        j.disputeRaisedBy = msg.sender;
        j.updatedAt = block.timestamp;

        emit DisputeRaised(jobId, msg.sender, reason);
    }

    /**
     * @notice ผู้ดูแลตัดสินข้อพิพาท
     * @param freelancerPercent 100 = จ่ายฟรีแลนซ์ทั้งหมด, 0 = คืนผู้ว่าจ้างทั้งหมด, อื่น ๆ = แบ่งตามสัดส่วน
     */
    function resolveDispute(uint256 jobId, uint8 freelancerPercent) external nonReentrant onlyArbiter jobExists(jobId) {
        Job storage j = jobs[jobId];
        require(j.status == Status.Disputed, "Not disputed");
        require(freelancerPercent <= 100, "Percent 0-100");
        require(msg.sender != j.client && msg.sender != j.freelancer, "Arbiter is a party");

        uint256 total = j.escrowBalance;
        uint256 toFreelancer = (total * freelancerPercent) / 100;
        uint256 toClient = total - toFreelancer;

        j.escrowBalance = 0;
        j.status = Status.Resolved;
        j.updatedAt = block.timestamp;

        if (toFreelancer > 0) _send(j.freelancer, toFreelancer);
        if (toClient > 0) _send(j.client, toClient);

        emit DisputeResolved(jobId, msg.sender, toFreelancer, toClient);
    }

    /// @notice ผู้ว่าจ้างขอคืนเงินได้เมื่อเลยกำหนดส่งแล้วฟรีแลนซ์ยังไม่ส่งงาน
    function refundAfterDeadline(uint256 jobId) external nonReentrant jobExists(jobId) onlyClient(jobId) {
        Job storage j = jobs[jobId];
        require(j.status == Status.Funded, "Only funded & not submitted");
        require(block.timestamp > j.deadline, "Deadline not passed");

        uint256 amount = j.escrowBalance;
        j.escrowBalance = 0;
        j.status = Status.Refunded;
        j.updatedAt = block.timestamp;

        _send(j.client, amount);
        emit Refunded(jobId, j.client, amount);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------
    function setArbiter(address arbiter, bool enabled) external onlyOwner {
        require(arbiter != address(0), "Invalid address");
        isArbiter[arbiter] = enabled;
        emit ArbiterUpdated(arbiter, enabled);
    }

    // ------------------------------------------------------------------
    // 6. Transaction Tracking (views)
    // ------------------------------------------------------------------
    function getJob(uint256 jobId) external view jobExists(jobId) returns (Job memory) {
        return jobs[jobId];
    }

    function getJobsByClient(address client) external view returns (uint256[] memory) {
        return clientJobs[client];
    }

    function getJobsByFreelancer(address freelancer) external view returns (uint256[] memory) {
        return freelancerJobs[freelancer];
    }

    function totalEscrowed() external view returns (uint256) {
        return address(this).balance;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------
    function _send(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    /// @dev ไม่รับ ETH ที่ส่งเข้ามาตรง ๆ (ต้องผ่าน deposit เท่านั้น)
    receive() external payable {
        revert("Use deposit()");
    }
}
