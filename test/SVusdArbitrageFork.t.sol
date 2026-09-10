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

/// @dev A rogue swap target: pulls VUSD from the caller and returns `giveSvusd` sVUSD (or none),
///      standing in for a keeper trying to skim reserves through an arbitrary swap target.
contract MaliciousRouter {
    IERC20 constant VUSD = IERC20(0xCa83DDE9c22254f58e771bE5E157773212AcBAc3);
    IERC20 constant SVUSD = IERC20(0x476310E34D2810f7d79C43A74E4D79405bd7a925);

    function skim(uint256 pull, uint256 giveSvusd) external {
        VUSD.transferFrom(msg.sender, address(this), pull);
        if (giveSvusd > 0) SVUSD.transfer(msg.sender, giveSvusd);
    }
}

/// @dev A swap target that re-enters `openPosition` mid-swap, to prove the `nonReentrant` guard fires.
contract ReentrantRouter {
    SVusdArbitrage internal immutable arb;

    constructor(SVusdArbitrage arb_) {
        arb = arb_;
    }

    function swap() external {
        SVusdArbitrage.SwapParams memory inner = SVusdArbitrage.SwapParams({
            target: address(this), approveTarget: address(this), swapCalldata: "", minAmountOut: 0
        });
        arb.openPosition(1, inner, 0); // re-enter while the outer call holds the guard
    }
}

/// @dev The approved spender, distinct from the called target: the arb approves this contract, and the
///      router (below) drives it to pull the VUSD. Exercises the `approveTarget != target` path.
contract SplitSpender {
    IERC20 constant VUSD = IERC20(0xCa83DDE9c22254f58e771bE5E157773212AcBAc3);

    function pull(address from, uint256 amount) external {
        VUSD.transferFrom(from, msg.sender, amount);
    }
}

/// @dev The called target, distinct from the approved spender. The arb calls this; it tells the spender
///      to pull the VUSD (using the spender's allowance) and then delivers sVUSD.
contract SplitRouter {
    IERC20 constant SVUSD = IERC20(0x476310E34D2810f7d79C43A74E4D79405bd7a925);
    SplitSpender internal immutable spender;

    constructor(SplitSpender spender_) {
        spender = spender_;
    }

    function swap(uint256 vusdIn, uint256 giveSvusd) external {
        spender.pull(msg.sender, vusdIn);
        SVUSD.transfer(msg.sender, giveSvusd);
    }
}

/// @dev Drives `openPosition` (the only path that grants a swap allowance) across its success and
///      revert branches, so the invariant can assert no allowance ever survives a call. The router
///      pulls less than the approved ceiling, so a missing reset would leave a residual the check trips.
contract AllowanceInvariantHandler is Test {
    SVusdArbitrage internal immutable arb;
    MaliciousRouter internal immutable router;
    address internal immutable keeper;
    address internal immutable vusd;
    address internal immutable svusd;

    constructor(SVusdArbitrage arb_, MaliciousRouter router_, address keeper_, address vusd_, address svusd_) {
        arb = arb_;
        router = router_;
        keeper = keeper_;
        vusd = vusd_;
        svusd = svusd_;
    }

    function open(uint256 ceiling, uint256 spend, uint256 shares) external {
        ceiling = bound(ceiling, 2e18, 5_000e18);
        spend = bound(spend, 1e18, ceiling);
        shares = bound(shares, 0, 6_000e18);
        deal(vusd, address(arb), ceiling);
        deal(svusd, address(router), shares);
        SVusdArbitrage.SwapParams memory buy = SVusdArbitrage.SwapParams({
            target: address(router),
            approveTarget: address(router),
            swapCalldata: abi.encodeCall(MaliciousRouter.skim, (spend, shares)),
            minAmountOut: 0
        });
        vm.prank(keeper);
        try arb.openPosition(ceiling, buy, 0) {} catch {}
    }
}

