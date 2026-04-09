# hashlock-ring-settlement

N-party atomic ring settlement protocol using Hashed Timelock Contracts (HTLCs).

## What is Ring Settlement?

Ring settlement enables **N parties** to atomically swap assets in a circular pattern.
Either **all transfers complete**, or **none do** — no party is left holding the bag.

### Example: 3-party ring

```
    A ───hop 0──→ B
    ↑              │
  hop 2          hop 1
    │              ↓
    └──────────── C
```

- A sends 1 ETH to B
- B sends 100 USDC to C
- C sends 0.5 ETH to A
- **All settle atomically** via a single shared preimage

## How It Works

1. **Coordinator** generates a random preimage and computes `hashlock = keccak256(preimage)`
2. **HTLCs are created** for each hop in the ring, all locked with the same hashlock
3. **Timelocks are staggered**: first hop = longest timeout, last hop = shortest timeout
4. **Once all hops are funded**, the coordinator reveals the preimage
5. **Each receiver withdraws** using the preimage
6. **If any hop fails** to fund before timeout, all funded hops get refunded

### Why Staggered Timelocks?

The last hop expires first, giving earlier senders time to refund if settlement fails.
This prevents a scenario where a later hop's preimage reveal happens after an earlier
hop's timeout has already expired.

```
 hop 0: A → B  ████████████████████████████░░░░ 60 min
 hop 1: B → C  ████████████████████░░░░░░░░░░░░ 40 min
 hop 2: C → A  ████████████░░░░░░░░░░░░░░░░░░░░ 20 min
                ─────────────────────────────────→ time
```

## Project Structure

```
contracts/
  RingHTLC.sol          — Core ring settlement contract (ETH + ERC20)
  mocks/MockERC20.sol   — Test token
src/
  coordinator.ts        — Off-chain ring orchestrator
test/
  RingHTLC.test.ts      — Comprehensive test suite
scripts/
  deploy.ts             — Deployment script
```

## Setup

```bash
npm install
npx hardhat compile
```

## Testing

```bash
npx hardhat test

# With gas reporting
REPORT_GAS=true npx hardhat test
```

### Test Coverage

| Scenario | Description |
|----------|-------------|
| 3-party ETH | A→B→C→A full settlement |
| 3-party ERC20 | Ring with ERC20 tokens |
| 5-party ETH | A→B→C→D→E→A full settlement |
| Staggered timelocks | Verify first hop > last hop |
| Timeout/refund | Refund after expiry |
| Pre-timeout refund rejection | Cannot refund early |
| Post-refund withdrawal rejection | Cannot withdraw after refund |
| Full ring refund | All hops refund when preimage not revealed |
| Wrong preimage | Rejected with BadPreimage |
| Partial ring | Unfunded hops → funded hops refund |
| Double withdrawal | Rejected with NotActive |
| Edge cases | Zero value, past timelock, zero address |

## Usage

### Contract

```solidity
// Create an ETH hop
ringHTLC.createHopETH(ringId, hopId, receiver, hashlock, timelock);

// Create an ERC20 hop (approve first)
token.approve(address(ringHTLC), amount);
ringHTLC.createHopERC20(ringId, hopId, receiver, token, amount, hashlock, timelock);

// Withdraw with preimage
ringHTLC.withdraw(hopId, preimage);

// Refund after timeout
ringHTLC.refund(hopId);

// View helpers
ringHTLC.isRingSettled(ringId);
ringHTLC.getRingHopIds(ringId);
ringHTLC.computeHopId(ringId, hopIndex, sender, receiver);
```

### TypeScript Coordinator

```typescript
import { RingCoordinator } from "./src/coordinator";

const coordinator = new RingCoordinator();

const ring = coordinator.createRing(
  [
    { address: alice, sendAmount: parseEther("1"), sendToken: ZeroAddress },
    { address: bob,   sendAmount: parseEther("100"), sendToken: usdcAddr },
    { address: carol, sendAmount: parseEther("0.5"), sendToken: ZeroAddress },
  ],
  1200,  // 20 min base (shortest hop)
  1200   // 20 min gap between hops
);

// Fund each hop on-chain...
ring.hops.forEach(hop => coordinator.markHopFunded(ring.ringId, hop.hopIndex));

// When all funded, reveal preimage
if (coordinator.canSettle(ring.ringId)) {
  const preimage = coordinator.getPreimage(ring.ringId);
  // Call withdraw(hopId, preimage) for each hop
}
```

## Security

- **ReentrancyGuard** on all state-changing functions
- **SafeERC20** for all token transfers
- **Checks-effects-interactions** pattern throughout
- **Deterministic hop IDs** prevent collision/replay
- Anyone can call `withdraw` but funds always go to the designated receiver

## License

MIT
