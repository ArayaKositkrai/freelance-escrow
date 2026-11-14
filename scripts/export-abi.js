// คัดลอก ABI ล่าสุดไปให้หน้าเว็บ (รันหลัง npx hardhat compile)
const fs = require("fs");
const a = require("../artifacts/contracts/FreelanceEscrow.sol/FreelanceEscrow.json");
fs.writeFileSync(
  __dirname + "/../docs/abi.js",
  "// สร้างจาก artifacts/contracts/FreelanceEscrow.sol/FreelanceEscrow.json\nwindow.ESCROW_ABI = " + JSON.stringify(a.abi) + ";\n"
);
console.log("docs/abi.js updated");
