import { ethers } from "ethers";
import { randomBytes } from "crypto";

// ─── Types ───────────────────────────────────────────────────────────────

export interface RingParticipant {
  /** Wallet address of this participant */
  address: string;
  /** Amount this participant sends (in wei / smallest unit) */
  sendAmount: bigint;
  /** Token address — use ethers.ZeroAddress for native ETH */
  sendToken: string;
}

export enum HopStatus {
  PENDING = "PENDING",
  FUNDED = "FUNDED",
  WITHDRAWN = "WITHDRAWN",
  REFUNDED = "REFUNDED",
}

export enum RingStatus {
  CREATED = "CREATED",
  FUNDING = "FUNDING",
  FUNDED = "FUNDED",
  SETTLING = "SETTLING",
  SETTLED = "SETTLED",
  EXPIRED = "EXPIRED",
}

export interface RingHop {
  hopIndex: number;
  hopId: string;
  sender: string;
  receiver: string;
  amount: bigint;
  token: string;
  timelock: number;
  status: HopStatus;
}

export interface Ring {
  ringId: string;
  preimage: string;
  hashlock: string;
  hops: RingHop[];
  status: RingStatus;
  createdAt: number;
}

// ─── Coordinator ─────────────────────────────────────────────────────────

export class RingCoordinator {
  private rings: Map<string, Ring> = new Map();

  /**
   * Create a ring from an ordered list of participants.
   *
   * participants[i] sends to participants[(i+1) % N], forming a cycle.
   *
   * Timelock strategy (linear decay):
   *   hop 0 (first):  now + baseTimelock + hopGap × (N-1)   ← longest
   *   hop N-1 (last): now + baseTimelock                     ← shortest
   *
   * @param participants  Ordered ring members
   * @param baseTimelock  Seconds from now for the shortest (last) hop
   * @param hopGap        Additional seconds per hop going backward
   */
  createRing(
    participants: RingParticipant[],
    baseTimelock: number,
    hopGap: number
  ): Ring {
    if (participants.length < 2) {
      throw new Error("Ring must have at least 2 participants");
    }

    const preimage = "0x" + randomBytes(32).toString("hex");
    const hashlock = ethers.solidityPackedKeccak256(["bytes32"], [preimage]);
    const ringId = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256"],
      [hashlock, Date.now()]
    );

    const n = participants.length;
    const now = Math.floor(Date.now() / 1000);
    const hops: RingHop[] = [];

    for (let i = 0; i < n; i++) {
      const sender = participants[i];
      const receiver = participants[(i + 1) % n];
      const timelock = now + baseTimelock + hopGap * (n - 1 - i);

      const hopId = ethers.solidityPackedKeccak256(
        ["bytes32", "uint8", "address", "address"],
        [ringId, i, sender.address, receiver.address]
      );

      hops.push({
        hopIndex: i,
        hopId,
        sender: sender.address,
        receiver: receiver.address,
        amount: sender.sendAmount,
        token: sender.sendToken,
        timelock,
        status: HopStatus.PENDING,
      });
    }

    const ring: Ring = {
      ringId,
      preimage,
      hashlock,
      hops,
      status: RingStatus.CREATED,
      createdAt: now,
    };

    this.rings.set(ringId, ring);
    return ring;
  }

  /** Mark a hop as funded after the on-chain tx confirms. */
  markHopFunded(ringId: string, hopIndex: number): void {
    const ring = this._getRing(ringId);
    ring.hops[hopIndex].status = HopStatus.FUNDED;
    ring.status = ring.hops.every((h) => h.status === HopStatus.FUNDED)
      ? RingStatus.FUNDED
      : RingStatus.FUNDING;
  }

  /** Mark a hop as withdrawn after on-chain withdrawal. */
  markHopWithdrawn(ringId: string, hopIndex: number): void {
    const ring = this._getRing(ringId);
    ring.hops[hopIndex].status = HopStatus.WITHDRAWN;
    ring.status = ring.hops.every((h) => h.status === HopStatus.WITHDRAWN)
      ? RingStatus.SETTLED
      : RingStatus.SETTLING;
  }

  /** Mark a hop as refunded. */
  markHopRefunded(ringId: string, hopIndex: number): void {
    const ring = this._getRing(ringId);
    ring.hops[hopIndex].status = HopStatus.REFUNDED;
    if (ring.hops.every((h) => h.status === HopStatus.REFUNDED)) {
      ring.status = RingStatus.EXPIRED;
    }
  }

  /** True when every hop is funded and the preimage can safely be revealed. */
  canSettle(ringId: string): boolean {
    return this._getRing(ringId).status === RingStatus.FUNDED;
  }

  /**
   * Get the preimage — only when the ring is fully funded.
   * @throws if ring is not fully funded
   */
  getPreimage(ringId: string): string {
    if (!this.canSettle(ringId)) {
      throw new Error("Ring not fully funded — cannot reveal preimage");
    }
    return this._getRing(ringId).preimage;
  }

  /** Get ring by ID. */
  getRing(ringId: string): Ring {
    return this._getRing(ringId);
  }

  /** List all tracked rings. */
  getAllRings(): Ring[] {
    return Array.from(this.rings.values());
  }

  /** Return funded hops whose timelocks have expired (eligible for refund). */
  getExpiredHops(ringId: string): RingHop[] {
    const ring = this._getRing(ringId);
    const now = Math.floor(Date.now() / 1000);
    return ring.hops.filter(
      (h) => h.status === HopStatus.FUNDED && h.timelock <= now
    );
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private _getRing(ringId: string): Ring {
    const ring = this.rings.get(ringId);
    if (!ring) throw new Error(`Ring ${ringId} not found`);
    return ring;
  }
}
