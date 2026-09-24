// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IVoterRegistry
/// @notice Minimal interface for eligibility checks used by the Voting contract.
interface IVoterRegistry {
    function isEligible(address voter) external view returns (bool);
}