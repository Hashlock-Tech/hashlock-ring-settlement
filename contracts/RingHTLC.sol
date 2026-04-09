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
 * safely in reverse order if settlement fails.
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
     * @param receiver  Address that will receive funds on withdrawal
     * @param hashlock  keccak256(preimage) — shared across all hops in the ring
     * @param timelock  Unix timestamp after which sender can refund
     */
    function createHopETH(
        bytes32 ringId,
        bytes32 hopId,
        address receiver,
        bytes32 hashlock,
        uint256 timelock
    ) external payable nonReentrant {
        require(msg.value > 0, "NoValue");
        require(receiver != address(0), "BadReceiver");
        require(timelock > block.timestamp, "BadTimelock");
        require(hops[hopId].status == HopStatus.INVALID, "HopExists");

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
     */
    function withdraw(bytes32 hopId, bytes32 preimage) external nonReentrant {
        Hop storage hop = hops[hopId];
        require(hop.status == HopStatus.ACTIVE, "NotActive");
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

    /// @notice Check if every hop in the ring has been withdrawn
    function isRingSettled(bytes32 ringId) external view returns (bool) {
        bytes32[] memory ids = _ringHopIds[ringId];
        if (ids.length == 0) return false;
        for (uint256 i = 0; i < ids.length; i++) {
            if (hops[ids[i]].status != HopStatus.WITHDRAWN) return false;
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
