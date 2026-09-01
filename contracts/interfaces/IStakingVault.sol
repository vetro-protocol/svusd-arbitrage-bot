// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IStakingVault
interface IStakingVault is IERC20 {
    struct CooldownRequest {
        address owner;
        uint256 assets;
        uint256 claimableAt;
    }

    /// @notice Burn `shares_` and open a cooldown request; the VUSD `assets` are locked now.
    /// @dev No allowance is needed when `owner_ == msg.sender`.
    function requestRedeem(uint256 shares_, address owner_) external returns (uint256 requestId, uint256 assets);

    /// @notice Claim a matured request's assets. Reverts if the cooldown has not elapsed.
    function claimWithdraw(uint256 requestId_, address receiver_) external returns (uint256 assets);

    /// @notice Cancel a pending request; returns the burned shares to the owner.
    function cancelWithdraw(uint256 requestId_) external returns (uint256 shares);

    /// @notice Details of a request (owner, locked assets, claimable timestamp).
    function getRequestDetails(uint256 requestId_) external view returns (CooldownRequest memory request);

    /// @notice All open (unclaimed, uncancelled) request ids owned by `account_`.
    function getActiveRequestIds(address account_) external view returns (uint256[] memory);

    /// @notice Request ids owned by `account_` whose cooldown has elapsed, with their locked assets.
    function getClaimableRequests(address account_)
        external
        view
        returns (uint256[] memory requestIds_, uint256[] memory assets_);

    /// @notice The vault's underlying asset (VUSD), also the token `claimWithdraw` pays out.
    function asset() external view returns (address);
}
