// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @title SVusdArbitrage
/// @notice Non-atomic, VUSD-native sVUSD arbitrage with on-chain custody. Buy sVUSD below fair value
///         on a DEX with VUSD, redeem through the StakingVault's 7-day cooldown, and get VUSD back.
///         Profit is fixed and enforced at `openPosition`; at `settlePosition` the principal recycles
///         as reserves and realized profit is pushed to the beneficiary.
/// @dev Keeper-gated. Swaps are caller-supplied calldata confined to an owner allowlist, so a
///      compromised keeper cannot exfiltrate and can never move funds out. VUSD in, VUSD out.
contract SVusdArbitrage is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct SwapParams {
        address target; // contract to CALL (DEX router / aggregator)
        address approveTarget; // contract to APPROVE (may differ from target)
        bytes swapCalldata; // raw calldata from aggregator API or router
        uint256 minAmountOut; // min sVUSD shares out
    }

    struct Position {
        uint256 entryVusd; // VUSD cost basis
        uint256 lockedVusd; // VUSD payout locked at requestRedeem, re-checked at settle
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MAX_BPS = 10_000;

    /*//////////////////////////////////////////////////////////////
                             IMMUTABLE STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice sVUSD address
    IStakingVault public immutable svusd;
    /// @notice VUSD: the reserve currency and the payout token.
    IERC20 public immutable vusd;

    /*//////////////////////////////////////////////////////////////
                              MUTABLE STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Receives realized profit. Owner-set cold Safe.
    address public beneficiary;
    /// @notice DEX contracts the keeper may use as a swap `target` or `approveTarget`. Owner-curated;
    ///         a protected address (VUSD, sVUSD, or this contract) can never be added.
    mapping(address => bool) public allowedSwapAddress;
    /// @notice Minimum profit on `openPosition`, in bps of VUSD spent. 0 = off.
    uint256 public minProfitBps;

    mapping(uint256 => Position) private _positions;
    EnumerableSet.UintSet private _openRequests;
    EnumerableSet.AddressSet private _keepers;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event KeeperAdded(address indexed keeper);
    event KeeperRemoved(address indexed keeper);
    event BeneficiaryUpdated(address indexed previousBeneficiary, address indexed newBeneficiary);
    event AllowedSwapAddressUpdated(address indexed account, bool allowed);
    event MinProfitBpsUpdated(uint256 previousBps, uint256 newBps);
    event PositionOpened(
        uint256 indexed requestId, uint256 entryVusd, uint256 shares, uint256 lockedVusd, uint256 claimableAt
    );
    event PositionSettled(uint256 indexed requestId, uint256 entryVusd, uint256 vusdOut, int256 profit);
    event PositionCancelled(uint256 indexed requestId, uint256 sharesReturned);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotKeeper();
    error AddressIsZero();
    error ZeroAmount();
    error SwapAddressNotAllowed(address account);
    error ProtectedSwapAddress(address account);
    error InsufficientOutput(uint256 actual, uint256 minRequired);
    error NoSharesBought();
    error InsufficientProfit(uint256 lockedVusd, uint256 minRequired);
    error InvalidBps(uint256 bps);
    error UnknownRequest(uint256 requestId);
    error DuplicateRequest(uint256 requestId);
    error KeeperAlreadyAdded(address keeper);
    error KeeperNotFound(address keeper);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyKeeper() {
        if (!_keepers.contains(msg.sender)) revert NotKeeper();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address svusd_, address beneficiary_, address keeper_, address owner_) Ownable(owner_) {
        if (svusd_ == address(0) || beneficiary_ == address(0) || keeper_ == address(0)) revert AddressIsZero();

        svusd = IStakingVault(svusd_);
        vusd = IERC20(svusd.asset());

        beneficiary = beneficiary_;
        emit BeneficiaryUpdated(address(0), beneficiary_);

        _keepers.add(keeper_);
        emit KeeperAdded(keeper_);
    }

    /*//////////////////////////////////////////////////////////////
                              KEEPER ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Buy sVUSD with up to `vusdAmount_` of reserves via `buy_`, then request the cooldown redemption.
    /// @param vusdAmount_ Max VUSD made available to the swap (allowance ceiling).
    /// @param buy_ Pre-built VUSD -> sVUSD swap; `minAmountOut` is the min sVUSD shares.
    /// @param minProfit_ Keeper floor: min VUSD the locked payout must beat cost by.
    /// @return requestId Cooldown request id.
    /// @return lockedVusd VUSD locked for this request (the fixed claim payout).
    function openPosition(uint256 vusdAmount_, SwapParams calldata buy_, uint256 minProfit_)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 requestId, uint256 lockedVusd)
    {
        if (vusdAmount_ == 0) revert ZeroAmount();
        if (!allowedSwapAddress[buy_.target]) revert SwapAddressNotAllowed(buy_.target);
        if (!allowedSwapAddress[buy_.approveTarget]) revert SwapAddressNotAllowed(buy_.approveTarget);

        uint256 vusdBefore = vusd.balanceOf(address(this));
        uint256 svusdBefore = svusd.balanceOf(address(this));

        vusd.forceApprove(buy_.approveTarget, vusdAmount_);
        _executeSwap(buy_);
        vusd.forceApprove(buy_.approveTarget, 0);

        uint256 spent = vusdBefore - vusd.balanceOf(address(this));
        uint256 sharesBought = svusd.balanceOf(address(this)) - svusdBefore;
        if (spent == 0) revert ZeroAmount();
        if (sharesBought == 0) revert NoSharesBought();
        if (sharesBought < buy_.minAmountOut) revert InsufficientOutput(sharesBought, buy_.minAmountOut);

        (requestId, lockedVusd) = svusd.requestRedeem(sharesBought, address(this));

        // Both legs are VUSD and known here, so enforce the greater of the keeper floor and the
        // owner bps policy floor (rounded up); no losing position can be opened.
        uint256 bpsFloor = spent + Math.ceilDiv(spent * minProfitBps, MAX_BPS);
        uint256 floor = Math.max(spent + minProfit_, bpsFloor);
        if (lockedVusd < floor) revert InsufficientProfit(lockedVusd, floor);

        if (!_openRequests.add(requestId)) revert DuplicateRequest(requestId);
        _positions[requestId] = Position({entryVusd: spent, lockedVusd: lockedVusd});

        uint256 claimableAt = svusd.getRequestDetails(requestId).claimableAt;
        emit PositionOpened(requestId, spent, sharesBought, lockedVusd, claimableAt);
    }

    /// @notice Settle a matured request: principal recycles as reserves, profit goes to the beneficiary.
    /// @param requestId_ Tracked open position to settle.
    /// @param minVusdOut_ Extra floor on VUSD received; the settle is always held to at least the locked payout.
    /// @return profit Signed VUSD profit (vusdOut - entryVusd).
    function settlePosition(uint256 requestId_, uint256 minVusdOut_)
        external
        onlyKeeper
        nonReentrant
        returns (int256 profit)
    {
        if (!_openRequests.contains(requestId_)) revert UnknownRequest(requestId_);
        Position memory position = _positions[requestId_];

        // CEI: clear the position before the external call.
        _openRequests.remove(requestId_);
        delete _positions[requestId_];

        uint256 vusdBefore = vusd.balanceOf(address(this));
        svusd.claimWithdraw(requestId_, address(this));
        uint256 vusdOut = vusd.balanceOf(address(this)) - vusdBefore;

        // Always held to at least the locked payout. If the vault ever underpays,
        // settle reverts and the position is recovered via the owner's `cancelPosition`.
        uint256 floor = Math.max(minVusdOut_, position.lockedVusd);
        if (vusdOut < floor) revert InsufficientOutput(vusdOut, floor);

        profit = vusdOut.toInt256() - position.entryVusd.toInt256();
        emit PositionSettled(requestId_, position.entryVusd, vusdOut, profit);

        // Keep the principal as reserves; push profit to the beneficiary.
        if (profit > 0) {
            vusd.safeTransfer(beneficiary, profit.toUint256());
        }
    }

    /// @notice Cancel a pending request; the sVUSD shares return to this contract for the
    ///         owner to `sweep`.
    /// @param requestId_ Tracked open position to cancel.
    /// @return sharesReturned sVUSD shares returned by the vault.
    function cancelPosition(uint256 requestId_) external onlyOwner nonReentrant returns (uint256 sharesReturned) {
        if (!_openRequests.contains(requestId_)) revert UnknownRequest(requestId_);

        // CEI: clear the position before the external call.
        _openRequests.remove(requestId_);
        delete _positions[requestId_];

        sharesReturned = svusd.cancelWithdraw(requestId_);
        emit PositionCancelled(requestId_, sharesReturned);
    }

    /*//////////////////////////////////////////////////////////////
                                CUSTODY
    //////////////////////////////////////////////////////////////*/

    /// @notice Owner-only withdrawal of any token to any address (wind-down / stray-token rescue).
    ///         Routine profit exit is automatic at `settlePosition`, so the keeper needs no withdrawal power.
    function sweep(address token_, address to_, uint256 amount_) external onlyOwner nonReentrant {
        if (to_ == address(0)) revert AddressIsZero();
        IERC20(token_).safeTransfer(to_, amount_);
        emit Withdrawn(token_, to_, amount_);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function addKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert AddressIsZero();
        if (!_keepers.add(keeper_)) revert KeeperAlreadyAdded(keeper_);
        emit KeeperAdded(keeper_);
    }

    function removeKeeper(address keeper_) external onlyOwner {
        if (!_keepers.remove(keeper_)) revert KeeperNotFound(keeper_);
        emit KeeperRemoved(keeper_);
    }

    /// @notice Set the address that receives profit auto-pushed at `settlePosition`. A cold owner Safe.
    function setBeneficiary(address beneficiary_) external onlyOwner {
        if (beneficiary_ == address(0)) revert AddressIsZero();
        emit BeneficiaryUpdated(beneficiary, beneficiary_);
        beneficiary = beneficiary_;
    }

    /// @notice Allow or disallow a DEX contract as a swap `target` or `approveTarget`. Protected
    ///         addresses are rejected.
    function setAllowedSwapAddress(address account_, bool allowed_) external onlyOwner {
        if (account_ == address(0)) revert AddressIsZero();
        if (allowed_ && _isProtectedAddress(account_)) revert ProtectedSwapAddress(account_);
        allowedSwapAddress[account_] = allowed_;
        emit AllowedSwapAddressUpdated(account_, allowed_);
    }

    /// @notice Set the on-chain minimum profit for `openPosition`, in bps of VUSD spent. 0 disables it.
    function setMinProfitBps(uint256 minProfitBps_) external onlyOwner {
        if (minProfitBps_ > MAX_BPS) revert InvalidBps(minProfitBps_);
        emit MinProfitBpsUpdated(minProfitBps, minProfitBps_);
        minProfitBps = minProfitBps_;
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice All open request ids. Prefer `openRequestIdsPaged` once many positions can be open.
    function openRequestIds() external view returns (uint256[] memory) {
        return _openRequests.values();
    }

    /// @notice A page of open request ids: up to `limit_` from `offset_` (pass max for "all remaining").
    function openRequestIdsPaged(uint256 offset_, uint256 limit_) external view returns (uint256[] memory page) {
        uint256 total = _openRequests.length();
        if (offset_ >= total) return new uint256[](0);
        // offset_ < total is guaranteed above, so total - offset_ cannot underflow.
        uint256 end = limit_ > total - offset_ ? total : offset_ + limit_;
        page = new uint256[](end - offset_);
        for (uint256 i = offset_; i < end; ++i) {
            page[i - offset_] = _openRequests.at(i);
        }
    }

    function openRequestCount() external view returns (uint256) {
        return _openRequests.length();
    }

    /// @notice VUSD cost basis for an open request (0 if unknown/closed).
    function entryVusdOf(uint256 requestId_) external view returns (uint256) {
        return _positions[requestId_].entryVusd;
    }

    /// @notice VUSD payout locked for a request when opened (0 if unknown/closed).
    function lockedVusdOf(uint256 requestId_) external view returns (uint256) {
        return _positions[requestId_].lockedVusd;
    }

    function isKeeper(address account_) external view returns (bool) {
        return _keepers.contains(account_);
    }

    function getKeepers() external view returns (address[] memory) {
        return _keepers.values();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Addresses a swap must never touch: this contract, sVUSD (the vault), and VUSD.
    function _isProtectedAddress(address addr_) private view returns (bool) {
        return addr_ == address(this) || addr_ == address(svusd) || addr_ == address(vusd);
    }

    /// @dev Execute a pre-built DEX swap, bubbling up the raw revert on failure.
    function _executeSwap(SwapParams calldata params_) internal {
        (bool success, bytes memory result) = params_.target.call(params_.swapCalldata);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
