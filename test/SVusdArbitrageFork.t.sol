// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SVusdArbitrage} from "../contracts/SVusdArbitrage.sol";
import {IStakingVault} from "../contracts/interfaces/IStakingVault.sol";

interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

/// @dev Two-hop VUSD -> crvUSD -> sVUSD, standing in for the router calldata the bot builds. The
///      arbitrage contract is swap-agnostic: it approves `approveTarget` and calls `target` with
///      opaque calldata, so this helper exercises that path faithfully.
contract CurveTwoHop {
    ICurvePool constant VUSD_CRVUSD = ICurvePool(0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d); // coin0 VUSD, coin1 crvUSD
    ICurvePool constant CRVUSD_SVUSD = ICurvePool(0x659B7B5Dd7936BF2f2d198A87C1583049D1D91d3); // coin0 crvUSD, coin1 sVUSD
    IERC20 constant VUSD = IERC20(0xCa83DDE9c22254f58e771bE5E157773212AcBAc3);
    IERC20 constant CRVUSD = IERC20(0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E);
    IERC20 constant SVUSD = IERC20(0x476310E34D2810f7d79C43A74E4D79405bd7a925);

    function swap(uint256 vusdIn, uint256 minSvusd) external returns (uint256 out) {
        VUSD.transferFrom(msg.sender, address(this), vusdIn);
        VUSD.approve(address(VUSD_CRVUSD), vusdIn);
        uint256 crv = VUSD_CRVUSD.exchange(0, 1, vusdIn, 0);
        CRVUSD.approve(address(CRVUSD_SVUSD), crv);
        out = CRVUSD_SVUSD.exchange(0, 1, crv, minSvusd);
        SVUSD.transfer(msg.sender, out);
    }
}

