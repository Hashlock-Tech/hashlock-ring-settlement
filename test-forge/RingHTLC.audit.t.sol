// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// AUDIT (Phase 2) - Foundry fuzz/invariant + adversarial tests for RingHTLC.
// Repo had no Foundry config and a single happy-path Hardhat test file.
//
// Post-remediation (audit PR-11): the RING-01/RING-02 tests originally PASSED
// by demonstrating the unsafe behavior. They now assert the SAFE behavior:
//   RING-01 (HL-05): withdraw is bounded by the hop timelock.
//   RING-02 (HL-06): hopId binding is enforced at creation, and isRingSettled
//                    takes the coordinator's expected hop set, so junk hops
//                    under a victim ringId cannot grief settlement detection.

import "forge-std/Test.sol";
import "../contracts/RingHTLC.sol";

contract RingHTLCAuditTest is Test {
    RingHTLC internal htlc;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant PRE = bytes32(uint256(0xC0FFEE));
    bytes32 internal HASH;

    function setUp() public {
        htlc = new RingHTLC();
        HASH = keccak256(abi.encodePacked(PRE));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    /// HL-06: hop IDs are binding-enforced — helper mirrors computeHopId.
    function _hopId(bytes32 ringId, uint8 idx, address sender, address receiver)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(ringId, idx, sender, receiver));
    }

    // ── INV-PRE: preimage soundness ────────────────────────────────────────
    function testFuzz_withdraw_requires_correct_preimage(bytes32 wrongPre) public {
        vm.assume(wrongPre != PRE);
        bytes32 ring = bytes32("ring1");
        bytes32 hopId = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, hopId, 0, bob, HASH, block.timestamp + 1 hours);

        vm.expectRevert(bytes("BadPreimage"));
        htlc.withdraw(hopId, wrongPre);

        // correct preimage works
        uint256 before = bob.balance;
        htlc.withdraw(hopId, PRE);
        assertEq(bob.balance, before + 1 ether, "receiver paid exactly the hop amount");
    }

    // ── INV-NODBL: a hop can never be both withdrawn and refunded ───────────
    function test_no_double_resolve_withdraw_then_refund() public {
        bytes32 ring = bytes32("ring1");
        bytes32 hopId = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, hopId, 0, bob, HASH, block.timestamp + 1 hours);
        htlc.withdraw(hopId, PRE);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        vm.expectRevert(bytes("NotActive"));
        htlc.refund(hopId);
    }

    function test_no_double_resolve_refund_then_withdraw() public {
        bytes32 ring = bytes32("ring1");
        bytes32 hopId = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, hopId, 0, bob, HASH, block.timestamp + 1 hours);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        htlc.refund(hopId);
        vm.expectRevert(bytes("NotActive"));
        htlc.withdraw(hopId, PRE);
    }

    // ── RING-01 / HL-05 FIXED: withdraw is bounded by the hop timelock ──────
    // Pre-fix this test PASSED by demonstrating a successful withdraw AFTER
    // expiry (race window with refund). It now asserts the safe behavior.
    function test_RING01_withdraw_rejected_after_timelock_expiry() public {
        bytes32 ring = bytes32("ring1");
        bytes32 hopId = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, hopId, 0, bob, HASH, block.timestamp + 1 hours);

        vm.warp(block.timestamp + 2 hours); // PAST the timelock

        vm.expectRevert(bytes("Expired"));
        htlc.withdraw(hopId, PRE);

        // and the sender's refund path is intact — temporally exclusive
        uint256 before = alice.balance;
        vm.prank(alice);
        htlc.refund(hopId);
        assertEq(alice.balance, before + 1 ether, "sender refunded after expiry");
    }

    function test_RING01_withdraw_succeeds_before_timelock_expiry() public {
        bytes32 ring = bytes32("ring1");
        bytes32 hopId = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, hopId, 0, bob, HASH, block.timestamp + 1 hours);

        uint256 before = bob.balance;
        htlc.withdraw(hopId, PRE);
        assertEq(bob.balance, before + 1 ether, "withdraw inside the timelock window");
    }

    // ── RING-02 / HL-06 FIXED: membership binding + expected-set settlement ─
    function test_RING02_forged_hopId_rejected_at_creation() public {
        bytes32 ring = bytes32("victim-ring");
        address attacker = address(0xBEEF);
        vm.deal(attacker, 10 ether);

        // Attacker tries to occupy ALICE's expected slot (sender=alice in the
        // binding) — msg.sender is the attacker, so the binding cannot match.
        bytes32 alicesSlot = _hopId(ring, 0, alice, bob);
        vm.prank(attacker);
        vm.expectRevert(bytes("BadHopId"));
        htlc.createHopETH{value: 1 wei}(ring, alicesSlot, 0, bob, HASH, block.timestamp + 1 hours);

        // Arbitrary junk IDs are rejected too.
        vm.prank(attacker);
        vm.expectRevert(bytes("BadHopId"));
        htlc.createHopETH{value: 1 wei}(ring, keccak256("junk"), 0, attacker, HASH, block.timestamp + 1 hours);
    }

    function test_RING02_junk_hop_cannot_grief_expected_set_settlement() public {
        bytes32 ring = bytes32("victim-ring");

        // Legit single-hop ring, withdrawn.
        bytes32 legit = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, legit, 0, bob, HASH, block.timestamp + 1 hours);
        htlc.withdraw(legit, PRE);

        // Mallory creates a hop under the victim's ringId with her OWN valid
        // binding (the only remaining way in) — it lands in _ringHopIds...
        address attacker = address(0xBEEF);
        vm.deal(attacker, 10 ether);
        bytes32 junk = _hopId(ring, 7, attacker, attacker);
        vm.prank(attacker);
        htlc.createHopETH{value: 1 wei}(ring, junk, 7, attacker, keccak256("other"), block.timestamp + 1 hours);
        assertEq(htlc.getRingHopCount(ring), 2, "junk hop exists under the ringId");

        // ...but the coordinator checks ITS expected set — settlement holds.
        bytes32[] memory expected = new bytes32[](1);
        expected[0] = legit;
        assertTrue(htlc.isRingSettled(ring, expected), "HL-06: junk hop no longer griefs settlement");
    }

    function test_RING02_expected_set_rejects_foreign_and_unsettled_hops() public {
        bytes32 ring = bytes32("ring-a");
        bytes32 otherRing = bytes32("ring-b");

        bytes32 hopA = _hopId(ring, 0, alice, bob);
        vm.prank(alice);
        htlc.createHopETH{value: 1 ether}(ring, hopA, 0, bob, HASH, block.timestamp + 1 hours);

        bytes32 hopB = _hopId(otherRing, 0, bob, alice);
        vm.prank(bob);
        htlc.createHopETH{value: 1 ether}(otherRing, hopB, 0, alice, HASH, block.timestamp + 1 hours);
        htlc.withdraw(hopB, PRE);

        // Unsettled hop in the set → false.
        bytes32[] memory setA = new bytes32[](1);
        setA[0] = hopA;
        assertFalse(htlc.isRingSettled(ring, setA), "unsettled hop -> not settled");

        // A WITHDRAWN hop from a DIFFERENT ring cannot be passed off as ours.
        bytes32[] memory setForeign = new bytes32[](1);
        setForeign[0] = hopB;
        assertFalse(htlc.isRingSettled(ring, setForeign), "foreign ring hop -> not settled");

        // Empty expected set is never settled.
        bytes32[] memory empty = new bytes32[](0);
        assertFalse(htlc.isRingSettled(ring, empty), "empty set -> not settled");
    }
}
