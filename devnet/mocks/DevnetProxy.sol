// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.36;

/// @dev Pulls ERC1967Proxy into the devnet compilation unit. Upstream only ever names it from
///      script/Deploy.s.sol, which Hardhat does not compile, so without this import the proxy
///      the deploy recipe wraps both actors in has no artifact to deploy from. Nothing else
///      references this file -- the import is the whole point.
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