contract SVusdArbitrageForkTest is Test {
    address constant SVUSD = 0x476310E34D2810f7d79C43A74E4D79405bd7a925;
    address constant VUSD = 0xCa83DDE9c22254f58e771bE5E157773212AcBAc3;

    SVusdArbitrage internal arb;
    CurveTwoHop internal hop;

    address internal owner = address(this);
    address internal keeper = makeAddr("keeper");
    address internal beneficiary = makeAddr("beneficiary");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETHEREUM_RPC_URL", string("https://ethereum-rpc.publicnode.com")));

        arb = new SVusdArbitrage(SVUSD, beneficiary, keeper, owner);
        hop = new CurveTwoHop();
        arb.setAllowedSwapAddress(address(hop), true);
    }

    function _buy(uint256 amount) internal view returns (SVusdArbitrage.SwapParams memory) {
        return SVusdArbitrage.SwapParams({
            target: address(hop),
            approveTarget: address(hop),
            swapCalldata: abi.encodeCall(CurveTwoHop.swap, (amount, 0)),
            minAmountOut: 1
        });
    }

    function test_openThenSettle_roundTrip() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);

        vm.prank(keeper);
        (uint256 requestId, uint256 lockedVusd) = arb.openPosition(amount, _buy(amount), 0);

        assertGt(lockedVusd, 0, "locked vusd > 0");
        assertGe(lockedVusd, arb.entryVusdOf(requestId), "profit floor: locked >= spent");
        assertEq(arb.openRequestCount(), 1, "one open position");
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 0, "vusd fully spent");

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);

        vm.prank(keeper);
        int256 profit = arb.settlePosition(requestId, 0);

        uint256 reserves = IERC20(VUSD).balanceOf(address(arb));
        uint256 pushed = IERC20(VUSD).balanceOf(beneficiary);
        assertEq(arb.openRequestCount(), 0, "position closed");
        assertEq(reserves, amount, "principal recycled back to reserves");
        assertGt(profit, 0, "profitable round trip in vusd terms");
        assertEq(uint256(profit), pushed, "profit pushed to beneficiary");
        // The vault pays exactly what it locked at open: principal kept + profit pushed == locked.
        assertEq(lockedVusd, reserves + pushed, "locked == principal + profit");

        emit log_named_uint("vusd in", amount);
        emit log_named_uint("reserves (principal)", reserves);
        emit log_named_uint("profit pushed to beneficiary", pushed);
        emit log_named_int("profit (18dp)", profit);
    }

    // The profit is fixed at open (both legs are VUSD, known in-tx), so an unmeetable keeper floor
    // reverts before the position is created.
    function test_openPosition_revertsBelowKeeperProfitFloor() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientProfit: demand 500 VUSD profit on a ~1.8% spread
        arb.openPosition(amount, _buy(amount), 500e18);
        assertEq(arb.openRequestCount(), 0, "nothing opened");
    }

    // Owner bps floor is enforced at open too.
    function test_openPosition_revertsBelowOwnerProfitFloor() public {
        arb.setMinProfitBps(1000); // demand >= 10% profit; real spread is ~1.8%
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientProfit
        arb.openPosition(amount, _buy(amount), 0);
    }

    function test_cancelPosition_returnsSharesAndClearsPosition() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);

        // cancel is owner-only; owner == address(this), so no prank.
        uint256 shares = arb.cancelPosition(requestId);

        assertGt(shares, 0, "shares returned");
        assertEq(arb.openRequestCount(), 0, "position cleared");
        assertEq(arb.entryVusdOf(requestId), 0, "cost basis cleared");
        assertEq(IERC20(SVUSD).balanceOf(address(arb)), shares, "sVUSD sits in the contract");
    }

    // Break-glass: the owner can unwind a position directly, without enrolling its key as a keeper.
    function test_cancelPosition_byOwnerBreakGlass() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);

        assertFalse(arb.isKeeper(owner), "owner is not a keeper");
        // owner == address(this): call without a prank.
        uint256 shares = arb.cancelPosition(requestId);
        assertGt(shares, 0, "owner unwound the position");
        assertEq(arb.openRequestCount(), 0, "position cleared");
    }

    // The claim-time floor is now enforced by the contract against the amount locked at open, not
    // just the keeper's minVusdOut_: demanding more than the vault will pay reverts.
    function test_settlePosition_revertsWhenMinVusdOutExceedsPayout() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId, uint256 lockedVusd) = arb.openPosition(amount, _buy(amount), 0);
        assertEq(arb.lockedVusdOf(requestId), lockedVusd, "locked payout stored");

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);

        vm.prank(keeper);
        vm.expectRevert(); // InsufficientOutput: vault pays lockedVusd, we demand more
        arb.settlePosition(requestId, lockedVusd + 1);

        assertEq(arb.openRequestCount(), 1, "position still open after failed claim");
    }

    // If the vault ever underpays a matured request, the keeper stays bound by the locked floor
    // (settle reverts); recovery is the owner's break-glass cancel, which salvages the shares whole.
    function test_settlePosition_underpayRevertsThenOwnerCancels() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);

        // Simulate underpayment: claimWithdraw returns but moves no VUSD, so vusdOut == 0 < lockedVusd.
        vm.mockCall(
            SVUSD,
            abi.encodeWithSelector(IStakingVault.claimWithdraw.selector, requestId, address(arb)),
            abi.encode(uint256(0))
        );

        vm.prank(keeper);
        vm.expectRevert(); // keeper is held to the locked floor
        arb.settlePosition(requestId, 0);
        assertEq(arb.openRequestCount(), 1, "position still open after keeper revert");

        // Recovery: owner cancels (hits cancelWithdraw, not the mocked claim) and salvages the shares.
        vm.clearMockedCalls();
        uint256 shares = arb.cancelPosition(requestId); // owner == address(this)
        assertGt(shares, 0, "owner salvaged the shares");
        assertEq(arb.openRequestCount(), 0, "position closed via owner cancel");
    }

    // Cancel (owner break-glass) works even AFTER the cooldown matures, so a stuck position is always
    // recoverable as shares, distinct from the keeper's settle-to-VUSD path.
    function test_cancelPosition_worksAfterMaturity() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);

        // owner == address(this): no prank.
        uint256 shares = arb.cancelPosition(requestId);
        assertGt(shares, 0, "matured request cancellable");
        assertEq(arb.openRequestCount(), 0, "position cleared");
        assertEq(IERC20(SVUSD).balanceOf(address(arb)), shares, "sVUSD returned to contract");
    }

    // Access split: keeper runs the loop (open + settle); owner alone holds break-glass cancel. Neither
    // can do the other's job.
    function test_settlePosition_revertsForOwner() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);
        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);

        // owner == address(this): settle is keeper-only.
        vm.expectRevert(SVusdArbitrage.NotKeeper.selector);
        arb.settlePosition(requestId, 0);
        assertEq(arb.openRequestCount(), 1, "owner cannot settle");
    }

    function test_cancelPosition_revertsForKeeper() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);

        vm.prank(keeper);
        vm.expectRevert(); // OwnableUnauthorizedAccount: cancel is owner-only
        arb.cancelPosition(requestId);
        assertEq(arb.openRequestCount(), 1, "keeper cannot cancel");
    }

    function test_settleReverts_beforeCooldown() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);

        vm.prank(keeper);
        vm.expectRevert();
        arb.settlePosition(requestId, 0);
    }

    // H-1 regression: the arbitrary swap call cannot reach an unvetted target, so a compromised
    // keeper cannot redirect reserves. Pointing the swap at VUSD to transfer reserves out reverts.
    function test_openPosition_revertsForUnvettedSwapAddress() public {
        deal(VUSD, address(arb), 1_000e18);
        SVusdArbitrage.SwapParams memory evil = SVusdArbitrage.SwapParams({
            target: VUSD,
            approveTarget: VUSD,
            swapCalldata: abi.encodeWithSignature("transfer(address,uint256)", stranger, uint256(1_000e18)),
            minAmountOut: 0
        });
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.SwapAddressNotAllowed.selector, VUSD));
        arb.openPosition(1_000e18, evil, 0);
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 1_000e18, "reserves untouched");
    }

    function test_setAllowedSwapAddress_rejectsProtected() public {
        vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.ProtectedSwapAddress.selector, VUSD));
        arb.setAllowedSwapAddress(VUSD, true);
        vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.ProtectedSwapAddress.selector, SVUSD));
        arb.setAllowedSwapAddress(SVUSD, true);
    }

    function test_openPosition_revertsForNonKeeper() public {
        SVusdArbitrage.SwapParams memory buy = _buy(1);
        vm.prank(stranger);
        vm.expectRevert(SVusdArbitrage.NotKeeper.selector);
        arb.openPosition(1, buy, 0);
    }

    // `sweep` is owner-only (wind-down / stray-token rescue), to any address. Keeper and other
    // non-owners have no withdrawal power at all: profit already auto-exits at claim.
    function test_sweep_onlyOwner() public {
        deal(VUSD, address(arb), 100e18);

        vm.prank(stranger);
        vm.expectRevert();
        arb.sweep(VUSD, stranger, 100e18);

        vm.prank(keeper);
        vm.expectRevert();
        arb.sweep(VUSD, keeper, 100e18);

        arb.sweep(VUSD, stranger, 40e18); // owner
        assertEq(IERC20(VUSD).balanceOf(stranger), 40e18, "owner swept to chosen address");
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 60e18, "remainder stays");
    }

    // Profit is pushed to whatever beneficiary is current at claim time; owner-only to change.
    function test_setBeneficiary_routesProfit() public {
        address newBeneficiary = makeAddr("newBeneficiary");

        vm.prank(stranger);
        vm.expectRevert();
        arb.setBeneficiary(newBeneficiary);

        arb.setBeneficiary(newBeneficiary);
        assertEq(arb.beneficiary(), newBeneficiary, "beneficiary updated");

        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 requestId,) = arb.openPosition(amount, _buy(amount), 0);
        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);
        vm.prank(keeper);
        int256 profit = arb.settlePosition(requestId, 0);

        assertGt(profit, 0, "profitable");
        assertEq(IERC20(VUSD).balanceOf(newBeneficiary), uint256(profit), "profit routed to new beneficiary");
        assertEq(IERC20(VUSD).balanceOf(beneficiary), 0, "old beneficiary got nothing");
    }
}
