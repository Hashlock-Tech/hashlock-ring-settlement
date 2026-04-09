import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("RingHTLC", function () {
  // ─── Fixtures ────────────────────────────────────────────────────────

  async function deployFixture() {
    const [owner, alice, bob, charlie, dave, eve] = await ethers.getSigners();

    const RingHTLC = await ethers.getContractFactory("RingHTLC");
    const ring = await RingHTLC.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy(
      "Test Token",
      "TST",
      ethers.parseEther("1000000")
    );

    for (const s of [alice, bob, charlie, dave, eve]) {
      await token.transfer(s.address, ethers.parseEther("10000"));
    }

    return { ring, token, owner, alice, bob, charlie, dave, eve };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  function hopId(
    ringId: string,
    index: number,
    sender: string,
    receiver: string
  ): string {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint8", "address", "address"],
      [ringId, index, sender, receiver]
    );
  }

  function newSecret() {
    const preimage = ethers.hexlify(ethers.randomBytes(32));
    const hashlock = ethers.solidityPackedKeccak256(["bytes32"], [preimage]);
    return { preimage, hashlock };
  }

  // ─── 3-Party Ring (A→B→C→A) — ETH ───────────────────────────────────

  describe("3-Party Ring — ETH", function () {
    it("completes full ring settlement", async function () {
      const { ring, alice, bob, charlie } = await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("1");
      const now = await time.latest();

      // hop 0: A→B (60 min), hop 1: B→C (40 min), hop 2: C→A (20 min)
      const h0 = hopId(rId, 0, alice.address, bob.address);
      const h1 = hopId(rId, 1, bob.address, charlie.address);
      const h2 = hopId(rId, 2, charlie.address, alice.address);

      await ring
        .connect(alice)
        .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
          value: amt,
        });
      await ring
        .connect(bob)
        .createHopETH(rId, h1, charlie.address, hashlock, now + 2400, {
          value: amt,
        });
      await ring
        .connect(charlie)
        .createHopETH(rId, h2, alice.address, hashlock, now + 1200, {
          value: amt,
        });

      expect(await ring.getRingHopCount(rId)).to.equal(3);

      // Withdraw all hops with the shared preimage
      await ring.withdraw(h0, preimage);
      await ring.withdraw(h1, preimage);
      await ring.withdraw(h2, preimage);

      expect(await ring.isRingSettled(rId)).to.equal(true);

      // Verify statuses
      expect((await ring.hops(h0)).status).to.equal(2); // WITHDRAWN
      expect((await ring.hops(h1)).status).to.equal(2);
      expect((await ring.hops(h2)).status).to.equal(2);
    });

    it("emits correct events on creation and withdrawal", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("1");
      const now = await time.latest();
      const h0 = hopId(rId, 0, alice.address, bob.address);

      await expect(
        ring
          .connect(alice)
          .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
            value: amt,
          })
      )
        .to.emit(ring, "RingHopCreated")
        .withArgs(
          rId,
          h0,
          alice.address,
          bob.address,
          ethers.ZeroAddress,
          amt,
          hashlock,
          now + 3600
        );

      await expect(ring.withdraw(h0, preimage))
        .to.emit(ring, "HopWithdrawn")
        .withArgs(h0, rId, preimage);
    });

    it("transfers ETH to the correct receiver", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("2");
      const now = await time.latest();
      const h0 = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
          value: amt,
        });

      const bobBefore = await ethers.provider.getBalance(bob.address);
      // Third party calls withdraw — funds still go to bob
      await ring.connect(alice).withdraw(h0, preimage);
      const bobAfter = await ethers.provider.getBalance(bob.address);

      expect(bobAfter - bobBefore).to.equal(amt);
    });
  });

  // ─── 3-Party Ring — ERC20 ────────────────────────────────────────────

  describe("3-Party Ring — ERC20", function () {
    it("completes full settlement with ERC20 tokens", async function () {
      const { ring, token, alice, bob, charlie } =
        await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("100");
      const now = await time.latest();
      const ringAddr = await ring.getAddress();

      const h0 = hopId(rId, 0, alice.address, bob.address);
      const h1 = hopId(rId, 1, bob.address, charlie.address);
      const h2 = hopId(rId, 2, charlie.address, alice.address);

      // Approve & create
      await token.connect(alice).approve(ringAddr, amt);
      await token.connect(bob).approve(ringAddr, amt);
      await token.connect(charlie).approve(ringAddr, amt);

      const tokenAddr = await token.getAddress();
      await ring
        .connect(alice)
        .createHopERC20(rId, h0, bob.address, tokenAddr, amt, hashlock, now + 3600);
      await ring
        .connect(bob)
        .createHopERC20(rId, h1, charlie.address, tokenAddr, amt, hashlock, now + 2400);
      await ring
        .connect(charlie)
        .createHopERC20(rId, h2, alice.address, tokenAddr, amt, hashlock, now + 1200);

      const bobBefore = await token.balanceOf(bob.address);

      await ring.withdraw(h0, preimage);
      await ring.withdraw(h1, preimage);
      await ring.withdraw(h2, preimage);

      expect(await ring.isRingSettled(rId)).to.equal(true);

      // Bob received tokens from hop 0
      const bobAfter = await token.balanceOf(bob.address);
      expect(bobAfter - bobBefore).to.equal(amt);
    });
  });

  // ─── 5-Party Ring (A→B→C→D→E→A) ─────────────────────────────────────

  describe("5-Party Ring", function () {
    it("completes full 5-party ETH settlement", async function () {
      const { ring, alice, bob, charlie, dave, eve } =
        await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("0.5");
      const now = await time.latest();
      const gap = 600; // 10 min between hops

      const participants = [alice, bob, charlie, dave, eve];
      const hopIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        const sender = participants[i];
        const receiver = participants[(i + 1) % 5];
        const tl = now + gap * (5 - i); // 50, 40, 30, 20, 10 min
        const hId = hopId(rId, i, sender.address, receiver.address);
        hopIds.push(hId);

        await ring
          .connect(sender)
          .createHopETH(rId, hId, receiver.address, hashlock, tl, {
            value: amt,
          });
      }

      expect(await ring.getRingHopCount(rId)).to.equal(5);

      for (const hId of hopIds) {
        await ring.withdraw(hId, preimage);
      }

      expect(await ring.isRingSettled(rId)).to.equal(true);
    });

    it("verifies staggered timelocks (first hop longest, last hop shortest)", async function () {
      const { ring, alice, bob, charlie, dave, eve } =
        await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("0.1");
      const now = await time.latest();
      const gap = 600;

      const participants = [alice, bob, charlie, dave, eve];
      const hopIds: string[] = [];
      const timelocks: number[] = [];

      for (let i = 0; i < 5; i++) {
        const sender = participants[i];
        const receiver = participants[(i + 1) % 5];
        const tl = now + gap * (5 - i);
        timelocks.push(tl);
        const hId = hopId(rId, i, sender.address, receiver.address);
        hopIds.push(hId);

        await ring
          .connect(sender)
          .createHopETH(rId, hId, receiver.address, hashlock, tl, {
            value: amt,
          });
      }

      // Verify: each hop's timelock > next hop's timelock
      for (let i = 0; i < 4; i++) {
        const hopI = await ring.hops(hopIds[i]);
        const hopJ = await ring.hops(hopIds[i + 1]);
        expect(hopI.timelock).to.be.gt(hopJ.timelock);
      }
    });
  });

  // ─── Timeout & Refund ────────────────────────────────────────────────

  describe("Timeout & Refund", function () {
    it("allows refund after timelock expiry", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("1");
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 1200, {
          value: amt,
        });

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await time.increase(1201);
      await ring.connect(alice).refund(hId);
      const aliceAfter = await ethers.provider.getBalance(alice.address);

      expect(aliceAfter).to.be.gt(aliceBefore); // got refund minus gas
      expect((await ring.hops(hId)).status).to.equal(3); // REFUNDED
    });

    it("rejects refund before timelock expiry", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 3600, {
          value: ethers.parseEther("1"),
        });

      await expect(ring.refund(hId)).to.be.revertedWith("NotExpired");
    });

    it("prevents withdrawal after refund", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 1200, {
          value: ethers.parseEther("1"),
        });

      await time.increase(1201);
      await ring.refund(hId);

      await expect(ring.withdraw(hId, preimage)).to.be.revertedWith(
        "NotActive"
      );
    });

    it("refunds entire ring when preimage is never revealed", async function () {
      const { ring, alice, bob, charlie } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("1");
      const now = await time.latest();

      const h0 = hopId(rId, 0, alice.address, bob.address);
      const h1 = hopId(rId, 1, bob.address, charlie.address);
      const h2 = hopId(rId, 2, charlie.address, alice.address);

      await ring
        .connect(alice)
        .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
          value: amt,
        });
      await ring
        .connect(bob)
        .createHopETH(rId, h1, charlie.address, hashlock, now + 2400, {
          value: amt,
        });
      await ring
        .connect(charlie)
        .createHopETH(rId, h2, alice.address, hashlock, now + 1200, {
          value: amt,
        });

      // Fast-forward past all timelocks
      await time.increase(3601);

      await ring.refund(h2); // shortest timeout first
      await ring.refund(h1);
      await ring.refund(h0); // longest timeout last

      expect(await ring.isRingSettled(rId)).to.equal(false);

      // All refunded
      expect((await ring.hops(h0)).status).to.equal(3);
      expect((await ring.hops(h1)).status).to.equal(3);
      expect((await ring.hops(h2)).status).to.equal(3);
    });

    it("emits HopRefunded event", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 1200, {
          value: ethers.parseEther("1"),
        });

      await time.increase(1201);

      await expect(ring.refund(hId))
        .to.emit(ring, "HopRefunded")
        .withArgs(hId, rId);
    });
  });

  // ─── Failed Hop Scenarios ────────────────────────────────────────────

  describe("Failed Hop Scenarios", function () {
    it("rejects withdrawal with wrong preimage", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const wrongPreimage = ethers.hexlify(ethers.randomBytes(32));
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 3600, {
          value: ethers.parseEther("1"),
        });

      await expect(ring.withdraw(hId, wrongPreimage)).to.be.revertedWith(
        "BadPreimage"
      );
    });

    it("handles partial ring — funded hops refund after timeout", async function () {
      const { ring, alice, bob, charlie } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const amt = ethers.parseEther("1");
      const now = await time.latest();

      // Only 2 of 3 hops funded (charlie never funds)
      const h0 = hopId(rId, 0, alice.address, bob.address);
      const h1 = hopId(rId, 1, bob.address, charlie.address);

      await ring
        .connect(alice)
        .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
          value: amt,
        });
      await ring
        .connect(bob)
        .createHopETH(rId, h1, charlie.address, hashlock, now + 2400, {
          value: amt,
        });

      expect(await ring.getRingHopCount(rId)).to.equal(2);

      // Coordinator never reveals preimage → everyone refunds
      await time.increase(3601);

      await ring.connect(alice).refund(h0);
      await ring.connect(bob).refund(h1);

      expect((await ring.hops(h0)).status).to.equal(3);
      expect((await ring.hops(h1)).status).to.equal(3);
    });

    it("prevents double withdrawal", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 3600, {
          value: ethers.parseEther("1"),
        });

      await ring.withdraw(hId, preimage);
      await expect(ring.withdraw(hId, preimage)).to.be.revertedWith(
        "NotActive"
      );
    });

    it("prevents duplicate hop creation", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await ring
        .connect(alice)
        .createHopETH(rId, hId, bob.address, hashlock, now + 3600, {
          value: ethers.parseEther("1"),
        });

      await expect(
        ring
          .connect(alice)
          .createHopETH(rId, hId, bob.address, hashlock, now + 3600, {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWith("HopExists");
    });

    it("rejects hop with zero value (ETH)", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await expect(
        ring
          .connect(alice)
          .createHopETH(rId, hId, bob.address, hashlock, now + 3600, {
            value: 0,
          })
      ).to.be.revertedWith("NoValue");
    });

    it("rejects hop with past timelock", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, bob.address);

      await expect(
        ring
          .connect(alice)
          .createHopETH(rId, hId, bob.address, hashlock, now - 100, {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWith("BadTimelock");
    });

    it("rejects hop to zero address", async function () {
      const { ring, alice } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();
      const hId = hopId(rId, 0, alice.address, ethers.ZeroAddress);

      await expect(
        ring
          .connect(alice)
          .createHopETH(rId, hId, ethers.ZeroAddress, hashlock, now + 3600, {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWith("BadReceiver");
    });
  });

  // ─── View Helpers ────────────────────────────────────────────────────

  describe("View Helpers", function () {
    it("computeHopId matches off-chain calculation", async function () {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      const rId = ethers.hexlify(ethers.randomBytes(32));

      const onChain = await ring.computeHopId(rId, 0, alice.address, bob.address);
      const offChain = hopId(rId, 0, alice.address, bob.address);

      expect(onChain).to.equal(offChain);
    });

    it("getRingHopIds returns all hop IDs", async function () {
      const { ring, alice, bob, charlie } = await loadFixture(deployFixture);
      const { hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();

      const h0 = hopId(rId, 0, alice.address, bob.address);
      const h1 = hopId(rId, 1, bob.address, charlie.address);

      await ring
        .connect(alice)
        .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
          value: ethers.parseEther("1"),
        });
      await ring
        .connect(bob)
        .createHopETH(rId, h1, charlie.address, hashlock, now + 2400, {
          value: ethers.parseEther("1"),
        });

      const ids = await ring.getRingHopIds(rId);
      expect(ids).to.deep.equal([h0, h1]);
    });

    it("isRingSettled returns false for partially settled ring", async function () {
      const { ring, alice, bob, charlie } = await loadFixture(deployFixture);
      const { preimage, hashlock } = newSecret();
      const rId = ethers.hexlify(ethers.randomBytes(32));
      const now = await time.latest();

      const h0 = hopId(rId, 0, alice.address, bob.address);
      const h1 = hopId(rId, 1, bob.address, charlie.address);

      await ring
        .connect(alice)
        .createHopETH(rId, h0, bob.address, hashlock, now + 3600, {
          value: ethers.parseEther("1"),
        });
      await ring
        .connect(bob)
        .createHopETH(rId, h1, charlie.address, hashlock, now + 2400, {
          value: ethers.parseEther("1"),
        });

      await ring.withdraw(h0, preimage);

      expect(await ring.isRingSettled(rId)).to.equal(false);
    });
  });
});