contract SVusdArbitrageForkTest is Test {
    address constant SVUSD = 0x476310E34D2810f7d79C43A74E4D79405bd7a925;
    address constant VUSD = 0xCa83DDE9c22254f58e771bE5E157773212AcBAc3;
    address constant CRVUSD = 0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E;
    address constant CURVE_ROUTER = 0x16C6521Dff6baB339122a0FE25a9116693265353;
    address constant POOL_VUSD_CRVUSD = 0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d;
    address constant POOL_CRVUSD_SVUSD = 0x659B7B5Dd7936BF2f2d198A87C1583049D1D91d3;

    SVusdArbitrage internal arb;
    CurveTwoHop internal hop;
    MaliciousRouter internal invariantRouter;
    AllowanceInvariantHandler internal allowanceHandler;

    address internal owner = address(this);
    address internal keeper = makeAddr("keeper");
    address internal beneficiary = makeAddr("beneficiary");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETHEREUM_RPC_URL", string("https://ethereum-rpc.publicnode.com")));

        arb = new SVusdArbitrage(SVUSD, beneficiary, keeper, owner);
        hop = new CurveTwoHop();

        invariantRouter = new MaliciousRouter();
        allowanceHandler = new AllowanceInvariantHandler(arb, invariantRouter, keeper, VUSD, SVUSD);
        targetContract(address(allowanceHandler));
    }

    function _buy(uint256 amount) internal view returns (SVusdArbitrage.SwapParams memory) {
        return SVusdArbitrage.SwapParams({
            target: address(hop),
            approveTarget: address(hop),
            swapCalldata: abi.encodeCall(CurveTwoHop.swap, (amount, 0)),
            minAmountOut: 1
        });
    }

    /// @dev The exact SwapParams the TS `buildEntrySwap` emits; mirrors src/constants.ts.
    function _routerBuy(uint256 amount, uint256 minOut, address receiver)
        internal
        pure
        returns (SVusdArbitrage.SwapParams memory)
    {
        address[11] memory route;
        route[0] = VUSD;
        route[1] = POOL_VUSD_CRVUSD;
        route[2] = CRVUSD;
        route[3] = POOL_CRVUSD_SVUSD;
        route[4] = SVUSD;

        uint256[5][5] memory sp;
        sp[0] = [uint256(0), 1, 1, 1, 2]; // VUSD -> crvUSD
        sp[1] = [uint256(0), 1, 1, 1, 2]; // crvUSD -> sVUSD

        address[5] memory pools;
        pools[0] = POOL_VUSD_CRVUSD;
        pools[1] = POOL_CRVUSD_SVUSD;

        bytes memory data = abi.encodeWithSignature(
            "exchange(address[11],uint256[5][5],uint256,uint256,address[5],address)",
            route,
            sp,
            amount,
            minOut,
            pools,
            receiver
        );
        return SVusdArbitrage.SwapParams({
            target: CURVE_ROUTER, approveTarget: CURVE_ROUTER, swapCalldata: data, minAmountOut: minOut
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
        int256 profit = arb.settlePosition(requestId);

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

    // Production path: real router, calldata built as the bot builds it, open through settle.
    function test_openThenSettle_viaCurveRouter() public {
        uint256 amount = 5_000e18;
        deal(VUSD, address(arb), amount);

        vm.prank(keeper);
        (uint256 requestId, uint256 lockedVusd) = arb.openPosition(amount, _routerBuy(amount, 1, address(arb)), 0);

        assertGt(lockedVusd, 0, "locked vusd > 0");
        assertGe(lockedVusd, arb.entryVusdOf(requestId), "profit floor: locked >= spent");
        assertEq(arb.openRequestCount(), 1, "one open position");
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 0, "vusd fully spent through the router");

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(requestId);
        vm.warp(details.claimableAt + 1);

        vm.prank(keeper);
        int256 profit = arb.settlePosition(requestId);

        assertGt(profit, 0, "profitable round trip via real router");
        assertEq(IERC20(VUSD).balanceOf(address(arb)), amount, "principal recycled to reserves");
        assertEq(uint256(profit), IERC20(VUSD).balanceOf(beneficiary), "profit pushed to beneficiary");
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
        arb.settlePosition(requestId);
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
        arb.settlePosition(requestId);
        assertEq(arb.openRequestCount(), 1, "owner cannot settle");
    }

    // settlePosition is the strict, explicit path: naming an id we never opened reverts (the batch, by
    // contrast, skips untracked ids). Pins the membership revert that now lives in settlePosition.
    function test_settlePosition_revertsForUnknownId() public {
        uint256 unknownId = 999_999;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.UnknownRequest.selector, unknownId));
        arb.settlePosition(unknownId);
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
        arb.settlePosition(requestId);
    }

    // settleClaimablePositions: the vault reports our matured ids, so the keeper batch-settles in one
    // call with no id list. Two positions open, both matured, both settled at once.
    function test_settleClaimablePositions_settlesAllMatured() public {
        // Two small buys so the second still clears the floor after the first's price impact.
        uint256 amount = 500e18;
        deal(VUSD, address(arb), 2 * amount);

        vm.startPrank(keeper);
        (uint256 id1,) = arb.openPosition(amount, _buy(amount), 0);
        arb.openPosition(amount, _buy(amount), 0);
        vm.stopPrank();
        assertEq(arb.openRequestCount(), 2, "two open positions");

        // Both opened in the same block, so one claimableAt matures the whole set.
        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(id1);
        vm.warp(details.claimableAt + 1);

        vm.prank(keeper);
        (uint256 settled, int256 totalProfit) = arb.settleClaimablePositions(type(uint256).max); // all
        assertEq(settled, 2, "both settled in one call");
        assertGt(totalProfit, 0, "aggregate profit reported");
        assertEq(arb.openRequestCount(), 0, "all positions closed");
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 2 * amount, "principal recycled to reserves");
        // Single transfer: the beneficiary balance equals the aggregate profit exactly.
        assertEq(uint256(totalProfit), IERC20(VUSD).balanceOf(beneficiary), "profit pushed once, in aggregate");
    }

    // All-or-nothing: if one matured id underpays (reverts the locked floor), the whole batch reverts
    // and BOTH positions stay open. This is the property the TS per-id fallback rests on.
    function test_settleClaimablePositions_oneUnderpayRevertsWholeBatch() public {
        uint256 amount = 500e18;
        deal(VUSD, address(arb), 2 * amount);

        vm.startPrank(keeper);
        (uint256 id1,) = arb.openPosition(amount, _buy(amount), 0);
        arb.openPosition(amount, _buy(amount), 0);
        vm.stopPrank();
        assertEq(arb.openRequestCount(), 2, "two open positions");

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(id1);
        vm.warp(details.claimableAt + 1);

        // One matured id underpays: claimWithdraw moves no VUSD, so vusdOut == 0 < lockedVusd and _settle
        // reverts. The healthy id must roll back with it.
        vm.mockCall(
            SVUSD,
            abi.encodeWithSelector(IStakingVault.claimWithdraw.selector, id1, address(arb)),
            abi.encode(uint256(0))
        );

        vm.prank(keeper);
        vm.expectRevert();
        arb.settleClaimablePositions(type(uint256).max);

        vm.clearMockedCalls();
        assertEq(arb.openRequestCount(), 2, "both positions remain open after batch revert");
        assertEq(IERC20(VUSD).balanceOf(beneficiary), 0, "no profit pushed");
    }

    // maxCount bounds the batch: with two matured, settleClaimablePositions(1) settles one and leaves one.
    function test_settleClaimablePositions_respectsMaxCount() public {
        // Two small buys so the second still clears the floor after the first's price impact.
        uint256 amount = 500e18;
        deal(VUSD, address(arb), 2 * amount);

        vm.startPrank(keeper);
        (uint256 id1,) = arb.openPosition(amount, _buy(amount), 0);
        arb.openPosition(amount, _buy(amount), 0);
        vm.stopPrank();

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(id1);
        vm.warp(details.claimableAt + 1);

        vm.prank(keeper);
        (uint256 settled,) = arb.settleClaimablePositions(1);
        assertEq(settled, 1, "capped at maxCount");
        assertEq(arb.openRequestCount(), 1, "one position still open");
    }

    // A no-op when nothing has matured: the vault reports no claimable ids, so nothing settles.
    function test_settleClaimablePositions_noMaturedIsNoOp() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        arb.openPosition(amount, _buy(amount), 0);

        vm.prank(keeper);
        (uint256 settled, int256 totalProfit) = arb.settleClaimablePositions(type(uint256).max);
        assertEq(settled, 0, "nothing claimable yet");
        assertEq(totalProfit, 0, "no profit when nothing settles");
        assertEq(arb.openRequestCount(), 1, "position still open");
    }

    // maxCount is a real cap now (no 0-means-all sentinel): 0 settles nothing even when matured.
    function test_settleClaimablePositions_zeroMaxCountSettlesNothing() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        (uint256 id,) = arb.openPosition(amount, _buy(amount), 0);

        IStakingVault.CooldownRequest memory details = IStakingVault(SVUSD).getRequestDetails(id);
        vm.warp(details.claimableAt + 1);

        vm.prank(keeper);
        (uint256 settled,) = arb.settleClaimablePositions(0);
        assertEq(settled, 0, "maxCount 0 settles nothing");
        assertEq(arb.openRequestCount(), 1, "matured position left open");
    }

    // Batch settle is keeper-only, same as the single path.
    function test_settleClaimablePositions_revertsForOwner() public {
        vm.expectRevert(SVusdArbitrage.NotKeeper.selector); // owner == address(this)
        arb.settleClaimablePositions(0);
    }

    // ── Swap envelope: fund safety rests on the scoped-and-reset approval, the mandatory sVUSD
    //    output, and the profit floor. These exercise it against a hostile swap target.

    // A target that transfers reserves out yields no sVUSD, so NoSharesBought fires and the transfer
    // rolls back.
    // A keeper aiming the swap at VUSD itself to sweep reserves is rejected by the denylist before
    // any approval or call, so the reserves never move.
    function test_openPosition_maliciousVusdTransfer_reverts() public {
        deal(VUSD, address(arb), 1_000e18);
        SVusdArbitrage.SwapParams memory evil = SVusdArbitrage.SwapParams({
            target: VUSD,
            approveTarget: VUSD,
            swapCalldata: abi.encodeWithSignature("transfer(address,uint256)", stranger, uint256(1_000e18)),
            minAmountOut: 0
        });
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.ProtectedSwapTarget.selector, VUSD));
        arb.openPosition(1_000e18, evil, 0);
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 1_000e18, "reserves untouched");
    }

    // The denylist covers both the call target and the approve target, for the vault, the reserve
    // token, and self: a swap can never be pointed at our own contracts.
    function test_openPosition_rejectsProtectedSwapTargets() public {
        deal(VUSD, address(arb), 1_000e18);
        address[3] memory protectedAddrs = [SVUSD, VUSD, address(arb)];
        for (uint256 i; i < protectedAddrs.length; ++i) {
            address bad = protectedAddrs[i];
            SVusdArbitrage.SwapParams memory badTarget = SVusdArbitrage.SwapParams({
                target: bad, approveTarget: address(hop), swapCalldata: "", minAmountOut: 0
            });
            vm.prank(keeper);
            vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.ProtectedSwapTarget.selector, bad));
            arb.openPosition(1_000e18, badTarget, 0);

            SVusdArbitrage.SwapParams memory badApprove = SVusdArbitrage.SwapParams({
                target: address(hop), approveTarget: bad, swapCalldata: "", minAmountOut: 0
            });
            vm.prank(keeper);
            vm.expectRevert(abi.encodeWithSelector(SVusdArbitrage.ProtectedSwapTarget.selector, bad));
            arb.openPosition(1_000e18, badApprove, 0);
        }
    }

    // A rogue router that takes the VUSD but delivers no sVUSD → NoSharesBought, reserves rolled back.
    function test_openPosition_rogueRouterNoShares_reverts() public {
        MaliciousRouter evil = new MaliciousRouter();
        deal(VUSD, address(arb), 1_000e18);
        SVusdArbitrage.SwapParams memory buy = SVusdArbitrage.SwapParams({
            target: address(evil),
            approveTarget: address(evil),
            swapCalldata: abi.encodeCall(MaliciousRouter.skim, (1_000e18, 0)),
            minAmountOut: 0
        });
        vm.prank(keeper);
        vm.expectRevert(SVusdArbitrage.NoSharesBought.selector);
        arb.openPosition(1_000e18, buy, 0);
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 1_000e18, "reserves untouched");
    }

    // A rogue router that under-delivers sVUSD (10 sVUSD for 1000 VUSD) → InsufficientProfit, rolled back.
    function test_openPosition_rogueRouterUnderpays_reverts() public {
        MaliciousRouter evil = new MaliciousRouter();
        deal(VUSD, address(arb), 1_000e18);
        deal(SVUSD, address(evil), 10e18); // the pittance it hands back
        SVusdArbitrage.SwapParams memory buy = SVusdArbitrage.SwapParams({
            target: address(evil),
            approveTarget: address(evil),
            swapCalldata: abi.encodeCall(MaliciousRouter.skim, (1_000e18, 10e18)),
            minAmountOut: 1
        });
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientProfit: 10 sVUSD redeems well under the 1000 VUSD floor
        arb.openPosition(1_000e18, buy, 0);
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 1_000e18, "reserves untouched");
    }

    // A router that tries to pull MORE than approved is stopped by the scoped allowance, not a limit.
    function test_openPosition_rogueRouterOverPull_reverts() public {
        MaliciousRouter evil = new MaliciousRouter();
        deal(VUSD, address(arb), 1_000e18);
        SVusdArbitrage.SwapParams memory buy = SVusdArbitrage.SwapParams({
            target: address(evil),
            approveTarget: address(evil),
            swapCalldata: abi.encodeCall(MaliciousRouter.skim, (1_000e18, 0)), // pull 1000...
            minAmountOut: 0
        });
        vm.prank(keeper);
        vm.expectRevert(); // ...but only 500 approved → transferFrom reverts on allowance
        arb.openPosition(500e18, buy, 0);
        assertEq(IERC20(VUSD).balanceOf(address(arb)), 1_000e18, "reserves untouched");
    }

    // A swap can't move a token the contract merely holds and never approved: with no VUSD leg,
    // ZeroAmount reverts and the transfer rolls back. (Only VUSD/sVUSD deltas are measured; safety
    // here is the absence of any other approval, not the delta gate.)
    function test_openPosition_cannotDrainStrayToken() public {
        deal(VUSD, address(arb), 1_000e18);
        deal(CRVUSD, address(arb), 1_000e18);
        SVusdArbitrage.SwapParams memory evil = SVusdArbitrage.SwapParams({
            target: CRVUSD,
            approveTarget: CRVUSD,
            swapCalldata: abi.encodeWithSignature("transfer(address,uint256)", stranger, uint256(1_000e18)),
            minAmountOut: 0
        });
        vm.prank(keeper);
        vm.expectRevert(SVusdArbitrage.ZeroAmount.selector);
        arb.openPosition(1_000e18, evil, 0);
        assertEq(IERC20(CRVUSD).balanceOf(address(arb)), 1_000e18, "stray token untouched");
    }

    // Future-feature guard: after a swap the contract must hold no standing VUSD allowance to the
    // target. A new code path that forgot to reset an approval would trip this.
    function test_openPosition_leavesNoStandingAllowance() public {
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        vm.prank(keeper);
        arb.openPosition(amount, _buy(amount), 0);
        assertEq(IERC20(VUSD).allowance(address(arb), address(hop)), 0, "swap allowance reset to 0");
    }

    // A swap target that re-enters openPosition mid-call is stopped by nonReentrant. The router is a
    // keeper so the re-entry clears onlyKeeper and actually reaches the guard (worst-case caller).
    function test_openPosition_reentrancyReverts() public {
        ReentrantRouter evil = new ReentrantRouter(arb);
        arb.addKeeper(address(evil));
        deal(VUSD, address(arb), 1_000e18);
        SVusdArbitrage.SwapParams memory buy = SVusdArbitrage.SwapParams({
            target: address(evil),
            approveTarget: address(evil),
            swapCalldata: abi.encodeCall(ReentrantRouter.swap, ()),
            minAmountOut: 0
        });
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        arb.openPosition(1_000e18, buy, 0);
    }

    // approveTarget != target: the arb approves the spender but calls the router; the buy still works
    // and leaves no allowance to the spender (the reset targets approveTarget, not target).
    function test_openPosition_distinctApproveTarget() public {
        SplitSpender spender = new SplitSpender();
        SplitRouter router = new SplitRouter(spender);
        uint256 amount = 2_000e18;
        deal(VUSD, address(arb), amount);
        deal(SVUSD, address(router), amount); // sVUSD to deliver; pps >= 1 clears the profit floor

        SVusdArbitrage.SwapParams memory buy = SVusdArbitrage.SwapParams({
            target: address(router),
            approveTarget: address(spender),
            swapCalldata: abi.encodeCall(SplitRouter.swap, (amount, amount)),
            minAmountOut: 1
        });
        vm.prank(keeper);
        (uint256 requestId, uint256 lockedVusd) = arb.openPosition(amount, buy, 0);

        assertGt(lockedVusd, 0, "opened via split approve/target");
        assertEq(arb.entryVusdOf(requestId), amount, "spent measured on the VUSD delta");
        assertEq(IERC20(VUSD).allowance(address(arb), address(spender)), 0, "spender allowance reset");
        assertEq(IERC20(VUSD).allowance(address(arb), address(router)), 0, "router never approved");
    }

    // No sequence of opens leaves a standing swap allowance; the reset is the only thing zeroing the
    // residual the handler's router leaves by pulling less than the approved ceiling.
    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 8
    function invariant_noStandingSwapAllowance() public view {
        assertEq(IERC20(VUSD).allowance(address(arb), address(invariantRouter)), 0, "no standing swap allowance");
        assertEq(IERC20(VUSD).allowance(address(arb), address(arb)), 0, "no self allowance");
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
        int256 profit = arb.settlePosition(requestId);

        assertGt(profit, 0, "profitable");
        assertEq(IERC20(VUSD).balanceOf(newBeneficiary), uint256(profit), "profit routed to new beneficiary");
        assertEq(IERC20(VUSD).balanceOf(beneficiary), 0, "old beneficiary got nothing");
    }
}
