// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Voter Registry
/// @notice Owner-controlled whitelist of eligible voters for the voting contract.
/// @dev The Voting contract reads eligibility via isEligible(). This registry is
///      the authoritative on-chain source of truth for voter eligibility.
contract VoterRegistry is Ownable {
    error InvalidAddress();
    error AlreadyEligible();

    mapping(address => bool) public isEligible;

    event VoterAdded(address indexed voter);
    event VoterRemoved(address indexed voter);

    /// @param initialOwner Address granted the onlyOwner admin role.
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Adds a voter to the eligibility whitelist.
    /// @param voter Address to mark eligible.
    /// @dev Reverts on zero address or duplicate registration.
    function addVoter(address voter) external onlyOwner {
        if (voter == address(0)) revert InvalidAddress();
        if (isEligible[voter]) revert AlreadyEligible();
        isEligible[voter] = true;
        emit VoterAdded(voter);
    }

    /// @notice Removes a voter from the eligibility whitelist.
    /// @param voter Address to mark ineligible.
    /// @dev Idempotent if the voter was not eligible.
    function removeVoter(address voter) external onlyOwner {
        if (voter == address(0)) revert InvalidAddress();
        isEligible[voter] = false;
        emit VoterRemoved(voter);
    }
}