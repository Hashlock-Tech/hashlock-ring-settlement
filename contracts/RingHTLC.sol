// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RingHTLC
 * @notice N-party atomic ring settlement using Hashed Timelock Contracts.
 *
 * All hops in a ring share the same hashlock. A single preimage unlocks
 * every hop — either the entire ring settles, or every participant refunds.
 *
 * Timelocks are staggered: the last hop expires first so refunds cascade
 * safely in reverse order if settlement fails. Withdraw is bounded by the
 * hop timelock (audit HL-05), so withdraw and refund are temporally
 * exclusive — the staggered gaps are the window in which earlier hops can
 * still claim after a later hop's preimage reveal.
 *
 * NOTE (informational, audit HL-05): this contract hashes preimages with
 * keccak256; the core HashLock HTLCs (EVM/Sui/BTC) use sha256. A hashlock
 * from the main system will NOT validate here and vice versa — do not
 * compose the two without a hash-function bridge.
 */
contract RingHTLC is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ───────────────────────────────────────────────────────────

    enum HopStatus {
        INVALID,    // 0 — slot never used
        ACTIVE,     // 1 — funded, awaiting preimage or timeout
        WITHDRAWN,  // 2 — receiver claimed with preimage
        REFUNDED    // 3 — sender reclaimed after timeout
    }

    struct Hop {
        bytes32 ringId;
        address sender;
        address receiver;
        address token;      // address(0) = native ETH
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;   // unix timestamp
        HopStatus status;
    }

    // ─── Storage ─────────────────────────────────────────────────────────

    mapping(bytes32 => Hop) public hops;
    mapping(bytes32 => bytes32[]) private _ringHopIds;

    // ─── Events ──────────────────────────────────────────────────────────

    event RingHopCreated(
        bytes32 indexed ringId,
        bytes32 indexed hopId,
        address sender,
        address receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );

    event HopWithdrawn(bytes32 indexed hopId, bytes32 indexed ringId, bytes32 preimage);
    event HopRefunded(bytes32 indexed hopId, bytes32 indexed ringId);

    // ─── Hop Creation ────────────────────────────────────────────────────

    /**
     * @notice Create an ETH-funded hop in a ring.
     * @param ringId    Unique ring identifier (computed off-chain by coordinator)
     * @param hopId     Deterministic hop ID = keccak256(ringId, hopIndex, sender, receiver)
     * @param hopIndex  Position of this hop in the ring (binds hopId — audit HL-06)
     * @param receiver  Address that will receive funds on withdrawal
     * @param hashlock  keccak256(preimage) — shared across all hops in the ring
     * @param timelock  Unix timestamp after which sender can refund
     * @dev   HL-06: hopId is verified against computeHopId(ringId, hopIndex,
     *        msg.sender, receiver), so a hop slot is unforgeable — an outsider
     *        cannot occupy another participant's expected hopId. Combined with
     *        the expected-hop-set form of isRingSettled, junk hops created
     *        under someone else's ringId cannot grief settlement detection.
     */
    function createHopETH(
        bytes32 ringId,
        bytes32 hopId,
        uint8 hopIndex,
        address receiver,
        bytes32 hashlock,
        uint256 timelock
    ) external payable nonReentrant {
        require(msg.value > 0, "NoValue");
        require(receiver != address(0), "BadReceiver");
        require(timelock > block.timestamp, "BadTimelock");
        require(hops[hopId].status == HopStatus.INVALID, "HopExists");
        // HL-06: enforce the deterministic hop ID the docs always promised
        require(
            hopId == keccak256(abi.encodePacked(ringId, hopIndex, msg.sender, receiver)),
            "BadHopId"
        );

        hops[hopId] = Hop({
            ringId: ringId,
            sender: msg.sender,
            receiver: receiver,
            token: address(0),
            amount: msg.value,
            hashlock: hashlock,
            timelock: timelock,
            status: HopStatus.ACTIVE
        });

        _ringHopIds[ringId].push(hopId);

        emit RingHopCreated(ringId, hopId, msg.sender, receiver, address(0), msg.value, hashlock, timelock);
    }

    /**
     * @notice Create an ERC20-funded hop in a ring.
     * @dev    Caller must approve this contract for `amount` of `token` first.
     */
    function createHopERC20(
        bytes32 ringId,
        bytes32 hopId,
        uint8 hopIndex,
        address receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external nonReentrant {
        require(amount > 0, "NoAmount");
        require(receiver != address(0), "BadReceiver");
        require(token != address(0), "UseETH");
        require(timelock > block.timestamp, "BadTimelock");
        require(hops[hopId].status == HopStatus.INVALID, "HopExists");
        // HL-06: enforce the deterministic hop ID (see createHopETH)
        require(
            hopId == keccak256(abi.encodePacked(ringId, hopIndex, msg.sender, receiver)),
            "BadHopId"
        );

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        hops[hopId] = Hop({
            ringId: ringId,
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            status: HopStatus.ACTIVE
        });

        _ringHopIds[ringId].push(hopId);

        emit RingHopCreated(ringId, hopId, msg.sender, receiver, token, amount, hashlock, timelock);
    }

    // ─── Settlement ──────────────────────────────────────────────────────

    /**
     * @notice Withdraw funds from a hop by revealing the preimage.
     * @dev    Anyone can call this — funds always go to the designated receiver.
     *         HL-05: withdraw is bounded by the hop timelock (mirrors the core
     *         EVM/Sui HTLCs), making withdraw and refund temporally exclusive.
     *         Without the bound, both were valid simultaneously after expiry —
     *         a first-tx-wins race that could leave a ring part-WITHDRAWN /
     *         part-REFUNDED. The ring's staggered timelocks are exactly the
     *         windows in which earlier hops can still claim after a reveal.
     */
    function withdraw(bytes32 hopId, bytes32 preimage) external nonReentrant {
        Hop storage hop = hops[hopId];
        require(hop.status == HopStatus.ACTIVE, "NotActive");
        require(block.timestamp < hop.timelock, "Expired");
        require(keccak256(abi.encodePacked(preimage)) == hop.hashlock, "BadPreimage");

        hop.status = HopStatus.WITHDRAWN;

        if (hop.token == address(0)) {
            (bool ok, ) = hop.receiver.call{value: hop.amount}("");
            require(ok, "TransferFailed");
        } else {
            IERC20(hop.token).safeTransfer(hop.receiver, hop.amount);
        }

        emit HopWithdrawn(hopId, hop.ringId, preimage);
    }

    /**
     * @notice Refund a hop after its timelock has expired.
     * @dev    Only the sender can refund.
     */
    function refund(bytes32 hopId) external nonReentrant {
        Hop storage hop = hops[hopId];
        require(hop.status == HopStatus.ACTIVE, "NotActive");
        require(block.timestamp >= hop.timelock, "NotExpired");

        hop.status = HopStatus.REFUNDED;

        if (hop.token == address(0)) {
            (bool ok, ) = hop.sender.call{value: hop.amount}("");
            require(ok, "TransferFailed");
        } else {
            IERC20(hop.token).safeTransfer(hop.sender, hop.amount);
        }

        emit HopRefunded(hopId, hop.ringId);
    }

    // ─── View Helpers ────────────────────────────────────────────────────

    /// @notice Get all hop IDs in a ring
    function getRingHopIds(bytes32 ringId) external view returns (bytes32[] memory) {
        return _ringHopIds[ringId];
    }

    /// @notice Get the number of hops in a ring
    function getRingHopCount(bytes32 ringId) external view returns (uint256) {
        return _ringHopIds[ringId].length;
    }

    /**
     * @notice Check if every EXPECTED hop in the ring has been withdrawn.
     * @param  ringId         The ring to check.
     * @param  expectedHopIds The coordinator's full hop set for this ring
     *                        (deterministic IDs from computeHopId).
     * @dev    HL-06: the previous form iterated every hop ever pushed under a
     *         ringId — an unauthenticated bytes32 — so any outsider could
     *         append a self-funded junk hop and force the result false
     *         forever. The caller now supplies its expected hop set; junk
     *         hops under the same ringId are simply not consulted, and a
     *         forged "expected" hop cannot exist because createHop* binds
     *         hopId to (ringId, hopIndex, sender, receiver).
     */
    function isRingSettled(bytes32 ringId, bytes32[] calldata expectedHopIds)
        external
        view
        returns (bool)
    {
        if (expectedHopIds.length == 0) return false;
        for (uint256 i = 0; i < expectedHopIds.length; i++) {
            Hop storage hop = hops[expectedHopIds[i]];
            if (hop.ringId != ringId) return false;
            if (hop.status != HopStatus.WITHDRAWN) return false;
        }
        return true;
    }

    /// @notice Compute a deterministic hop ID (matches coordinator logic)
    function computeHopId(
        bytes32 ringId,
        uint8 hopIndex,
        address sender,
        address receiver
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ringId, hopIndex, sender, receiver));
    }
}
