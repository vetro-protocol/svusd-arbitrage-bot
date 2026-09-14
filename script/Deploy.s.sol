// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {SVusdArbitrage} from "../contracts/SVusdArbitrage.sol";

/// @notice Deploy SVusdArbitrage, set the profit floor as the temporary deployer-owner, then hand
///         ownership to OWNER via Ownable2Step. OWNER must call acceptOwnership() to finish the
///         handoff.
///
/// Post-deploy the contract holds zero reserves: fund it by transferring VUSD directly to the
/// deployed address (it custodies reserves; there is no deposit function). With MIN_PROFIT_BPS at
/// the default 30 (0.30%) the bot will not open until the spread clears that floor, so a quiet
/// keeper is expected, not stuck. Leave MIN_PROFIT_BPS > 0 in production: at 0 the profit guarantee
/// rests entirely on the keeper's per-call floor.
///
/// Env inputs:
///   BENEFICIARY     cold Safe that receives realized profit at settle
///   KEEPER          hot bot EOA (the keeper signer)
///   OWNER           governance Safe (final owner); if == deployer, ownership is kept
///   MIN_PROFIT_BPS  profit floor in bps (optional, default 30)
///
/// Run:
///   forge script script/Deploy.s.sol:Deploy --rpc-url "$ETHEREUM_RPC_URL" \
///     --private-key "$DEPLOYER_KEY" --broadcast --verify --etherscan-api-key "$KEY"
/// Fork dry-run: same command without --broadcast --verify.
contract Deploy is Script {
    // Mainnet ground truth (mirrors src/constants.ts).
    address constant SVUSD = 0x476310E34D2810f7d79C43A74E4D79405bd7a925;

    error OwnerIsZero();

    function run() external returns (SVusdArbitrage arb) {
        address beneficiary = vm.envAddress("BENEFICIARY");
        address keeper = vm.envAddress("KEEPER");
        address owner = vm.envAddress("OWNER");
        uint256 minProfitBps = vm.envOr("MIN_PROFIT_BPS", uint256(30));

        // A zero OWNER would make transferOwnership a no-op (Ownable2Step reads it as "clear pending"),
        // silently leaving the deployer as permanent owner. Fail loudly instead.
        if (owner == address(0)) revert OwnerIsZero();

        address deployer = msg.sender;
        bool handoff = owner != deployer;

        vm.startBroadcast();
        arb = new SVusdArbitrage(SVUSD, beneficiary, keeper, deployer);
        arb.setMinProfitBps(minProfitBps);
        // Skip a self-transfer, which would leave a dangling pending owner.
        if (handoff) arb.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("SVusdArbitrage :", address(arb));
        console.log("beneficiary    :", beneficiary);
        console.log("keeper         :", keeper);
        console.log("minProfitBps   :", minProfitBps);
        if (handoff) {
            console.log("pending owner  :", owner);
            console.log("(governance must call acceptOwnership to finish the handoff)");
        } else {
            console.log("owner          :", deployer, "(deployer retains ownership)");
        }
    }
}
